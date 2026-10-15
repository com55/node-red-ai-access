/**
 * Chunked draft handlers for GET access links.
 */

import { createHash } from 'node:crypto';

import type { Response } from 'express';

import type { FlowAdapter, FlowNode, FlowTab } from '../../runtime/types.js';
import type { AuditLog } from '../../storage/audit-log.js';
import type { ProposalStore } from '../../storage/proposals.js';
import { MAX_PROPOSAL_JSON_BYTES } from '../../storage/trusted-write.js';
import { aiOpsErrorToHttp, siblingsOnSameRev, submitReplaceFlowProposal } from '../ai-ops.js';
import type { AuthenticatedRequest } from '../types.js';

import {
  DraftAlreadySubmittedError,
  DraftNotFoundError,
  DraftStore,
  DraftValidationError,
} from './draft-store.js';
import {
  applyFlowNodeOps,
  buildPatchedFlowTab,
  decodeBase64UrlJson,
  interpretPatch,
} from './flow-patch.js';
import { jsonError, rejectOversizedGetUrl, setNoStore } from './middleware.js';
import { queryString } from './query.js';

function draftErrorHint(code: string): string | undefined {
  switch (code) {
    case 'draft_not_found':
      return 'Start a new draft with GET …/draft/new.';
    case 'draft_already_submitted':
      return 'This draft already created a proposal; poll that proposal or start a new draft.';
    case 'chunk_conflict':
      return 'Re-send the same data for that seq, or start a new draft.';
    case 'payload_too_large':
      return 'Shrink the content; totalBytes counts decoded bytes against maxBytes.';
    case 'invalid_seq':
      return 'seq must be a non-negative integer (0, 1, 2, …).';
    case 'invalid_chunk':
    case 'invalid_chunk_data':
      return 'data must be base64url of the raw chunk bytes (A-Z, a-z, 0-9, -, _).';
    case 'missing_chunks':
      return 'Upload every seq from 0 through max before submit.';
    case 'invalid_sha256':
      return 'sha256 must be exactly 64 hexadecimal characters.';
    case 'draft_hash_mismatch':
      return 'sha256 must be the hex digest of the assembled UTF-8 bytes (before base64url).';
    case 'draft_empty':
      return 'Append at least one chunk before submit.';
    case 'node_not_found':
      return 'Call GET …/flows/<id> and use a node id from that response (or use mode=json with op:add).';
    case 'field_not_found':
      return 'Use a property that exists on the node, or mode=json to add/replace nodes.';
    case 'missing_draft_params':
      return 'Example: …/draft/new?flow=tab1&rev=abc&node=n1&field=template';
    case 'version_mismatch':
      return 'Re-read the flow and start a new draft with the current rev.';
    case 'protected_property':
      return 'Omit id, type, and z from set props. wires are allowed when targets exist in the flow.';
    case 'invalid_wires':
      return 'wires must list existing node ids (or add those nodes in the same patch).';
    default:
      return undefined;
  }
}

/**
 * Validate field-mode targets against the live flow so callers fail before
 * uploading chunks. Skipped for mode=json (document may add/remove nodes).
 */
async function validateFieldDraftTargets(
  flowAdapter: FlowAdapter,
  flowId: string,
  targets: { nodeId: string; field: string }[]
): Promise<{ code: string; message: string } | null> {
  let snapshot: { rev: string; flow: Partial<FlowTab> };
  try {
    snapshot = await flowAdapter.getFlow(flowId);
  } catch (error) {
    const mapped = aiOpsErrorToHttp(error);
    if (mapped) {
      return { code: mapped.body.code, message: mapped.body.error };
    }
    throw error;
  }
  const nodes: FlowNode[] = [
    ...(Array.isArray(snapshot.flow.nodes) ? snapshot.flow.nodes : []),
    ...(Array.isArray(snapshot.flow.configs) ? snapshot.flow.configs : []),
  ];
  for (const t of targets) {
    const node = nodes.find(n => n.id === t.nodeId);
    if (!node) {
      return {
        code: 'node_not_found',
        message: `Node '${t.nodeId}' was not found in flow '${flowId}'`,
      };
    }
    if (!(t.field in node)) {
      return {
        code: 'field_not_found',
        message: `Field '${t.field}' was not found on node '${t.nodeId}'`,
      };
    }
  }
  return null;
}

type DraftModePlan =
  | { ok: true; mode: 'field' | 'json'; targets?: { nodeId: string; field: string }[] }
  | { ok: false; status: number; error: string; code: string; hint?: string };

function planDraftMode(
  nodeId: string | undefined,
  field: string | undefined,
  modeParam: string | undefined,
  targetsEncoded: string | undefined
): DraftModePlan {
  if (targetsEncoded) {
    try {
      const parsed = decodeBase64UrlJson(targetsEncoded);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('targets must be a non-empty array');
      }
      const targets = parsed.map(entry => {
        if (!entry || typeof entry !== 'object') {
          throw new Error('bad target');
        }
        const t = entry as { node?: unknown; nodeId?: unknown; field?: unknown };
        const n =
          typeof t.nodeId === 'string' ? t.nodeId : typeof t.node === 'string' ? t.node : '';
        const f = typeof t.field === 'string' ? t.field : '';
        if (!n || !f) throw new Error('bad target');
        return { nodeId: n, field: f };
      });
      return { ok: true, mode: 'field', targets };
    } catch {
      return {
        ok: false,
        status: 400,
        error: 'targets must be base64url JSON array of {nodeId,field}',
        code: 'invalid_targets',
      };
    }
  }
  if (modeParam === 'json' || (!nodeId && !field)) {
    return { ok: true, mode: 'json' };
  }
  if (!nodeId || !field) {
    const hint = draftErrorHint('missing_draft_params');
    return {
      ok: false,
      status: 400,
      error: 'node and field are required for field drafts (or pass mode=json)',
      code: 'missing_draft_params',
      ...(hint ? { hint } : {}),
    };
  }
  return { ok: true, mode: 'field' };
}

async function rejectInvalidFieldTargets(
  res: Response,
  flowAdapter: FlowAdapter,
  flowId: string,
  targets: { nodeId: string; field: string }[]
): Promise<boolean> {
  try {
    const invalid = await validateFieldDraftTargets(flowAdapter, flowId, targets);
    if (invalid) {
      jsonError(res, 400, invalid.message, invalid.code, draftErrorHint(invalid.code));
      return true;
    }
  } catch (error) {
    const mapped = aiOpsErrorToHttp(error);
    if (mapped) {
      jsonError(
        res,
        mapped.statusCode,
        mapped.body.error,
        mapped.body.code,
        draftErrorHint(mapped.body.code)
      );
      return true;
    }
    throw error;
  }
  return false;
}

export function getLinkDraftNewHandler(draftStore: DraftStore, flowAdapter: FlowAdapter) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (rejectOversizedGetUrl(req, res)) return;
    setNoStore(res);

    const flowId = queryString(req.query, 'flow');
    const rev = queryString(req.query, 'rev');
    const nodeId = queryString(req.query, 'node');
    const field = queryString(req.query, 'field');
    const summary = queryString(req.query, 'summary');
    const titleParam = queryString(req.query, 'title') ?? summary;
    const modeParam = queryString(req.query, 'mode');
    const targetsEncoded = queryString(req.query, 'targets');

    if (!flowId || !rev) {
      jsonError(
        res,
        400,
        'flow and rev query parameters are required',
        'missing_draft_params',
        draftErrorHint('missing_draft_params')
      );
      return;
    }
    if (!req.accessLink) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }

    // Fail fast when the client’s rev is already stale.
    try {
      const live = await flowAdapter.getFlow(flowId);
      if (live.rev !== rev) {
        res.status(409).json({
          error: 'Flow revision mismatch',
          code: 'version_mismatch',
          expectedRev: rev,
          currentRev: live.rev,
          hint: draftErrorHint('version_mismatch'),
        });
        return;
      }
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        jsonError(
          res,
          mapped.statusCode,
          mapped.body.error,
          mapped.body.code,
          mapped.body.code === 'flow_not_found'
            ? 'Use an id from GET ./flows'
            : draftErrorHint(mapped.body.code)
        );
        return;
      }
      throw error;
    }

    const plan = planDraftMode(nodeId, field, modeParam, targetsEncoded);
    if (!plan.ok) {
      jsonError(res, plan.status, plan.error, plan.code, plan.hint);
      return;
    }

    // Field drafts: validate node/field exist before upload.
    // mode=json may add/remove nodes via nodes[{op:'add'|'remove'|'set',...}].
    if (plan.mode === 'field') {
      const checkTargets =
        plan.targets && plan.targets.length > 0
          ? plan.targets
          : nodeId && field
            ? [{ nodeId, field }]
            : [];
      if (
        checkTargets.length > 0 &&
        (await rejectInvalidFieldTargets(res, flowAdapter, flowId, checkTargets))
      ) {
        return;
      }
    }

    const draft = draftStore.create({
      linkId: req.accessLink.id,
      flowId,
      expectedRev: rev,
      mode: plan.mode,
      ...(nodeId ? { nodeId } : {}),
      ...(field ? { field } : {}),
      ...(plan.targets ? { targets: plan.targets } : {}),
      ...(summary ? { summary } : {}),
      ...(titleParam ? { title: titleParam } : {}),
    });

    res.status(201).json({
      ok: true,
      draftId: draft.id,
      mode: draft.mode,
      expiresAt: new Date(draft.expiresAtMs).toISOString(),
      maxBytes: MAX_PROPOSAL_JSON_BYTES,
      hint:
        'Upload base64url chunks (~4–5 KB raw each; base64 adds ~33%; keep URL under ~8 KB) ' +
        'with GET …/draft/<draftId>/append?seq=N&data=… then submit with sha256.',
    });
  };
}

export function getLinkDraftAppendHandler(draftStore: DraftStore) {
  return (req: AuthenticatedRequest, res: Response): void => {
    if (rejectOversizedGetUrl(req, res)) return;
    setNoStore(res);
    const draftId = req.params.draftId;
    const seqRaw = queryString(req.query, 'seq');
    const data = queryString(req.query, 'data');
    if (typeof draftId !== 'string' || !draftId) {
      jsonError(res, 400, 'Missing draft id', 'missing_draft_id');
      return;
    }
    if (!req.accessLink) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }
    if (seqRaw === undefined || data === undefined) {
      jsonError(
        res,
        400,
        'seq and data query parameters are required',
        'missing_chunk_params',
        'data must be base64url of the raw chunk bytes.'
      );
      return;
    }
    const seq = Number(seqRaw);
    try {
      const result = draftStore.append(draftId, req.accessLink.id, seq, data);
      res.json({
        ok: true,
        draftId,
        receivedSeqs: result.receivedSeqs,
        missingSeqs: result.missingSeqs,
        totalBytes: result.totalBytes,
        maxBytes: result.maxBytes,
        hint:
          result.missingSeqs.length === 0
            ? 'No gaps so far; call submit when all chunks are uploaded'
            : `Upload missing seqs: ${result.missingSeqs.join(',')}`,
      });
    } catch (error) {
      if (
        error instanceof DraftNotFoundError ||
        error instanceof DraftAlreadySubmittedError ||
        error instanceof DraftValidationError
      ) {
        jsonError(
          res,
          error.statusCode,
          error.message,
          error.code,
          draftErrorHint(error.code),
          error instanceof DraftAlreadySubmittedError ? { proposalId: error.proposalId } : undefined
        );
        return;
      }
      throw error;
    }
  };
}

function editsFromFieldDraft(
  draft: {
    nodeId?: string;
    field?: string;
    targets?: { nodeId: string; field: string }[];
  },
  assembled: string
): { nodeId: string; set: Record<string, unknown> }[] {
  const edits: { nodeId: string; set: Record<string, unknown> }[] = [];
  if (draft.targets && draft.targets.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(assembled);
    } catch {
      const only = draft.targets[0];
      if (draft.targets.length === 1 && only) {
        return [{ nodeId: only.nodeId, set: { [only.field]: assembled } }];
      }
      throw new DraftValidationError('Multi-target draft body must be JSON', 'invalid_draft_body');
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const e = entry as { nodeId?: string; field?: string; value?: unknown };
        if (!e.nodeId || !e.field) {
          throw new DraftValidationError('Invalid multi-target entry', 'invalid_draft_body');
        }
        edits.push({ nodeId: e.nodeId, set: { [e.field]: e.value } });
      }
      return edits;
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const t of draft.targets) {
        const key = `${t.nodeId}.${t.field}`;
        if (!(key in obj) && !(t.field in obj)) {
          throw new DraftValidationError(
            `Missing value for ${key} in draft JSON`,
            'invalid_draft_body'
          );
        }
        edits.push({
          nodeId: t.nodeId,
          set: { [t.field]: key in obj ? obj[key] : obj[t.field] },
        });
      }
      return edits;
    }
    throw new DraftValidationError('Invalid multi-target draft JSON', 'invalid_draft_body');
  }
  if (draft.nodeId && draft.field) {
    return [{ nodeId: draft.nodeId, set: { [draft.field]: assembled } }];
  }
  throw new DraftValidationError('Field draft missing node/field', 'invalid_draft');
}

export function getLinkDraftSubmitHandler(
  draftStore: DraftStore,
  proposalStore: ProposalStore,
  auditLog: AuditLog,
  flowAdapter: FlowAdapter
) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (rejectOversizedGetUrl(req, res)) return;
    setNoStore(res);
    const draftId = req.params.draftId;
    const sha256 = queryString(req.query, 'sha256');
    const titleOverride = queryString(req.query, 'title');
    if (typeof draftId !== 'string' || !draftId) {
      jsonError(res, 400, 'Missing draft id', 'missing_draft_id');
      return;
    }
    if (!req.accessLink) {
      jsonError(res, 401, 'Access link required', 'access_link_missing');
      return;
    }
    if (!sha256) {
      jsonError(
        res,
        400,
        'sha256 query parameter is required',
        'missing_sha256',
        'Pass sha256 hex of the assembled UTF-8 bytes (before base64url).'
      );
      return;
    }

    try {
      const { draft, assembled } = draftStore.assembleAndVerify(draftId, req.accessLink.id, sha256);

      let builtFlowId = draft.flowId;
      let builtFlow: FlowTab;
      let expectedRev = draft.expectedRev;

      if (draft.mode === 'field') {
        const edits = editsFromFieldDraft(draft, assembled);
        const patched = await buildPatchedFlowTab(flowAdapter, draft.flowId, edits);
        if (patched.expectedRev !== draft.expectedRev) {
          // Draft is retained (assemble no longer deletes); tell the client clearly.
          res.status(409).json({
            error: 'Flow revision mismatch',
            code: 'version_mismatch',
            expectedRev: draft.expectedRev,
            currentRev: patched.expectedRev,
            draftDeleted: false,
            hint: 'Draft was kept. Re-read the flow and start a new draft with the current rev (or retry if you refresh rev).',
          });
          return;
        }
        builtFlow = patched.flow;
        expectedRev = patched.expectedRev;
      } else {
        const interpreted = interpretPatch(JSON.parse(assembled) as unknown, draft.flowId);
        builtFlowId = interpreted.flowId;
        if (interpreted.kind === 'replace_flow') {
          builtFlow = {
            ...interpreted.flow,
            id: interpreted.flow.id || builtFlowId,
            type: interpreted.flow.type ?? 'tab',
            nodes: interpreted.flow.nodes ?? [],
          };
        } else {
          const patched = await applyFlowNodeOps(flowAdapter, builtFlowId, interpreted.ops);
          if (patched.expectedRev !== draft.expectedRev) {
            res.status(409).json({
              error: 'Flow revision mismatch',
              code: 'version_mismatch',
              expectedRev: draft.expectedRev,
              currentRev: patched.expectedRev,
              draftDeleted: false,
              hint: 'Draft was kept. Re-read the flow and start a new draft with the current rev.',
            });
            return;
          }
          builtFlow = patched.flow;
          expectedRev = patched.expectedRev;
        }
      }

      const title = titleOverride ?? draft.title ?? draft.summary;
      const proposal = await submitReplaceFlowProposal(
        proposalStore,
        auditLog,
        req.accessLink,
        {
          type: 'replace_flow',
          expectedRev,
          payload: { flowId: builtFlowId, flow: builtFlow },
          ...(title ? { title } : {}),
        },
        flowAdapter
      );

      draftStore.markSubmitted(draftId, req.accessLink.id, proposal.id);
      const siblings = siblingsOnSameRev(proposalStore, proposal);

      res.status(201).json({
        ok: true,
        proposal,
        sha256: createHash('sha256').update(Buffer.from(assembled, 'utf8')).digest('hex'),
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
      if (error instanceof DraftAlreadySubmittedError) {
        jsonError(res, error.statusCode, error.message, error.code, draftErrorHint(error.code), {
          proposalId: error.proposalId,
        });
        return;
      }
      if (error instanceof DraftNotFoundError || error instanceof DraftValidationError) {
        jsonError(res, error.statusCode, error.message, error.code, draftErrorHint(error.code));
        return;
      }
      if (error instanceof SyntaxError) {
        jsonError(res, 400, 'Assembled draft is not valid JSON', 'invalid_draft_body');
        return;
      }
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json({
          ...mapped.body,
          ...(draftErrorHint(mapped.body.code) ? { hint: draftErrorHint(mapped.body.code) } : {}),
        });
        return;
      }
      throw error;
    }
  };
}
