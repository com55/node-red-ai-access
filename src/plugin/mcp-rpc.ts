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

import { FlowNotFoundError } from '../runtime/errors.js';
import { ProposalNotFoundError } from '../storage/proposals.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import {
  AiOpsValidationError,
  getFlow,
  getMyProposal,
  listFlows,
  listMyProposals,
  submitReplaceFlowProposal,
} from './ai-ops.js';
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
      content: [{ type: 'text', text: JSON.stringify({ error: error.message, statusCode: 400 }) }],
    };
  }
  if (
    error instanceof FlowNotFoundError ||
    error instanceof ProposalNotFoundError ||
    error instanceof StoragePayloadTooLargeError
  ) {
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
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, statusCode: fallbackStatus }),
      },
    ],
  };
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

  server.registerTool(
    'get_status',
    {
      description: 'Plugin status (same payload shape as GET /mcp/api/v1/status).',
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
      description: 'List flows and the current rev (same as GET /mcp/api/v1/flows).',
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
      description: 'Get one flow by id with rev (same as GET /mcp/api/v1/flows/:id).',
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

  server.registerTool(
    'submit_proposal',
    {
      description:
        'Submit a replace_flow proposal (same as POST /mcp/api/v1/proposals). Requires expected_rev / expectedRev.',
      inputSchema: {
        type: z.literal('replace_flow').describe("Must be 'replace_flow'"),
        expectedRev: z
          .string()
          .min(1)
          .optional()
          .describe('Current flow revision (camelCase; preferred)'),
        expected_rev: z
          .string()
          .min(1)
          .optional()
          .describe('Current flow revision (snake_case alias)'),
        payload: z
          .object({
            flowId: z.string().min(1),
            flow: z.record(z.string(), z.unknown()),
          })
          .describe('Replacement flow payload'),
      },
    },
    args => {
      try {
        const proposal = submitReplaceFlowProposal(
          services.proposalStore,
          services.auditLog,
          accessLink,
          args
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
        'List proposals created by this access link (same as GET /mcp/api/v1/proposals for a link).',
    },
    () => {
      try {
        return jsonResult({ proposals: listMyProposals(services.proposalStore, accessLink) });
      } catch (error) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    'get_proposal',
    {
      description:
        'Get one proposal by id if owned by this access link (same as GET /mcp/api/v1/proposals/:id).',
      inputSchema: {
        id: z.string().min(1).describe('Proposal id'),
      },
    },
    ({ id }) => {
      try {
        return jsonResult(getMyProposal(services.proposalStore, accessLink, id));
      } catch (error) {
        return jsonError(error);
      }
    }
  );

  return server;
}

/**
 * POST /mcp/rpc — Streamable HTTP (stateless JSON responses).
 */
export function mcpRpcPostHandler(RED: NodeRedPluginAPI, services: PluginServices) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.accessLink) {
        res.status(401).json({
          error:
            'Access link is invalid, expired, revoked, or no longer available after a restart. Ask the user for a new access link.',
        });
        return;
      }

      const server = createAiMcpServer(RED, services, req);
      // Stateless Streamable HTTP: omit sessionIdGenerator (do not pass undefined —
      // exactOptionalPropertyTypes rejects explicit undefined here).
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
