/**
 * MCP JSON-RPC endpoint at `/mcp/rpc` (Streamable HTTP).
 *
 * Thin adapter over the same AI operations used by `/mcp/api/v1`.
 * Access-link and OAuth Bearer tokens — no approve/reject/link tools (those stay on `/mcp`).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { NextFunction, Response } from 'express';
import { z } from 'zod';

import type { AuditActor } from '../storage/audit-log.js';
import { oauthOwnerId } from '../storage/proposals.js';
import { MAX_PROPOSAL_JSON_BYTES } from '../storage/trusted-write.js';

import {
  ACCESS_LINK_MISSING_CODE,
  ACCESS_LINK_MISSING_MESSAGE,
  ACCESS_LINK_WWW_AUTHENTICATE,
} from './access-link-auth.js';
import {
  AiOpsValidationError,
  conflictWarningFields,
  findConflictingProposals,
  getAccessibleProposal,
  getFlow,
  invalidFilterError,
  parseStatusFilter,
  listAccessibleProposals,
  listPageFields,
  LIST_PROPOSALS_MAX_LIMIT,
  listFlows,
  presentAccessibleProposalForApi,
  submitReplaceFlowProposal,
  withdrawMyProposal,
  type ListFilterParameter,
  type ListProposalsFilter,
} from './ai-ops.js';
import { mapErrorForChannel } from './channel-errors.js';
import { applyDiffFormat, resolveDiffFormat } from './diff-format.js';
import { getFlowSummary, getNodeById, getNodeField, searchFlows } from './layered-read.js';
import { getNodeTypeDetail, listNodeTypes, searchPalette } from './node-types.js';
import { autoClosedFields, expireStalePendingProposals } from './proposal-conflicts.js';
import { computeProposalDiff } from './proposal-diff.js';
import { presentOptionsFor, presentProposalForApi } from './proposal-present.js';
import {
  accessLinkAuditActor,
  mcpOperationName,
  noteResponseRedactions,
  runWithRedactionAudit,
} from './redaction-audit.js';
import { sendCaughtRouteError } from './route-errors.js';
import { aiRedactingAdapter } from './secret-redaction.js';
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

async function tryLiveRev(adapter: PluginServices['flowAdapter']): Promise<string | undefined> {
  try {
    return (await listFlows(adapter)).rev;
  } catch {
    return undefined;
  }
}

function jsonResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  const text = JSON.stringify(data);
  noteResponseRedactions(text);
  return {
    content: [{ type: 'text', text }],
  };
}

function includeSetFromPayloadFlag(includePayload: boolean | undefined): Set<string> {
  return includePayload === true ? new Set(['payload', 'baseFlow']) : new Set();
}

function jsonError(
  error: unknown,
  fallbackStatus = 500
): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  const mapped = mapErrorForChannel(error, 'mcp');
  if (mapped) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...mapped.body,
            statusCode: mapped.statusCode,
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
        text: JSON.stringify({
          error: message,
          code: 'internal_error',
          statusCode: fallbackStatus,
        }),
      },
    ],
  };
}

/** MCP tools whose filter arguments map to `invalid_filter` (same as GET/REST). */
const LIST_FILTER_TOOLS = new Set(['list_proposals', 'list_my_proposals']);
const LIST_FILTER_PARAMS = new Set(['status', 'limit', 'offset', 'mine', 'flowId']);

interface ZodLikeIssue {
  path?: readonly PropertyKey[];
  message?: string;
}

interface ZodLikeSchema {
  safeParseAsync(
    value: unknown
  ): Promise<
    { success: true; data: unknown } | { success: false; error: { issues: ZodLikeIssue[] } }
  >;
}

function isZodLikeSchema(value: unknown): value is ZodLikeSchema {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { safeParseAsync?: unknown }).safeParseAsync === 'function'
  );
}

/**
 * Map schema-validation failures on MCP tool arguments to the same JSON error
 * bodies as GET/REST: list filters → `invalid_filter`; anything else →
 * `invalid_arguments` naming the parameter. Never returns raw Zod output.
 */
export function mcpArgumentError(
  toolName: string,
  args: unknown,
  issues: readonly ZodLikeIssue[]
): AiOpsValidationError {
  const argObj = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const first = issues[0];
  const parameter = first?.path && first.path.length > 0 ? String(first.path[0]) : '(arguments)';
  if (LIST_FILTER_TOOLS.has(toolName) && LIST_FILTER_PARAMS.has(parameter)) {
    return invalidFilterError(parameter as ListFilterParameter, argObj[parameter]);
  }
  const listed = issues.map(issue => ({
    parameter:
      issue.path && issue.path.length > 0 ? issue.path.map(String).join('.') : '(arguments)',
    message: issue.message ?? 'Invalid value',
  }));
  const message =
    listed.length === 1
      ? `Invalid argument '${listed[0]?.parameter}' for tool ${toolName}: ${listed[0]?.message}`
      : `${listed.length} invalid arguments for tool ${toolName}`;
  return new AiOpsValidationError(message, 'invalid_arguments', {
    details: {
      parameter,
      errors: listed,
      hint: `Fix '${parameter}' to match the ${toolName} input schema (see tools/list).`,
    },
  });
}

type ValidateToolInput = (
  tool: { inputSchema?: unknown },
  args: unknown,
  toolName: string
) => Promise<unknown>;

/**
 * Replace the SDK's argument validation so failures surface as our JSON error
 * body (tool result with `isError: true`) instead of raw Zod text.
 */
export function installMcpArgumentErrorMapping(server: McpServer): void {
  const target = server as unknown as { validateToolInput?: ValidateToolInput };
  const original = target.validateToolInput;
  if (typeof original !== 'function') {
    return;
  }
  target.validateToolInput = async (tool, args, toolName) => {
    const schema = tool.inputSchema;
    if (!isZodLikeSchema(schema)) {
      return original.call(server, tool, args, toolName);
    }
    const parsed = await schema.safeParseAsync(args ?? {});
    if (parsed.success) {
      return parsed.data;
    }
    const mapped = mapErrorForChannel(mcpArgumentError(toolName, args, parsed.error.issues), 'mcp');
    const body = mapped ? { ...mapped.body, statusCode: mapped.statusCode } : {};
    throw new Error(JSON.stringify(body));
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
        'Likely secrets are shown as "[REDACTED]" (nodes list redacted paths in _aiRedactions). ' +
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
        'Pass summary=true for a lightweight node list (id/type/name/wires/bytes, no field contents). ' +
        'Prefer summary → search_flows → get_node_field(lines) → replace_text → submit_proposal. ' +
        'Returns { rev, flow } or summary shape. Use rev as expectedRev when submitting.',
      inputSchema: {
        id: z.string().min(1).describe('Flow / tab id'),
        summary: z
          .boolean()
          .optional()
          .describe('When true, return node list with sizes only (no field contents)'),
      },
    },
    async ({ id, summary }) => {
      try {
        if (summary) {
          return jsonResult(await getFlowSummary(services.flowAdapter, id));
        }
        return jsonResult(await getFlow(services.flowAdapter, id));
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );

  server.registerTool(
    'get_node',
    {
      description:
        'Get one full node by id (includes owning flowId when known). Optional flow scopes the lookup.',
      inputSchema: {
        id: z.string().min(1).describe('Node id'),
        flow: z.string().min(1).optional().describe('Optional tab id to scope the lookup'),
      },
    },
    async ({ id, flow }) => {
      try {
        return jsonResult(await getNodeById(services.flowAdapter, id, flow));
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );

  server.registerTool(
    'get_node_field',
    {
      description:
        'Get one string field from a node. Optional lines="A-B" (1-based inclusive) returns a slice; ' +
        'response always includes totalLines and bytes.',
      inputSchema: {
        id: z.string().min(1).describe('Node id'),
        field: z.string().min(1).describe('Field name (e.g. template, func)'),
        lines: z.string().optional().describe('Optional 1-based line range A or A-B'),
        flow: z.string().min(1).optional().describe('Optional tab id to scope the lookup'),
      },
    },
    async ({ id, field, lines, flow }) => {
      try {
        return jsonResult(
          await getNodeField(services.flowAdapter, id, field, {
            ...(flow ? { flowId: flow } : {}),
            ...(lines ? { lines } : {}),
          })
        );
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );

  server.registerTool(
    'search_flows',
    {
      description:
        'Text search across string fields. Returns hits with node id, field, line numbers, and a short snippet. ' +
        'Results are capped; truncated=true when the cap is hit. Optional flow scopes to one tab.',
      inputSchema: {
        q: z.string().describe('Substring to find (case-sensitive; non-empty required)'),
        flow: z.string().min(1).optional().describe('Optional tab id'),
      },
    },
    async ({ q, flow }) => {
      try {
        return jsonResult(await searchFlows(services.flowAdapter, q, flow ? { flowId: flow } : {}));
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );

  server.registerTool(
    'list_node_types',
    {
      description:
        'List installed Node-RED palette node types (type, module, category, description, …). ' +
        'Optional q filters type/module/category/description (case-insensitive). Results are capped. ' +
        'Call this before proposing nodes with unfamiliar types.',
      inputSchema: {
        q: z.string().optional().describe('Optional case-insensitive filter'),
      },
    },
    async ({ q }) => {
      try {
        return jsonResult(await listNodeTypes(services.nodeTypesAdapter, q ? { q } : {}));
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );

  server.registerTool(
    'get_node_type',
    {
      description:
        'Get detail for one installed node type: defaults (JSON), inputs/outputs (always set), ' +
        'requiredConfigNodeTypes, help sections (summary/inputs/outputs), category/module/color. ' +
        'Types are case-sensitive. Pass includeHelp=false to omit help. ' +
        '404 node_type_not_found when unknown (didYouMean on case mismatch; else nearest names).',
      inputSchema: {
        type: z.string().min(1).describe('Node type id (e.g. inject, template) — case-sensitive'),
        includeHelp: z
          .boolean()
          .optional()
          .describe('When false, omit help sections (default true)'),
      },
    },
    async ({ type, includeHelp }) => {
      try {
        return jsonResult(
          await getNodeTypeDetail(services.nodeTypesAdapter, type, {
            includeHelp: includeHelp !== false,
          })
        );
      } catch (error) {
        return jsonError(error, 502);
      }
    }
  );

  server.registerTool(
    'search_palette',
    {
      description:
        'Search the public Node-RED catalogue for modules to recommend. ' +
        'Returns module id, description, version, updated, link, and installed boolean ' +
        '(cross-checked against installed modules). Core node-red types are not in the catalogue — ' +
        'use list_node_types. RECOMMEND ONLY — never installs.',
      inputSchema: {
        q: z.string().describe('Search string (id / description / keywords; non-empty required)'),
      },
    },
    async ({ q }) => {
      try {
        return jsonResult(
          await searchPalette(services.nodeTypesAdapter, q, {
            ...(services.catalogueFetcher ? { catalogueFetcher: services.catalogueFetcher } : {}),
            ...(services.catalogueUrl ? { catalogueUrl: services.catalogueUrl } : {}),
          })
        );
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
        'Preferred for small string edits: payload: { flowId, nodes: [{ op:"replace_text", ' +
        'node, field, find, replace, occurrence? }] } — find must be unique unless occurrence ' +
        '(1-based) is set; multiple replace_text ops apply in order; yields a short readable diff. ' +
        'Or send a full tab: payload.flow from get_flow (id, type, label?, nodes[], configs?). ' +
        'Inputs (all top-level, next to each other): type="replace_flow", ' +
        'expectedRev (required string from list_flows/get_flow rev; expected_rev alias accepted), ' +
        'optional title (≤80 chars), and payload: { flowId, flow? } and/or payload.nodes / top-level nodes. ' +
        'Do not nest expectedRev inside payload. ' +
        'Secret values appear as "[REDACTED]" in reads; leave the placeholder unchanged to keep the stored secret ' +
        '(it is restored on submit), or replace it with a new value to change it. ' +
        `Payload size limit is ${MAX_PROPOSAL_JSON_BYTES} bytes (413 if exceeded). ` +
        'expectedRev is checked against the live rev at submit time (409 if stale). ' +
        'replace_text errors: 400 text_not_found; 409 ambiguous_match with matchCount. ' +
        'Unknown palette types return 400 unknown_node_type with nearest matches — call list_node_types / ' +
        'search_palette and ask the user to install via Manage palette (never auto-install). ' +
        'Returns a lean proposal (id, status, title, storedTitle, flowLabel, displayName, reviewUrl, changeSummary, …) by default; ' +
        'title may gain " in <flow>"; storedTitle is the title as saved (your title without that suffix, ' +
        'or the auto-generated title, which may already name the flow). ' +
        'Pass include_payload=true to include payload and baseFlow. ' +
        'When telling the user about the proposal, cite displayName and reviewUrl — not the raw id. ' +
        'Humans approve on the /ai-access dashboard (reviewUrl opens/scrolls to it).',
      inputSchema: {
        type: z.literal('replace_flow').describe("Must be 'replace_flow'"),
        // Both optional in Zod so a missing rev yields our friendly
        // missing_expected_rev (via submitReplaceFlowProposal), not a raw Zod error.
        expectedRev: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Top-level current flow revision from get_flow/list_flows (required at submit; sit next to type and payload, not inside payload)'
          ),
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
        include_payload: z
          .boolean()
          .optional()
          .describe('When true, include payload and baseFlow in the response (default lean)'),
        nodes: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Optional node ops (set/add/remove/replace_text). Same as payload.nodes when flow is omitted.'
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
                  .optional()
                  .describe('Child nodes for the tab (from get_flow.nodes)'),
                configs: z.array(z.record(z.string(), z.unknown())).optional(),
              })
              .passthrough()
              .optional()
              .describe('Full tab from get_flow; omit when using nodes ops'),
            nodes: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe(
                'Node ops applied to the live tab (prefer replace_text for small string edits)'
              ),
          })
          .describe('Replacement flow payload and/or node ops'),
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
            expectedRev:
              typeof args.expectedRev === 'string' && args.expectedRev.length > 0
                ? args.expectedRev
                : args.expected_rev,
          },
          services.flowAdapter,
          presentOpts,
          services.nodeTypesAdapter
        );
        const lean = {
          ...presentProposalForApi(proposal, {
            ...presentOpts,
            include: includeSetFromPayloadFlag(args.include_payload),
          }),
          mine: true,
        };
        const autoClosedCount = expireStalePendingProposals(
          services.proposalStore,
          proposal.expectedRev,
          {
            flowId: proposal.payload.flowId,
          }
        );
        const conflicts = conflictWarningFields(
          findConflictingProposals(
            services.proposalStore,
            services.proposalStore.get(proposal.id),
            accessLink.id
          )
        );
        return jsonResult({ ...lean, ...conflicts, ...autoClosedFields(autoClosedCount) });
      } catch (error) {
        return jsonError(error);
      }
    }
  );

  registerProposalQueryTools(server, services, accessLink, presentOpts);
  registerProposalActionTools(server, services, accessLink, presentOpts);
}

function registerListProposalsTools(
  server: McpServer,
  services: PluginServices,
  accessLink: NonNullable<AuthenticatedRequest['accessLink']>,
  presentOpts: ReturnType<typeof presentOptionsFor>
): void {
  const listProposalsInputSchema = {
    mine: z
      .boolean()
      .optional()
      .describe(
        'true: only proposals created by this access link; false: only other links’ proposals'
      ),
    status: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Filter by proposal status: one value, an array, or a comma-separated string ' +
          '(pending, approved, rejected, failed, withdrawn, expired, superseded). ' +
          'An empty array or empty string means no status filter.'
      ),
    flowId: z.string().optional().describe('Filter by flow tab id (payload.flowId)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_PROPOSALS_MAX_LIMIT)
      .optional()
      .describe(`Page size (1–${LIST_PROPOSALS_MAX_LIMIT}). Omit to return all matches.`),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Skip this many filtered results (default 0)'),
    include_payload: z
      .boolean()
      .optional()
      .describe('When true, include payload and baseFlow on each proposal'),
  };

  const listProposalsHandler = async (args: {
    mine?: boolean | undefined;
    status?: string | string[] | undefined;
    flowId?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    include_payload?: boolean | undefined;
  }) => {
    try {
      const include = includeSetFromPayloadFlag(args.include_payload);
      const liveRev = await tryLiveRev(services.flowAdapter);
      const autoClosedCount = liveRev
        ? expireStalePendingProposals(services.proposalStore, liveRev)
        : 0;
      const filter: ListProposalsFilter = {};
      if (typeof args.mine === 'boolean') {
        filter.mine = args.mine;
      }
      const status = parseStatusFilter(args.status);
      if (status) {
        filter.status = status;
      }
      if (typeof args.flowId === 'string' && args.flowId.length > 0) {
        filter.flowId = args.flowId;
      }
      if (typeof args.limit === 'number') {
        filter.limit = args.limit;
      }
      if (typeof args.offset === 'number') {
        filter.offset = args.offset;
      }
      const page = listAccessibleProposals(services.proposalStore, accessLink, presentOpts, filter);
      return jsonResult({
        proposals: page.proposals.map(p =>
          presentAccessibleProposalForApi(
            services.proposalStore,
            accessLink,
            p,
            { ...presentOpts, include },
            { includeConflicts: false }
          )
        ),
        ...listPageFields({ ...page, returned: page.proposals.length }),
        ...autoClosedFields(autoClosedCount),
      });
    } catch (error) {
      return jsonError(error);
    }
  };

  server.registerTool(
    'list_proposals',
    {
      description:
        'List proposals visible to this access link (all proposals by default). Each item includes ' +
        'mine:true|false for the caller. Filter with mine, status, and/or flowId; paginate with ' +
        'limit/offset (response includes total, offset, hasMore, nextOffset). Invalid filters return ' +
        'invalid_filter. Returns lean { proposals, total, … } with title, ' +
        'displayName, reviewUrl, changeSummary (no payload/baseFlow unless include_payload=true). ' +
        'Prefer displayName + reviewUrl when referring to a proposal with the user (not the raw id).',
      inputSchema: listProposalsInputSchema,
    },
    listProposalsHandler
  );

  // Alias kept for older clients / prompts.
  server.registerTool(
    'list_my_proposals',
    {
      description:
        'Alias of list_proposals. Prefer list_proposals. Lists proposals visible to this access ' +
        'link with optional mine/status/flowId filters and limit/offset pagination.',
      inputSchema: listProposalsInputSchema,
    },
    listProposalsHandler
  );
}

function registerProposalQueryTools(
  server: McpServer,
  services: PluginServices,
  accessLink: NonNullable<AuthenticatedRequest['accessLink']>,
  presentOpts: ReturnType<typeof presentOptionsFor>
): void {
  registerListProposalsTools(server, services, accessLink, presentOpts);

  server.registerTool(
    'get_proposal',
    {
      description:
        'Get any proposal by id (all tokens can read). Response includes mine:true|false and, for ' +
        'pending proposals, conflictingProposals when other pending work touches the same flow. ' +
        'Lean by default (no payload/baseFlow); pass include_payload=true for full bodies. ' +
        'Cite displayName + reviewUrl when talking to the user.',
      inputSchema: {
        id: z.string().min(1).describe('Proposal id (prop-…)'),
        include_payload: z.boolean().optional().describe('When true, include payload and baseFlow'),
      },
    },
    async ({ id, include_payload }) => {
      try {
        const liveRev = await tryLiveRev(services.flowAdapter);
        const proposal = getAccessibleProposal(services.proposalStore, accessLink, id, presentOpts);
        return jsonResult(
          presentAccessibleProposalForApi(
            services.proposalStore,
            accessLink,
            proposal,
            {
              ...presentOpts,
              include: includeSetFromPayloadFlag(include_payload),
            },
            { ...(liveRev ? { liveRev } : {}) }
          )
        );
      } catch (error) {
        return jsonError(error);
      }
    }
  );
}

function registerProposalActionTools(
  server: McpServer,
  services: PluginServices,
  accessLink: NonNullable<AuthenticatedRequest['accessLink']>,
  presentOpts: ReturnType<typeof presentOptionsFor>
): void {
  server.registerTool(
    'get_proposal_diff',
    {
      description:
        'Diff any proposal against its stored baseFlow snapshot (what changed). ' +
        'Optional format=summary|full (default summary). Pending + stale also includes vsCurrent.',
      inputSchema: {
        id: z.string().min(1).describe('Proposal id (prop-…)'),
        format: z
          .enum(['summary', 'full'])
          .optional()
          .describe('Diff payload format (default summary)'),
      },
    },
    async ({ id, format }) => {
      try {
        const proposal = getAccessibleProposal(services.proposalStore, accessLink, id);
        const resolved = resolveDiffFormat(format ?? 'summary');
        if (!resolved.ok) {
          return jsonError(
            new AiOpsValidationError('Invalid diff format', 'invalid_diff_format', {
              details: { hint: 'Valid formats: summary, full (default summary).' },
            })
          );
        }
        const diff = applyDiffFormat(
          await computeProposalDiff(proposal, services.flowAdapter),
          resolved.format
        );
        return jsonResult(diff);
      } catch (error) {
        return jsonError(error);
      }
    }
  );

  server.registerTool(
    'withdraw_proposal',
    {
      description:
        'Withdraw one of YOUR pending proposals (status becomes withdrawn, not rejected). ' +
        'Optional reason. Only the creating access link can withdraw; other tokens get 403. ' +
        'Cite displayName + reviewUrl when telling the user.',
      inputSchema: {
        id: z.string().min(1).describe('Proposal id (prop-…) owned by this access link'),
        reason: z.string().optional().describe('Optional withdraw reason'),
      },
    },
    ({ id, reason }) => {
      try {
        const withdrawn = withdrawMyProposal(
          services.proposalStore,
          services.auditLog,
          accessLink,
          id,
          reason,
          presentOpts
        );
        return jsonResult(
          presentAccessibleProposalForApi(
            services.proposalStore,
            accessLink,
            withdrawn,
            presentOpts
          )
        );
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
  installMcpArgumentErrorMapping(server);

  const accessLink = req.accessLink;
  if (!accessLink) {
    throw new Error('Access link required');
  }

  registerReadTools(server, RED, services, req);
  registerProposalTools(server, RED, services, req, accessLink);
  return server;
}

function mcpAuditActor(req: AuthenticatedRequest): AuditActor {
  const link = accessLinkAuditActor(req);
  if (link) return link;
  const clientId = req.auth?.clientId ?? '';
  const user = typeof req.auth?.extra?.user === 'string' ? req.auth.extra.user : 'owner';
  return { kind: 'access-link', linkId: oauthOwnerId(clientId, user), label: 'oauth' };
}

/**
 * POST /mcp/rpc — Streamable HTTP (stateless JSON responses).
 */
export function mcpRpcPostHandler(RED: NodeRedPluginAPI, services: PluginServices) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.accessLink && !req.auth) {
        res.setHeader('WWW-Authenticate', ACCESS_LINK_WWW_AUTHENTICATE);
        res.status(401).json({
          error: ACCESS_LINK_MISSING_MESSAGE,
          code: ACCESS_LINK_MISSING_CODE,
        });
        return;
      }

      // Every MCP caller is an AI client: flow reads go through the redacting view.
      const aiServices: PluginServices = {
        ...services,
        flowAdapter: aiRedactingAdapter(services.flowAdapter),
      };
      const server = req.accessLink
        ? createAiMcpServer(RED, aiServices, req)
        : createOAuthMcpServer(RED, aiServices, req);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });

      await server.connect(transport);
      await runWithRedactionAudit(
        services.auditLog,
        mcpAuditActor(req),
        mcpOperationName(req.body),
        () => transport.handleRequest(req, res, req.body)
      );

      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      // Prefer JSON 500 here; error middleware is a second safety net.
      if (!res.headersSent) {
        sendCaughtRouteError(res, error);
        return;
      }
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

function createOAuthMcpServer(
  RED: NodeRedPluginAPI,
  services: PluginServices,
  req: AuthenticatedRequest
): McpServer {
  const server = new McpServer({ name: 'node-red-ai-access', version: pluginVersion() });
  installMcpArgumentErrorMapping(server);
  registerReadTools(server, RED, services, req);
  const scopes = req.auth?.scopes ?? [];
  if (scopes.includes('propose')) {
    const user = typeof req.auth?.extra?.user === 'string' ? req.auth.extra.user : 'owner';
    const clientId = req.auth?.clientId ?? '';
    const ownerId = oauthOwnerId(clientId, user);
    const synthetic = {
      id: ownerId,
      kind: 'mcp' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date((req.auth?.expiresAt ?? 0) * 1000).toISOString(),
      createdBy: user,
      oauthClientId: clientId,
      oauthUser: user,
    };
    registerProposalTools(server, RED, services, req, synthetic);
  }
  return server;
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
