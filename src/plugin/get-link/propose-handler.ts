/**
 * GET …/propose — node property edits and base64url patch proposals.
 */

import type { Response } from 'express';

import type { FlowAdapter, FlowTab } from '../../runtime/types.js';
import type { AuditLog } from '../../storage/audit-log.js';
import type { ProposalStore } from '../../storage/proposals.js';
import {
  aiOpsErrorToHttp,
  conflictWarningFields,
  findConflictingProposals,
  submitReplaceFlowProposal,
} from '../ai-ops.js';
import { channelErrorHint } from '../channel-errors.js';
import type { NodeTypesAdapter } from '../node-types.js';
import {
  parseIncludeQuery,
  presentOptionsFor,
  presentProposalForApi,
} from '../proposal-present.js';
import { sendCaughtRouteError } from '../route-errors.js';
import type { AuthenticatedRequest } from '../types.js';

import {
  applyFlowNodeOps,
  buildPatchedFlowTab,
  collectSetProps,
  decodeBase64UrlJson,
  interpretPatch,
} from './flow-patch.js';
import { jsonError, rejectOversizedGetUrl, setNoStore } from './middleware.js';
import { queryString } from './query.js';

/** GET-link-only hints (URL-style). Shared codes come from mapErrorForChannel('get'). */
const GET_ONLY_ERROR_HINTS: Record<string, string> = {
  node_already_exists: 'Choose a new node id, or use op:set / op:remove on the existing node.',
  protected_property:
    'Omit id, type, and z from set props. wires are allowed when targets exist in the flow.',
  invalid_wires: 'wires must list existing node ids (or add those nodes in the same patch).',
  invalid_patch: 'Pass patch as base64url JSON with nodes[{op,….}] or type/flow for replace_flow.',
  invalid_patch_json:
    'Pass patch as base64url JSON with nodes[{op,….}] or type/flow for replace_flow.',
  missing_edits:
    'Provide set.<prop>=value, find+replace+field, or patch nodes with at least one op.',
  missing_node_id:
    'Pass node=<id> with set.<prop>= or find/replace, or include id on each patch.nodes entry.',
  missing_flow_id: 'Pass flow=<id> from GET …/flows.',
  missing_field: 'Pass field=<prop> (e.g. template, func) with find= and replace=.',
  missing_find: 'Pass a non-empty find= string (URL-encoded).',
  invalid_occurrence: 'occurrence must be a 1-based index within the match count.',
  invalid_replace:
    'Pass replace= as a string (URL-encoded; empty string is allowed to delete the find text).',
  conflicting_edits: 'Use either find/replace/field or set.<prop>=, not both in one propose URL.',
  invalid_node_type:
    'node.type must be a string (not a number or object). Use the palette type name exactly.',
  invalid_node: 'add op needs node as a JSON object: { id, type, … } — not a string or array.',
  z_mismatch: 'Each node.z must match the flow id (tab id) you are editing.',
  validation_failed: 'Fix every entry in errors[] and retry the propose/submit.',
};

function proposeErrorHint(code: string, cause?: unknown): string | undefined {
  return channelErrorHint(code, 'get', { cause }) ?? GET_ONLY_ERROR_HINTS[code];
}

function sendVersionMismatch(res: Response, expectedRev: string, currentRev: string): void {
  res.status(409).json({
    error: 'Flow revision mismatch',
    code: 'version_mismatch',
    expectedRev,
    currentRev,
    hint: proposeErrorHint('version_mismatch'),
  });
}

type BuiltPropose =
  | { ok: true; builtFlowId: string; builtFlow: FlowTab; expectedRev: string }
  | { ok: false; kind: 'version_mismatch'; expectedRev: string; currentRev: string };

async function buildFromPatch(
  flowAdapter: FlowAdapter,
  patchEncoded: string,
  flowId: string | undefined,
  rev: string,
  nodeTypesAdapter?: NodeTypesAdapter
): Promise<BuiltPropose> {
  const interpreted = interpretPatch(decodeBase64UrlJson(patchEncoded), flowId);
  const builtFlowId = interpreted.flowId;
  if (interpreted.kind === 'replace_flow') {
    return {
      ok: true,
      builtFlowId,
      builtFlow: {
        ...interpreted.flow,
        id: interpreted.flow.id || builtFlowId,
        type: interpreted.flow.type ?? 'tab',
        nodes: interpreted.flow.nodes ?? [],
      },
      expectedRev: rev,
    };
  }
  const patched = await applyFlowNodeOps(flowAdapter, builtFlowId, interpreted.ops, {
    expectedRev: rev,
    ...(nodeTypesAdapter ? { nodeTypes: nodeTypesAdapter } : {}),
  });
  if (patched.expectedRev !== rev) {
    return {
      ok: false,
      kind: 'version_mismatch',
      expectedRev: rev,
      currentRev: patched.expectedRev,
    };
  }
  return {
    ok: true,
    builtFlowId,
    builtFlow: patched.flow,
    expectedRev: patched.expectedRev,
  };
}

async function buildFromSetProps(
  flowAdapter: FlowAdapter,
  flowId: string,
  nodeId: string,
  setProps: Record<string, string>,
  rev: string
): Promise<BuiltPropose> {
  const patched = await buildPatchedFlowTab(flowAdapter, flowId, [{ nodeId, set: setProps }]);
  if (patched.expectedRev !== rev) {
    return {
      ok: false,
      kind: 'version_mismatch',
      expectedRev: rev,
      currentRev: patched.expectedRev,
    };
  }
  return {
    ok: true,
    builtFlowId: flowId,
    builtFlow: patched.flow,
    expectedRev: patched.expectedRev,
  };
}

async function buildFromReplaceText(
  flowAdapter: FlowAdapter,
  flowId: string,
  nodeId: string,
  field: string,
  find: string,
  replace: string,
  occurrence: number | undefined,
  rev: string
): Promise<BuiltPropose> {
  const patched = await applyFlowNodeOps(flowAdapter, flowId, [
    {
      op: 'replace_text',
      nodeId,
      field,
      find,
      replace,
      ...(occurrence !== undefined ? { occurrence } : {}),
    },
  ]);
  if (patched.expectedRev !== rev) {
    return {
      ok: false,
      kind: 'version_mismatch',
      expectedRev: rev,
      currentRev: patched.expectedRev,
    };
  }
  return {
    ok: true,
    builtFlowId: flowId,
    builtFlow: patched.flow,
    expectedRev: patched.expectedRev,
  };
}

interface ProposeQuery {
  flowId: string | undefined;
  rev: string | undefined;
  nodeId: string | undefined;
  patchEncoded: string | undefined;
  setProps: Record<string, string>;
  findText: string | undefined;
  replaceText: string | undefined;
  fieldName: string | undefined;
  occurrenceRaw: string | undefined;
}

function readProposeQuery(req: AuthenticatedRequest): ProposeQuery {
  const replacePresent = Object.prototype.hasOwnProperty.call(req.query, 'replace');
  return {
    flowId: queryString(req.query, 'flow'),
    rev: queryString(req.query, 'rev'),
    nodeId: queryString(req.query, 'node'),
    patchEncoded: queryString(req.query, 'patch'),
    setProps: collectSetProps(req.query),
    findText: queryString(req.query, 'find'),
    replaceText: replacePresent ? (queryString(req.query, 'replace') ?? '') : undefined,
    fieldName: queryString(req.query, 'field'),
    occurrenceRaw: queryString(req.query, 'occurrence'),
  };
}

function jsonProposeError(res: Response, code: string, error: string): void {
  jsonError(res, 400, error, code, proposeErrorHint(code));
}

function parseOccurrenceQuery(
  res: Response,
  raw: string | undefined
): { ok: true; occurrence?: number } | { ok: false } {
  if (raw === undefined || raw === '') {
    return { ok: true };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    jsonProposeError(res, 'invalid_occurrence', 'occurrence must be a positive integer');
    return { ok: false };
  }
  return { ok: true, occurrence: Math.trunc(n) };
}

async function buildProposeFromQuery(
  res: Response,
  flowAdapter: FlowAdapter,
  q: ProposeQuery,
  rev: string,
  nodeTypesAdapter?: NodeTypesAdapter
): Promise<BuiltPropose | null> {
  if (q.patchEncoded) {
    return buildFromPatch(flowAdapter, q.patchEncoded, q.flowId, rev, nodeTypesAdapter);
  }

  const wantsReplaceText =
    q.findText !== undefined || q.replaceText !== undefined || q.fieldName !== undefined;

  if (wantsReplaceText) {
    if (Object.keys(q.setProps).length > 0) {
      jsonProposeError(
        res,
        'conflicting_edits',
        'Cannot combine replace_text (find/replace/field) with set.<prop> in one request'
      );
      return null;
    }
    if (!q.flowId) {
      jsonProposeError(res, 'missing_flow_id', 'flow query parameter is required');
      return null;
    }
    if (!q.nodeId) {
      jsonProposeError(res, 'missing_node_id', 'node query parameter is required');
      return null;
    }
    if (!q.fieldName) {
      jsonProposeError(res, 'missing_field', 'field query parameter is required for replace_text');
      return null;
    }
    if (q.findText === undefined || q.findText.length === 0) {
      jsonProposeError(res, 'missing_find', 'find query parameter must be a non-empty string');
      return null;
    }
    if (q.replaceText === undefined) {
      jsonProposeError(
        res,
        'invalid_replace',
        'replace query parameter is required (may be empty)'
      );
      return null;
    }
    const occ = parseOccurrenceQuery(res, q.occurrenceRaw);
    if (!occ.ok) {
      return null;
    }
    return buildFromReplaceText(
      flowAdapter,
      q.flowId,
      q.nodeId,
      q.fieldName,
      q.findText,
      q.replaceText,
      occ.occurrence,
      rev
    );
  }

  if (!q.flowId) {
    jsonProposeError(res, 'missing_flow_id', 'flow query parameter is required');
    return null;
  }
  if (!q.nodeId) {
    jsonProposeError(res, 'missing_node_id', 'node query parameter is required (or pass patch=)');
    return null;
  }
  if (Object.keys(q.setProps).length === 0) {
    jsonProposeError(res, 'missing_edits', 'At least one set.<prop>=value is required');
    return null;
  }
  return buildFromSetProps(flowAdapter, q.flowId, q.nodeId, q.setProps, rev);
}

export function getLinkProposeHandler(
  proposalStore: ProposalStore,
  auditLog: AuditLog,
  flowAdapter: FlowAdapter,
  httpAdminRoot?: string,
  nodeTypesAdapter?: NodeTypesAdapter
) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (rejectOversizedGetUrl(req, res)) {
      return;
    }
    setNoStore(res);

    const q = readProposeQuery(req);
    const summary = queryString(req.query, 'summary');
    const titleParam = queryString(req.query, 'title') ?? summary;

    if (!q.rev) {
      jsonProposeError(res, 'missing_expected_rev', 'rev query parameter is required');
      return;
    }
    if (!req.accessLink) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }

    try {
      const built = await buildProposeFromQuery(res, flowAdapter, q, q.rev, nodeTypesAdapter);
      if (!built) {
        return;
      }
      if (!built.ok) {
        sendVersionMismatch(res, built.expectedRev, built.currentRev);
        return;
      }

      const presentOpts = presentOptionsFor(req, httpAdminRoot);
      const include = parseIncludeQuery(req.query.include);
      const proposal = await submitReplaceFlowProposal(
        proposalStore,
        auditLog,
        req.accessLink,
        {
          type: 'replace_flow',
          expectedRev: built.expectedRev,
          payload: { flowId: built.builtFlowId, flow: built.builtFlow },
          ...(titleParam ? { title: titleParam } : {}),
        },
        flowAdapter,
        presentOpts,
        nodeTypesAdapter
      );
      const presented = {
        ...presentProposalForApi(proposal, { ...presentOpts, include }),
        mine: true,
      };
      const conflicts = findConflictingProposals(
        proposalStore,
        proposalStore.get(proposal.id),
        req.accessLink.id
      );
      const warnings = proposal.warnings;
      res.status(201).json({
        ok: true,
        proposal: presented,
        ...(summary ? { summary } : {}),
        ...conflictWarningFields(conflicts),
        ...(warnings && warnings.length > 0 ? { warnings } : {}),
        hint:
          `Waiting for human approval. Tell the user about "${presented.displayName}" ` +
          `(${presented.reviewUrl}). Poll GET …/proposals/<id> for status.${
            warnings && warnings.length > 0
              ? ` Soft warnings (${warnings.length}) are non-blocking — configure later if needed.`
              : ''
          }`,
      });
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error, 'get');
      if (mapped) {
        const hint = proposeErrorHint(mapped.body.code, mapped.body.cause);
        res.status(mapped.statusCode).json({
          ...mapped.body,
          ...(hint ? { hint } : {}),
        });
        return;
      }
      sendCaughtRouteError(res, error);
    }
  };
}
