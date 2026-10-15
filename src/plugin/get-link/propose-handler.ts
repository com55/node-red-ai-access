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
  buildPatchedFlowTab,
  collectSetProps,
  decodeBase64UrlJson,
  interpretPatch,
} from './flow-patch.js';
import { jsonError, rejectOversizedGetUrl, setNoStore } from './middleware.js';
import { queryString } from './query.js';

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
    const patchEncoded = queryString(req.query, 'patch');
    const setProps = collectSetProps(req.query);

    if (!rev) {
      jsonError(
        res,
        400,
        'rev query parameter is required',
        'missing_expected_rev',
        'Pass rev from GET …/flows or …/flows/<id>.'
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
        if (interpreted.kind === 'replace_flow' && interpreted.flow) {
          builtFlow = {
            ...interpreted.flow,
            id: interpreted.flow.id ?? builtFlowId,
            type: interpreted.flow.type ?? 'tab',
            nodes: interpreted.flow.nodes ?? [],
          };
        } else {
          const patched = await buildPatchedFlowTab(
            flowAdapter,
            builtFlowId,
            interpreted.edits ?? []
          );
          if (patched.expectedRev !== rev) {
            res.status(409).json({
              error: 'Flow revision mismatch',
              code: 'version_mismatch',
              expectedRev: rev,
              currentRev: patched.expectedRev,
              hint: 'Re-read the flow and retry with the current rev.',
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
            'Pass flow=<id> from GET …/flows.'
          );
          return;
        }
        if (!nodeId) {
          jsonError(
            res,
            400,
            'node query parameter is required (or pass patch=)',
            'missing_node_id',
            'Pass node=<id> and set.<prop>=value, or patch=<base64url JSON>.'
          );
          return;
        }
        if (Object.keys(setProps).length === 0) {
          jsonError(
            res,
            400,
            'At least one set.<prop>=value is required',
            'missing_edits',
            'Example: set.name=Hello'
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
            hint: 'Re-read the flow and retry with the current rev.',
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
        },
        flowAdapter
      );
      res.status(201).json({
        ok: true,
        proposal,
        ...(summary ? { summary } : {}),
        hint: 'Waiting for human approval on /mcp. Poll GET …/proposals/<id>.',
      });
    } catch (error) {
      const mapped = aiOpsErrorToHttp(error);
      if (mapped) {
        res.status(mapped.statusCode).json({
          ...mapped.body,
          hint: 'Fix the reported code, re-read flows if rev is stale, then retry.',
        });
        return;
      }
      throw error;
    }
  };
}
