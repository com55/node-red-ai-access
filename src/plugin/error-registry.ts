/**
 * Central registry of AI-facing error codes (HTTP status, meaning, hint).
 *
 * Single source of truth for `docs/errors.md`, the GET-link guide error table,
 * and the OpenAPI `ErrorCode` list. A staleness test fails CI when the
 * generated docs drift from this file (`yarn generate:errors` rewrites them).
 */

import { INVALID_TTL_HINT } from '../access/ttl.js';

export type ErrorRegistryChannel = 'GET' | 'REST' | 'MCP' | 'admin';

/**
 * `error` = JSON error body with this `code`;
 * `warning` = entry in a successful response's `warnings[]`;
 * `status` = proposal status value (not an error body).
 */
export type ErrorRegistryKind = 'error' | 'warning' | 'status';

export interface ErrorCodeSpec {
  code: string;
  /** HTTP status for `error` entries; success status for warnings/statuses. */
  status: number;
  meaning: string;
  hint: string;
  channels: readonly ErrorRegistryChannel[];
  kind: ErrorRegistryKind;
}

const ALL: readonly ErrorRegistryChannel[] = ['GET', 'REST', 'MCP'];
const GET_ONLY: readonly ErrorRegistryChannel[] = ['GET'];
const REST_MCP: readonly ErrorRegistryChannel[] = ['REST', 'MCP'];
const GET_REST: readonly ErrorRegistryChannel[] = ['GET', 'REST'];
const ADMIN: readonly ErrorRegistryChannel[] = ['admin'];

function e(
  code: string,
  status: number,
  meaning: string,
  hint: string,
  channels: readonly ErrorRegistryChannel[] = ALL,
  kind: ErrorRegistryKind = 'error'
): ErrorCodeSpec {
  return { code, status, meaning, hint, channels, kind };
}

export const ERROR_REGISTRY: readonly ErrorCodeSpec[] = [
  e(
    'proposal_conflict',
    409,
    'Editor and proposal changes conflict (conflicts contains field names only)',
    'Read the current flow and resolve the proposal before approval',
    [...ALL, 'admin']
  ),
  e(
    'rebase_ack_required',
    409,
    'The merged result needs review (mergedHash included)',
    'Review the diff and approve with its mergedHash',
    ['admin']
  ),
  e(
    'rebase_race',
    409,
    'Flows kept changing during approval',
    'Recheck the proposal and retry approval',
    ['admin']
  ),
  e(
    'conflict_not_found',
    409,
    'The requested conflict no longer exists',
    'Reload the proposal and its conflicts',
    ['admin']
  ),
  e(
    'invalid_choice',
    400,
    'Invalid manual conflict choice',
    'Use an available live or proposed choice',
    ['admin']
  ),
  e(
    'flow_id_mismatch',
    400,
    'Resolution tried to change the proposal flow id',
    'Keep the same flowId or submit a new proposal',
    REST_MCP
  ),
  // --- Authentication / access links
  e(
    'access_link_missing',
    401,
    'No Bearer / path token',
    'Ask the user for a new access link of the right kind'
  ),
  e(
    'bearer_scheme_required',
    401,
    'Auth used Basic (or non-Bearer)',
    'Send `Authorization: Bearer <token>`',
    REST_MCP
  ),
  e(
    'token_expired',
    401,
    'Known token past `expiresAt` (body includes `expiredAt` and `accessLinksUrl`)',
    'Ask the user to create a new link on the `/ai-access` dashboard → Access tokens (`accessLinksUrl`)'
  ),
  e(
    'access_link_invalid',
    401,
    'Unknown, revoked, or cleared after restart',
    'Ask the user for a new access link'
  ),
  e(
    'wrong_token_kind',
    403,
    'Token kind does not match this surface',
    'Mint the matching kind on `/ai-access` → Access tokens; show `tellUser` to the human'
  ),
  e('ai_features_disabled', 403, 'Plugin AI features off', 'Owner enables AI Access / `adminAuth`'),
  e('auth_required', 401, 'Admin session required', 'Sign in to the Node-RED editor', ADMIN),
  e(
    'insufficient_permissions',
    403,
    'Admin lacks required scope',
    'Need `*` for link mint / approve',
    ADMIN
  ),
  e(
    'invalid_link_kind',
    400,
    'Unknown `kind` on create',
    'Use `get_link`, `rest`, or `mcp`',
    ADMIN
  ),
  e(
    'invalid_ttl',
    400,
    '`ttlSeconds` is zero, negative, not a number, or over the cap for the kind',
    INVALID_TTL_HINT,
    ADMIN
  ),
  e('access_link_limit', 409, 'Too many active links', 'Revoke an existing link first', ADMIN),
  e(
    'access_link_not_found',
    404,
    'Unknown link id on revoke',
    'List links and use an existing id',
    ADMIN
  ),
  e(
    'link_create_not_supported',
    403,
    'Attempted mint under a GET link',
    'Admin mints via `POST /mcp/api/v1/links` only',
    GET_ONLY
  ),
  e('rate_limited', 429, 'Per-IP or per-token limit', 'Wait `retryAfter` / `Retry-After`'),
  // --- Request shape
  e('payload_too_large', 413, 'Body / proposal over ~1.5MB', 'Shrink content'),
  e('invalid_json', 400, 'Malformed JSON body', 'Fix Content-Type / body', REST_MCP),
  e(
    'unsupported_media_type',
    415,
    'POST body is not `application/json`',
    'Send `Content-Type: application/json`',
    REST_MCP
  ),
  e(
    'url_too_long',
    414,
    'GET URL over soft cap (~8KB)',
    'Use chunked drafts or REST/MCP',
    GET_ONLY
  ),
  e('not_found', 404, 'Unknown path or resource', 'Re-read docs / discovery'),
  e('missing_query', 400, 'Required search `q` missing', 'Pass `?q=`', GET_REST),
  e(
    'invalid_filter',
    400,
    'Invalid list filter (`status`, `limit`, `offset`, `mine`); body names `parameter` and `allowed`',
    'Use an allowed value: status one of the proposal statuses; limit integer 1–200; offset integer ≥ 0; mine true|false'
  ),
  e(
    'invalid_arguments',
    400,
    'MCP tool arguments failed schema validation; body names `parameter`',
    'Fix the named argument to match the tool input schema (see tools/list)',
    ['MCP']
  ),
  e(
    'invalid_diff_format',
    400,
    'Unknown `format` on proposal diff',
    'Use `format=summary` (default) or `format=full`'
  ),
  e(
    'confirm_required',
    400,
    'GET withdraw without `confirm=1`',
    'Repeat the request with `confirm=1`',
    GET_ONLY
  ),
  // --- Proposals
  e(
    'missing_expected_rev',
    400,
    'Proposal submitted without `expectedRev` / `rev`',
    'Read the flow and pass its `rev`'
  ),
  e(
    'version_mismatch',
    409,
    'Unknown or unavailable `rev` / `expectedRev` snapshot',
    'Re-read flows and resubmit'
  ),
  e('proposal_not_found', 404, 'Unknown proposal id', 'List proposals and use an existing id'),
  e(
    'proposal_not_pending',
    409,
    'Action needs an open proposal',
    'Only pending or conflict proposals can withdraw / decide'
  ),
  e(
    'proposal_not_owned',
    403,
    'Withdraw of another token’s proposal',
    'Only the creating token can withdraw'
  ),
  e(
    'validation_failed',
    400,
    'Several validation errors at once (message `N validation errors`)',
    'Fix every entry in errors[] and resubmit.'
  ),
  e(
    'duplicate_node_id',
    400,
    'The same node id appears more than once in a full tab or batch',
    'Give every node a unique id'
  ),
  e('missing_node_id', 400, 'Node / op without an id', 'Include a non-empty string id'),
  e(
    'missing_node_type',
    400,
    'Node without a `type`',
    'Set `type` to an installed palette type name'
  ),
  e('invalid_node_type', 400, '`type` is not a string', 'Use the palette type name exactly'),
  e(
    'invalid_nodes',
    400,
    '`flow.nodes` / `flow.configs` not an array',
    'Send arrays (use `[]` to clear)'
  ),
  e('invalid_node', 400, 'Node entry is not an object', 'Send `{ id, type, … }` objects'),
  e(
    'invalid_wires',
    400,
    'Bad wires shape, missing target, or more ports than outputs',
    'Wire only to existing node ids / ports'
  ),
  e('z_mismatch', 400, 'Node `z` differs from the flow id', 'Set `z` to the tab id or omit it'),
  e('node_already_exists', 400, '`add` op for an id already in the flow', 'Use `set` or a new id'),
  e('protected_property', 400, 'Tried to change id / type / z', 'Omit id, type, and z from edits'),
  e(
    'node_not_found',
    404,
    'Unknown node (single error only; several errors → `validation_failed`)',
    'Re-read the flow'
  ),
  e('field_not_found', 404, 'Unknown field on a node', 'Re-read the node'),
  e('text_not_found', 400, '`replace_text` find had no match', 'Re-read field; find is exact'),
  e(
    'ambiguous_match',
    409,
    '`replace_text` matched more than once',
    'Pass `occurrence` (1-based) or unique find'
  ),
  e(
    'unknown_node_type',
    400,
    'Proposal uses a type that is not installed',
    'List node-types / palette search; ask user to install'
  ),
  e(
    'node_type_not_found',
    404,
    'Unknown type on node-types detail',
    'List types or search palette'
  ),
  // --- GET drafts
  e(
    'chunk_conflict',
    409,
    'Same draft seq re-sent with different data',
    'Re-send identical data or start a new draft',
    GET_ONLY
  ),
  e(
    'missing_chunks',
    400,
    'Draft submit with gaps in seq',
    'Upload every seq from 0 through max',
    GET_ONLY
  ),
  e(
    'draft_hash_mismatch',
    400,
    'Draft sha256 does not match assembled bytes',
    'Send the hex sha256 of the assembled UTF-8',
    GET_ONLY
  ),
  // --- Warnings (success responses)
  e(
    'missing_config_node',
    201,
    'Warning: node has no (or an unresolved) config node yet',
    'Configure before deploy if needed; see `candidates`',
    ALL,
    'warning'
  ),
  e(
    'unwired_node',
    201,
    'Warning: node has outputs but no wires',
    'Wire it, or ignore while scaffolding',
    ALL,
    'warning'
  ),
  e(
    'incomplete_wires',
    201,
    'Warning: fewer wire ports than outputs',
    'Add ports if outputs should connect',
    ALL,
    'warning'
  ),
  e(
    'redacted_placeholder_mismatch',
    400,
    'A `[REDACTED]` placeholder was added, duplicated, moved, or its env/header name changed',
    'Keep placeholders exactly where they were shown (same line, same name) or supply a real value',
    ALL
  ),
  e(
    'secret_destination_changed',
    201,
    'Warning: a node holding a restored secret changed where it sends data (url/host/method/headers/…)',
    'Reviewer must verify the new destination before approving',
    ALL,
    'warning'
  ),
  e(
    'secret_node_code_changed',
    201,
    'Warning: a node holding a restored secret had its code changed',
    'Reviewer must check the code does not send the secret elsewhere',
    ALL,
    'warning'
  ),
  e(
    'secret_wires_changed',
    201,
    'Warning: a node holding a restored secret had its output wires changed',
    'Reviewer must check where its messages now go',
    ALL,
    'warning'
  ),
  e(
    'secret_scope_changed',
    201,
    'Warning: tab/group env or a config node scoping a secret-holding node changed',
    'Reviewer must check env-resolved hosts/URLs (e.g. `${API_HOST}`)',
    ALL,
    'warning'
  ),
  e(
    'outbound_node_changed',
    201,
    'Warning: proposal adds/changes an outbound-capable node (http request/response, mqtt, tcp, udp, email, websocket, link out/call, function, exec, file, or any node with url/host fields)',
    'Reviewer must check it cannot send secret data elsewhere',
    ALL,
    'warning'
  ),
  e(
    'secret_tab_changed',
    201,
    'Warning: proposal with restored secrets also changes other nodes in the tab',
    'Review every change before approving',
    ALL,
    'warning'
  ),
  e(
    'secret_reference_added',
    201,
    'Warning: an added/changed node now reads a secret-named env/global/flow value (env.get, $env, ${…}, typed input)',
    'Reviewer must check the value is not sent anywhere unexpected',
    ALL,
    'warning'
  ),
  // --- Proposal statuses
  e(
    'conflict',
    200,
    'Status: open proposal has conflicting editor changes; approval blocked',
    'Read the current flow and resolve the proposal',
    ALL,
    'status'
  ),
  e(
    'expired',
    200,
    'Status: open proposal expired after the configured TTL (default 7 days)',
    'Re-read the flow and submit a new proposal',
    ALL,
    'status'
  ),
  e(
    'superseded',
    200,
    'Legacy closed status; new approvals rebase other open proposals',
    'Re-read the flow and submit a new proposal if still needed',
    ALL,
    'status'
  ),
  // --- Server
  e('upstream_error', 502, 'Node-RED runtime/flows error', 'Retry; check Node-RED logs'),
  e('internal_error', 500, 'Unexpected server error', 'Retry; check Node-RED logs'),
];

const BY_CODE = new Map<string, ErrorCodeSpec>(ERROR_REGISTRY.map(s => [s.code, s]));

export function errorSpec(code: string): ErrorCodeSpec | undefined {
  return BY_CODE.get(code);
}

export function registryHint(code: string): string | undefined {
  return BY_CODE.get(code)?.hint;
}

function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function table(specs: readonly ErrorCodeSpec[], statusHeader: string): string {
  const rows = specs.map(
    s =>
      `| \`${s.code}\` | ${s.status} | ${cell(s.meaning)} | ${cell(s.hint)} | ${s.channels.join(', ')} |`
  );
  return [
    `| Code | ${statusHeader} | Meaning | Hint / next step | Channels |`,
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Full `docs/errors.md` content. */
export function renderErrorsMarkdown(): string {
  const errors = ERROR_REGISTRY.filter(s => s.kind === 'error');
  const warnings = ERROR_REGISTRY.filter(s => s.kind === 'warning');
  const statuses = ERROR_REGISTRY.filter(s => s.kind === 'status');
  return `<!-- Generated from src/plugin/error-registry.ts — run \`yarn generate:errors\`. Do not edit by hand. -->

# Error codes

JSON error bodies use \`{ error, code, hint? }\` (some also include
channel-specific fields). Channels: **GET** = \`/mcp/a/<token>\`, **REST** =
\`/mcp/api/v1\`, **MCP** = \`/mcp/rpc\` (tool results with \`isError: true\` carry
the same JSON plus \`statusCode\`), **admin** = owner-only \`/mcp/api/v1\` routes.

GET-link \`401\` responses include a \`WWW-Authenticate: Bearer …\` header.

## Errors

${table(errors, 'HTTP')}

## Warnings

Returned in \`warnings[]\` on a successful propose/submit; they never block.

${table(warnings, 'HTTP')}

## Proposal statuses

${table(statuses, 'HTTP')}
`;
}

/**
 * Error, warning, and proposal-status tables for the GET-link guide
 * (`/mcp/a/<token>/docs`). Lists every registered code with its channels so
 * the guide matches docs/errors.md.
 */
export function renderGetLinkErrorTable(): string {
  const row = (s: ErrorCodeSpec): string =>
    `| \`${s.code}\` | ${s.status} | ${cell(s.meaning)} | ${cell(s.hint)} | ${s.channels.join(', ')} |`;
  const header = [
    '| Code | HTTP | Meaning | Next step | Channels |',
    '| --- | --- | --- | --- | --- |',
  ];
  const errors = ERROR_REGISTRY.filter(s => s.kind === 'error');
  const warnings = ERROR_REGISTRY.filter(s => s.kind === 'warning');
  const statuses = ERROR_REGISTRY.filter(s => s.kind === 'status');
  return [
    ...header,
    ...errors.map(row),
    '',
    '**Warnings** (in `warnings[]` on a successful propose; never blocking):',
    '',
    ...header,
    ...warnings.map(row),
    '',
    '**Proposal statuses.** Open proposals are closed automatically: ' +
      '`expired` after the configured TTL (default 7 days). Revision changes auto-rebase open proposals; ' +
      '`conflict` blocks approval until resolved. Legacy closed proposals stay closed. ' +
      'Submit, get, and list responses include `autoClosedCount` when that request ' +
      'auto-closed proposals (omitted when zero).',
    '',
    ...header,
    ...statuses.map(row),
  ].join('\n');
}

export const OPENAPI_ERROR_CODES_BEGIN =
  '    # BEGIN GENERATED ERROR CODES (src/plugin/error-registry.ts)';
export const OPENAPI_ERROR_CODES_END = '    # END GENERATED ERROR CODES';

/** `components.schemas.ErrorCode` block for docs/api/openapi.yaml. */
export function renderOpenApiErrorCodes(): string {
  const errors = ERROR_REGISTRY.filter(s => s.kind === 'error');
  const lines = [
    OPENAPI_ERROR_CODES_BEGIN,
    '    ErrorCode:',
    '      type: string',
    '      description: |',
    '        Machine-readable `code` on JSON error bodies. See docs/errors.md.',
    '',
    ...errors.map(s => `        - \`${s.code}\` (${s.status}): ${s.meaning}`),
    '      enum:',
    ...errors.map(s => `        - ${s.code}`),
    OPENAPI_ERROR_CODES_END,
  ];
  return lines.join('\n');
}

/** Replace the generated ErrorCode block inside an OpenAPI YAML document. */
export function applyOpenApiErrorCodes(yaml: string): string {
  const start = yaml.indexOf(OPENAPI_ERROR_CODES_BEGIN);
  const end = yaml.indexOf(OPENAPI_ERROR_CODES_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('OpenAPI generated error-code markers not found');
  }
  return (
    yaml.slice(0, start) +
    renderOpenApiErrorCodes() +
    yaml.slice(end + OPENAPI_ERROR_CODES_END.length)
  );
}
