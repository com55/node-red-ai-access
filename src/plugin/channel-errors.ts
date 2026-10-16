/**
 * Shared AI-facing error bodies + channel-aware hints for GET / REST / MCP.
 *
 * One builder so every channel returns the same `error`/`code` (and the same
 * structured fields), with hints worded for that surface — no URL paths in MCP
 * hints, no `./flows` shortcuts in REST hints.
 */

import {
  AdapterUnavailableError,
  FlowNotFoundError,
  FlowRevisionConflictError,
  PluginMisconfiguredError,
} from '../runtime/errors.js';
import {
  ProposalNotFoundError,
  ProposalNotOwnedError,
  ProposalNotPendingError,
} from '../storage/proposals.js';
import { StoragePayloadTooLargeError } from '../storage/trusted-write.js';

import { AiOpsValidationError } from './ai-ops.js';

export type ErrorChannel = 'get' | 'rest' | 'mcp';

export interface ChannelErrorBody {
  error: string;
  code: string;
  hint?: string;
  expectedRev?: string;
  currentRev?: string;
  matchCount?: number;
  [key: string]: unknown;
}

export interface ChannelErrorMapped {
  statusCode: number;
  body: ChannelErrorBody;
}

/** Canonical user-facing messages — same text on every channel. */
export const CANONICAL_ERROR_TEXT: Record<string, string> = {
  node_not_found: 'Node was not found',
  flow_not_found: 'Flow was not found',
  field_not_found: 'Field was not found',
  field_not_string: 'Field is not a string',
  missing_query: 'q query parameter is required',
  missing_flow_id: 'Missing flow id',
  missing_node_id: 'Missing node id',
  missing_field: 'Missing field name',
  invalid_line_range: 'lines must be A or A-B (1-based inclusive; end >= start)',
  line_range_out_of_bounds: 'lines range is out of bounds',
  proposal_not_found: 'Proposal was not found',
  proposal_not_owned: 'Proposal was not created by this access link',
  proposal_not_pending: 'Proposal is not pending',
  unsupported_media_type: 'Content-Type must be application/json',
  upstream_error: 'Upstream request failed',
  internal_error: 'Internal server error',
};

/** Optional structured fields that refine a hint (e.g. invalid_wires cause). */
export interface HintContext {
  cause?: unknown;
}

/** Channel-specific hint for a known error code (undefined when none). */
export function channelErrorHint(
  code: string,
  channel: ErrorChannel,
  context: HintContext = {}
): string | undefined {
  return hintFor(code, channel, context);
}

function invalidWiresHint(channel: ErrorChannel, cause: unknown): string {
  if (cause === 'excess_ports') {
    if (channel === 'mcp') {
      return (
        'This node has more wire ports than its type declares — remove extra ports ' +
        'or raise the node outputs, then retry.'
      );
    }
    if (channel === 'rest') {
      return (
        'This node has more wire ports than its type declares — trim wires[] or raise outputs, ' +
        'then retry.'
      );
    }
    return (
      'This node has more wire ports than its type declares — trim wires or raise outputs, ' +
      'then retry.'
    );
  }
  if (cause === 'missing_target') {
    if (channel === 'mcp') {
      return 'Wire targets must be node ids in this flow — add the node in the same patch or use get_flow ids.';
    }
    if (channel === 'rest') {
      return 'Wire targets must be node ids in this flow — add the node in the same patch or use GET /flows/{id} ids.';
    }
    return 'wires must list existing node ids (or add those nodes in the same patch).';
  }
  // Unknown / unset cause: generic guidance.
  if (channel === 'mcp') {
    return 'Fix wires: targets must exist in this flow, and port count must not exceed the node outputs.';
  }
  if (channel === 'rest') {
    return 'Fix wires: targets must exist in this flow, and port count must not exceed the node outputs.';
  }
  return 'wires must list existing node ids (or add those nodes in the same patch).';
}

function nodeTypeHint(channel: ErrorChannel): string {
  if (channel === 'mcp') {
    return (
      'Call list_node_types or search_palette. Ask the user to install via Manage palette, ' +
      'then recheck. This API never installs.'
    );
  }
  if (channel === 'rest') {
    return (
      'Call GET /node-types?q= or GET /palette/search?q=. Ask the user to install via Manage palette, ' +
      'then recheck. This API never installs.'
    );
  }
  return (
    'Call GET …/node-types?q= or …/palette/search?q=. Ask the user to install via Manage palette, ' +
    'then recheck. This API never installs.'
  );
}

function pickChannel(channel: ErrorChannel, mcp: string, rest: string, get: string): string {
  if (channel === 'mcp') return mcp;
  if (channel === 'rest') return rest;
  return get;
}

/** Explicit switch — avoid dynamic dispatch on user-influenced error codes (CodeQL). */
function hintFor(
  code: string,
  channel: ErrorChannel,
  context: HintContext = {}
): string | undefined {
  switch (code) {
    case 'version_mismatch':
      return pickChannel(
        channel,
        'Re-read with list_flows/get_flow and retry with the current rev.',
        'Re-read the flow and retry with the current rev.',
        'Re-read the flow and retry with the current rev.'
      );
    case 'node_not_found':
      return pickChannel(
        channel,
        'Call get_flow or get_node and use a node id from that response.',
        'Call GET /flows/{id} and use a node id from that response.',
        'Call GET …/flows/<id> and use a node id from that response.'
      );
    case 'flow_not_found':
      return pickChannel(
        channel,
        'Call list_flows to list valid ids.',
        'Call GET /flows to list valid ids.',
        // GET-link: relative ./flows only — never absolute Admin GET /flows.
        'Use an id from GET ./flows.'
      );
    case 'proposal_not_found':
      return pickChannel(
        channel,
        'Call list_my_proposals and use an id from that response.',
        'List proposals and use an id from that response.',
        'List proposals and use an id from that response.'
      );
    case 'proposal_not_owned':
      return 'Only the access link that created a pending proposal can withdraw it.';
    case 'proposal_not_pending':
      return 'Only pending proposals can be withdrawn or decided.';
    case 'invalid_wires':
      return invalidWiresHint(channel, context.cause);
    case 'node_type_not_found':
    case 'unknown_node_type':
      return nodeTypeHint(channel);
    case 'missing_node_type':
      return 'Each add op needs node.type as a non-empty string (e.g. "inject").';
    case 'invalid_line_range':
      return pickChannel(
        channel,
        'Pass lines as "A" or "A-B" (1-based inclusive). Reversed ranges (end < start) are invalid.',
        'Use lines=A or lines=A-B (1-based inclusive). Reversed ranges (end < start) are invalid.',
        'Use lines=A or lines=A-B (1-based inclusive). Reversed ranges (end < start) are invalid.'
      );
    case 'line_range_out_of_bounds':
      return 'start is past the end of the field — check totalLines and request a lower lines range.';
    case 'ambiguous_match':
      return 'find matched more than once — pass occurrence=N (1-based) or a more unique find string.';
    case 'missing_expected_rev':
      return pickChannel(
        channel,
        'Pass expectedRev from list_flows/get_flow (top-level, next to type and payload).',
        'Pass expectedRev from GET /flows or GET /flows/{id} (top-level, next to type and payload).',
        'Pass rev from GET …/flows or …/flows/<id>.'
      );
    case 'missing_query':
      return pickChannel(
        channel,
        'Pass a non-empty q string.',
        'q query parameter is required.',
        'q query parameter is required.'
      );
    case 'unsupported_media_type':
      return 'Send Content-Type: application/json with a JSON body.';
    case 'text_not_found':
      return 'Re-read the node field; find must match exactly (case-sensitive).';
    case 'field_not_found':
      return 'Re-read the node; field must be an existing string property (template, func, …).';
    case 'field_not_string':
      return pickChannel(
        channel,
        'This tool only returns string fields (template, func, …). Use get_node for other property types.',
        'This endpoint only returns string fields (template, func, …). Use GET /nodes/{id} for other property types.',
        'This endpoint only returns string fields (template, func, …). Use GET /nodes/{id} for other property types.'
      );
    default:
      return undefined;
  }
}

/**
 * Normalize thrown errors into a status + JSON body shared by GET/REST/MCP.
 * Optionally rewrite `error` to the canonical cross-channel message.
 */
export function mapErrorForChannel(
  error: unknown,
  channel: ErrorChannel,
  options: { canonicalizeMessage?: boolean } = {}
): ChannelErrorMapped | null {
  const canonicalize = options.canonicalizeMessage !== false;
  let mapped: ChannelErrorMapped | null = null;

  if (error instanceof AiOpsValidationError) {
    mapped = {
      statusCode: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
        ...(error.details ?? {}),
      },
    };
  } else if (error instanceof FlowRevisionConflictError) {
    mapped = {
      statusCode: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
        expectedRev: error.expectedRev,
        currentRev: error.currentRev,
      },
    };
  } else if (error instanceof FlowNotFoundError) {
    mapped = {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code, flowId: error.flowId },
    };
  } else if (
    error instanceof ProposalNotFoundError ||
    error instanceof ProposalNotOwnedError ||
    error instanceof ProposalNotPendingError ||
    error instanceof StoragePayloadTooLargeError
  ) {
    mapped = {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  } else if (
    error instanceof PluginMisconfiguredError ||
    error instanceof AdapterUnavailableError
  ) {
    mapped = {
      statusCode: error.statusCode,
      body: { error: error.message, code: error.code },
    };
  }

  if (!mapped) {
    return null;
  }

  const code = mapped.body.code;
  if (canonicalize) {
    const canonical = CANONICAL_ERROR_TEXT[code];
    if (canonical) {
      mapped.body.error = canonical;
    }
  }

  // Prefer an explicit hint already on the error (e.g. nearest type matches).
  if (typeof mapped.body.hint !== 'string' || !mapped.body.hint) {
    const hint = hintFor(code, channel, { cause: mapped.body.cause });
    if (hint) {
      mapped.body.hint = hint;
    }
  }

  return mapped;
}

/** Build a synthetic error body (middleware / early rejects) with channel hint. */
export function buildChannelError(
  channel: ErrorChannel,
  code: string,
  options: { statusCode?: number; error?: string; details?: Record<string, unknown> } = {}
): ChannelErrorMapped {
  const error = options.error ?? CANONICAL_ERROR_TEXT[code] ?? 'Request failed';
  const body: ChannelErrorBody = { error, code, ...(options.details ?? {}) };
  const hint = hintFor(code, channel, { cause: body.cause });
  if (hint) {
    body.hint = hint;
  }
  return { statusCode: options.statusCode ?? 400, body };
}
