/**
 * GET …/propose — node property edits and base64url patch proposals.
 */

import type { Response } from 'express';

import type { FlowAdapter, FlowTab } from '../../runtime/types.js';
import type { AuditLog } from '../../storage/audit-log.js';
import type { ProposalStore } from '../../storage/proposals.js';
import { aiOpsErrorToHttp, siblingsOnSameRev, submitReplaceFlowProposal } from '../ai-ops.js';
import { presentOptionsFor } from '../proposal-present.js';
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

function proposeErrorHint(code: string): string | undefined {
  switch (code) {
    case 'version_mismatch':
      return 'Re-read the flow and retry with the current rev.';
    case 'node_not_found':
      return 'Call GET …/flows/<id> and use a node id from that response.';
    case 'node_already_exists':
      return 'Choose a new node id, or use op:set / op:remove on the existing node.';
    case 'flow_not_found':
      return 'Call GET …/flows to list valid ids.';
    case 'protected_property':
      return 'Omit id, type, and z from set props. wires are allowed when targets exist in the flow.';
    case 'invalid_wires':
      return 'wires must list existing node ids (or add those nodes in the same patch).';
    case 'invalid_patch':
    case 'invalid_patch_json':
      return 'Pass patch as base64url JSON with nodes[{op,….}] or type/flow for replace_flow.';
    case 'missing_edits':
      return 'Provide set.<prop>=value, or patch nodes with at least one op.';
    case 'missing_node_id':
      return 'Pass node=<id> with set.<prop>=, or include id on each patch.nodes entry.';
    case 'missing_flow_id':
      return 'Pass flow=<id> from GET …/flows.';
    case 'missing_expected_rev':
      return 'Pass rev from GET …/flows or …/flows/<id>.';
    default:
      return undefined;
  }
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
  rev: string
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
  const patched = await applyFlowNodeOps(flowAdapter, builtFlowId, interpreted.ops);
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

export function getLinkProposeHandler(
  proposalStore: ProposalStore,
  auditLog: AuditLog,
  flowAdapter: FlowAdapter,
  httpAdminRoot?: string
) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (rejectOversizedGetUrl(req, res)) {
      return;
    }
    setNoStore(res);

    const flowId = queryString(req.query, 'flow');
    const rev = queryString(req.query, 'rev');
    const nodeId = queryString(req.query, 'node');
    const summary = queryString(req.query, 'summary');
    const titleParam = queryString(req.query, 'title') ?? summary;
    const patchEncoded = queryString(req.query, 'patch');
    const setProps = collectSetProps(req.query);

    if (!rev) {
      jsonError(
        res,
        400,
        'rev query parameter is required',
        'missing_expected_rev',
        proposeErrorHint('missing_expected_rev')
      );
      return;
    }
    if (!req.accessLink) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }

    try {
      let built: BuiltPropose;
      if (patchEncoded) {
        built = await buildFromPatch(flowAdapter, patchEncoded, flowId, rev);
      } else {
        if (!flowId) {
          jsonError(
            res,
            400,
            'flow query parameter is required',
            'missing_flow_id',
            proposeErrorHint('missing_flow_id')
          );
          return;
        }
        if (!nodeId) {
          jsonError(
            res,
            400,
            'node query parameter is required (or pass patch=)',
            'missing_node_id',
            proposeErrorHint('missing_node_id')
          );
          return;
        }
        if (Object.keys(setProps).length === 0) {
          jsonError(
            res,
            400,
            'At least one set.<prop>=value is required',
            'missing_edits',
            proposeErrorHint('missing_edits')
          );
          return;
        }
        built = await buildFromSetProps(flowAdapter, flowId, nodeId, setProps, rev);
      }

      if (!built.ok) {
        sendVersionMismatch(res, built.expectedRev, built.currentRev);
        return;
      }

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
        presentOptionsFor(req, httpAdminRoot)
      );
      const siblings = siblingsOnSameRev(proposalStore, proposal);
      res.status(201).json({
        ok: true,
        proposal,
        ...(summary ? { summary } : {}),
        ...(siblings.length > 0
          ? {
              siblingsOnSameRev: siblings,
              warning:
                'Other pending proposals share this flow revision — approve order may conflict.',
            }
          : {}),
        hint:
          `Waiting for human approval. Tell the user about "${proposal.displayName}" ` +
          `(${proposal.reviewUrl}). Poll GET …/proposals/<id> for status.`,
      });
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        const hint = proposeErrorHint(mapped.body.code);
        res.status(mapped.statusCode).json({
          ...mapped.body,
          ...(hint ? { hint } : {}),
        });
        return;
      }
      throw error;
    }
  };
}
