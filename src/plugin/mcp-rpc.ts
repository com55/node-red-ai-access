/**
 * MCP JSON-RPC endpoint at `/mcp/rpc` (Streamable HTTP).
 *
 * Thin adapter over the same AI operations used by `/mcp/api/v1`.
 * Access-link Bearer only — no approve/reject/link tools (those stay on `/mcp`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Response } from 'express';
import { z } from 'zod';

import {
  AdapterUnavailableError,
  FlowNotFoundError,
  FlowRevisionConflictError,
  PluginMisconfiguredError,
} from '../runtime/errors.js';
import { ProposalNotFoundError } from '../storage/proposals.js';
import { MAX_PROPOSAL_JSON_BYTES, StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import {
  ACCESS_LINK_INVALID_CODE,
  ACCESS_LINK_INVALID_MESSAGE,
  ACCESS_LINK_WWW_AUTHENTICATE,
} from './access-link-auth.js';
import {
  AiOpsValidationError,
  getFlow,
  getMyProposal,
  listFlows,
  listMyProposals,
  submitReplaceFlowProposal,
} from './ai-ops.js';
import { presentOptionsFor } from './proposal-present.js';
import type { PluginServices } from './services.js';
import { buildStatus } from './status.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

declare const __AI_ACCESS_VERSION__: string | undefined;

function pluginVersion(): string {
  if (typeof __AI_ACCESS_VERSION__ === 'string' && __AI_ACCESS_VERSION__.length > 0) {
    return __AI_ACCESS_VERSION__;
  }
  return '0.0.0';
}

function jsonResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function jsonError(
  error: unknown,
  fallbackStatus = 500
): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  if (error instanceof AiOpsValidationError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            code: error.code,
            statusCode: error.statusCode,
          }),
        },
      ],
    };
  }
  if (
    error instanceof FlowNotFoundError ||
    error instanceof ProposalNotFoundError ||
    error instanceof StoragePayloadTooLargeError ||
    error instanceof FlowRevisionConflictError ||
    error instanceof PluginMisconfiguredError ||
    error instanceof AdapterUnavailableError
  ) {
    const body: Record<string, unknown> = {
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    };
    if (error instanceof FlowRevisionConflictError) {
      body.expectedRev = error.expectedRev;
      body.currentRev = error.currentRev;
    }
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: message,
          code: 'internal_error',
          statusCode: fallbackStatus,
        }),
      },
    ],
  };
}

function registerReadTools(
  server: McpServer,
  RED: NodeRedPluginAPI,
  services: PluginServices,
  req: AuthenticatedRequest
): void {
  server.registerTool(
    'get_status',
    {
      description:
        'Return plugin status (version, AI feature flags, storage path, deploy defaults). ' +
        'For access-link callers, permission is null and caller.kind is "access-link" — that is expected, not an error. ' +
        'Use before other tools to confirm the plugin is enabled.',
    },
    () => {
      try {
        return jsonResult(buildStatus(RED, req));
      } catch (error) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    'list_flows',
    {
      description:
        'List all flows as a flat Admin API v2 array plus the current rev string. ' +
        'Returns { rev, flows }. Call this (or get_flow) before submit_proposal so expectedRev matches.',
    },
    async () => {
      try {
        return jsonResult(await listFlows(services.flowAdapter));
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );

  server.registerTool(
    'get_flow',
    {
      description:
        'Get one tab/subflow by id with nested nodes/configs and the current rev. ' +
        'Returns { rev, flow } where flow is { id, type, label?, nodes[], configs?, ... }. ' +
        'Use the returned rev as expectedRev when calling submit_proposal.',
      inputSchema: {
        id: z.string().min(1).describe('Flow / tab id'),
      },
    },
    async ({ id }) => {
      try {
        return jsonResult(await getFlow(services.flowAdapter, id));
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );
}

function registerProposalTools(
  server: McpServer,
  RED: NodeRedPluginAPI,
  services: PluginServices,
  req: AuthenticatedRequest,
  accessLink: NonNullable<AuthenticatedRequest['accessLink']>
): void {
  const presentOpts = presentOptionsFor(req, RED.settings.httpAdminRoot);
  server.registerTool(
    'submit_proposal',
    {
      description:
        'Submit a replace_flow proposal for owner approval (does not deploy). ' +
        'Call get_flow first and reuse that nested shape: payload.flow should be the get_flow ' +
        'result (id, type, label?, nodes[], optional configs[]) for the tab you are replacing. ' +
        'Inputs: type="replace_flow", expectedRev (required; from get_flow/list_flows; expected_rev alias accepted), ' +
        'optional title (≤80 chars, human-friendly), ' +
        `payload: { flowId, flow } with flow.nodes required. ` +
        `Payload size limit is ${MAX_PROPOSAL_JSON_BYTES} bytes (413 if exceeded). ` +
        'expectedRev is checked against the live rev at submit time (409 if stale). ' +
        'Returns the pending proposal with title, displayName (title · server-local datetime with offset), ' +
        'reviewUrl (absolute when Host is known), and reviewPath (relative /mcp#proposal=<id>). ' +
        'When telling the user about the proposal, cite displayName and reviewUrl — not the raw id. ' +
        'Humans approve on the /mcp page (reviewUrl opens/scrolls to it).',
      inputSchema: {
        type: z.literal('replace_flow').describe("Must be 'replace_flow'"),
        expectedRev: z
          .string()
          .min(1)
          .describe('Current flow revision from get_flow/list_flows (required)'),
        expected_rev: z
          .string()
          .min(1)
          .optional()
          .describe('Alias for expectedRev (snake_case); prefer expectedRev'),
        title: z
          .string()
          .max(80)
          .optional()
          .describe(
            'Optional short human title (≤80 chars). Auto-generated from changes when omitted.'
          ),
        payload: z
          .object({
            flowId: z.string().min(1).describe('Tab id to replace'),
            flow: z
              .object({
                id: z.string().optional(),
                type: z.string().optional().describe("Usually 'tab' (included by get_flow)"),
                label: z.string().optional(),
                nodes: z
                  .array(z.record(z.string(), z.unknown()))
                  .describe('Child nodes for the tab (required; from get_flow.nodes)'),
                configs: z.array(z.record(z.string(), z.unknown())).optional(),
              })
              .passthrough()
              .describe('Nested get_flow tab object (id, type, label?, nodes[], configs?)'),
          })
          .describe('Replacement flow payload'),
      },
    },
    async args => {
      try {
        const proposal = await submitReplaceFlowProposal(
          services.proposalStore,
          services.auditLog,
          accessLink,
          {
            ...args,
            expectedRev: args.expectedRev || args.expected_rev,
          },
          services.flowAdapter,
          presentOpts
        );
        return jsonResult(proposal);
      } catch (error) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    'list_my_proposals',
    {
      description:
        'List proposals created by this access link only. Returns { proposals: [...] } with ' +
        'title, displayName (server-local time with offset), reviewUrl (absolute), and reviewPath. ' +
        'Prefer displayName + reviewUrl when referring to a proposal with the user (not the raw id).',
    },
    () => {
      try {
        return jsonResult({
          proposals: listMyProposals(services.proposalStore, accessLink, presentOpts),
        });
      } catch (error) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    'get_proposal',
    {
      description:
        'Get one proposal by id if owned by this access link. Returns title, displayName, ' +
        'reviewUrl, and reviewPath — cite displayName + reviewUrl when talking to the user. ' +
        '404-style tool error if missing or not yours.',
      inputSchema: {
        id: z.string().min(1).describe('Proposal id (prop-…)'),
      },
    },
    ({ id }) => {
      try {
        return jsonResult(getMyProposal(services.proposalStore, accessLink, id, presentOpts));
      } catch (error) {
        return jsonError(error);
      }
    }
  );
}

function createAiMcpServer(
  RED: NodeRedPluginAPI,
  services: PluginServices,
  req: AuthenticatedRequest
): McpServer {
  const server = new McpServer({
    name: 'node-red-ai-access',
    version: pluginVersion(),
  });

  const accessLink = req.accessLink;
  if (!accessLink) {
    throw new Error('Access link required');
  }

  registerReadTools(server, RED, services, req);
  registerProposalTools(server, RED, services, req, accessLink);
  return server;
}

/**
 * POST /mcp/rpc — Streamable HTTP (stateless JSON responses).
 */
export function mcpRpcPostHandler(RED: NodeRedPluginAPI, services: PluginServices) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.accessLink) {
        res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
        res.status(401).json({
          error: ACCESS_LINK_INVALID_MESSAGE,
          code: ACCESS_LINK_INVALID_CODE,
        });
        return;
      }

      const server = createAiMcpServer(RED, services, req);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });

      await server.connect(transport as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

/** GET/DELETE /mcp/rpc — not used in this stateless deployment. */
export function mcpRpcMethodNotAllowed(_req: AuthenticatedRequest, res: Response): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST for Streamable HTTP.' },
      id: null,
    });
}
