/**
 * GET …/propose — node property edits and base64url patch proposals.
 */

import type { Response } from 'express';

import type { FlowAdapter, FlowTab } from '../../runtime/types.js';
import type { AuditLog } from '../../storage/audit-log.js';
import type { ProposalStore } from '../../storage/proposals.js';
import { aiOpsErrorToHttp, submitReplaceFlowProposal } from '../ai-ops.js';
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
      return 'Omit id, type, z, and wires from set props (use op:add for new nodes).';
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

export function getLinkProposeHandler(
  proposalStore: ProposalStore,
  auditLog: AuditLog,
  flowAdapter: FlowAdapter
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
      let builtFlowId: string;
      let builtFlow: FlowTab;
      let expectedRev = rev;

      if (patchEncoded) {
        const interpreted = interpretPatch(decodeBase64UrlJson(patchEncoded), flowId);
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
          if (patched.expectedRev !== rev) {
            res.status(409).json({
              error: 'Flow revision mismatch',
              code: 'version_mismatch',
              expectedRev: rev,
              currentRev: patched.expectedRev,
              hint: proposeErrorHint('version_mismatch'),
            });
            return;
          }
          builtFlow = patched.flow;
          expectedRev = patched.expectedRev;
        }
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
        const patched = await buildPatchedFlowTab(flowAdapter, flowId, [{ nodeId, set: setProps }]);
        if (patched.expectedRev !== rev) {
          res.status(409).json({
            error: 'Flow revision mismatch',
            code: 'version_mismatch',
            expectedRev: rev,
            currentRev: patched.expectedRev,
            hint: proposeErrorHint('version_mismatch'),
          });
          return;
        }
        builtFlowId = flowId;
        builtFlow = patched.flow;
        expectedRev = patched.expectedRev;
      }

      const proposal = await submitReplaceFlowProposal(
        proposalStore,
        auditLog,
        req.accessLink,
        {
          type: 'replace_flow',
          expectedRev,
          payload: { flowId: builtFlowId, flow: builtFlow },
          ...(titleParam ? { title: titleParam } : {}),
        },
        flowAdapter
      );
      res.status(201).json({
        ok: true,
        proposal,
        ...(summary ? { summary } : {}),
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
