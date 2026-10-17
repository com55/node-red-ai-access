/**
 * AI-oriented markdown docs for GET /mcp/a/<token>.
 *
 * Uses relative paths (./status, ./flows, …) so the path token is never
 * reflected into the response body (avoids XSS via content sniffing).
 */

import { MAX_PROPOSAL_JSON_BYTES } from '../../storage/trusted-write.js';
import { MAX_GET_ACCESS_URL_BYTES } from '../access-path.js';
import { renderGetLinkErrorTable } from '../error-registry.js';
import type { AccessLinkAuthInfo } from '../types.js';

export interface GetLinkDocsContext {
  link: AccessLinkAuthInfo;
  openapiPath: string;
  /**
   * Public origin (configured `publicBaseUrl`, else validated request origin);
   * replaces the snippet placeholder when known.
   */
  publicOrigin?: string | undefined;
  restApiBase: string;
  mcpRpcPath: string;
}

/** Escape HTML-special characters for safe embedding in text/markdown responses. */
export function escapeForDocs(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Placeholder MCP URL in client snippets when the public origin is unknown. */
export const DEFAULT_RPC_URL_PLACEHOLDER = 'https://YOUR-NODE-RED/mcp/rpc';

function docsAlsoAvailable(
  rest: string,
  openapi: string,
  rpc: string,
  rpcUrl: string = DEFAULT_RPC_URL_PLACEHOLDER
): string {
  return `## Also available (prefer when your client can send headers)

**Prefer MCP or REST** whenever the AI client can send custom headers and JSON
bodies — no URL length limits and no chunked drafts. Use this **GET link
(get_link) only as a fallback** for headerless GET-only clients.

The path token in this URL is **get_link only**. It will **not** work as a
Bearer on REST or MCP. Ask the owner for a separate **rest** or **mcp** token
from the Access links page (\`/mcp\` → Access links → create \`kind=rest\` or
\`kind=mcp\`).

**What to tell the user** (copy/paste when you get \`wrong_token_kind\`):
> Please open Node-RED → /mcp → Access links and create a kind=rest or kind=mcp
> token (or a get_link URL if that is what I asked for), then send it to me.

- REST: \`${rest}\` with \`Authorization: Bearer <rest-token>\` (**rest** kind —
  not this path token)
- OpenAPI: \`${openapi}\` (JSON: \`${openapi.replace(/\.yaml$/, '.json')}\`)
- MCP Streamable HTTP: \`POST ${rpc}\` with \`Authorization: Bearer <mcp-token>\`
  (**mcp** kind — not this path token)

### MCP client config snippets

Replace placeholders — never paste real personal URLs into shared docs.
Use an **mcp** token from the owner (not the get_link path token).

**Claude Desktop** (\`claude_desktop_config.json\` → \`mcpServers\`):

\`\`\`json
{
  "mcpServers": {
    "node-red-ai-access": {
      "url": "${rpcUrl}",
      "headers": {
        "Authorization": "Bearer aia_…"
      }
    }
  }
}
\`\`\`

**Cursor** (\`mcp.json\` style):

\`\`\`json
{
  "mcpServers": {
    "node-red-ai-access": {
      "url": "${rpcUrl}",
      "headers": {
        "Authorization": "Bearer aia_…"
      }
    }
  }
}
\`\`\`

**ChatGPT connectors / custom GPT:** use Streamable HTTP URL
\`${rpcUrl}\` and set Authorization Bearer \`aia_…\`
(an **mcp** token).

**Generic Streamable HTTP** (curl):

\`\`\`bash
curl -sS -X POST "${rpcUrl}" \\
  -H "Authorization: Bearer aia_…" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`
`;
}

function docsIntro(label: string, expires: string): string {
  return `# Node-RED AI Access — self-contained GET link (get_link)${label}

**Git mental model:** a proposal is like a pull request. Human approve = merge;
reject = close; withdraw = you close your own PR. If \`rev\`/\`expectedRev\` does
not match, treat it as a conflict: re-read the flow, rebase the edit, and
resubmit. Every access link can see all proposals (\`mine: true|false\`).

**Which channel to use:** prefer **MCP** (\`/mcp/rpc\` + mcp Bearer) or **REST**
(\`/mcp/api/v1\` + rest Bearer) when your client can send headers and JSON —
use this **GET link** only as a fallback for headerless GET-only clients.

This URL is a **temporary get_link** path-token link. It is **not** a REST or
MCP Bearer — ask the owner for a separate **rest** or **mcp** token when needed.
A **human owner** must approve every flow change before it is deployed.

All paths below are **relative to this link URL** (the address you used to open
these docs).

## Response content type

Responses on GET links default to text/plain so web readers used by AI chat apps accept them; request the real type via Accept or ?format=
(\`Accept: text/markdown\` or \`?format=md\` for this guide; \`Accept: application/json\`
or \`?format=json\` for JSON). Bodies and status codes are the same either way.

## Expiry

- Link expires at: **${expires}** (ISO-8601); \`GET ./status\` also reports
  \`caller.minutesRemaining\` (rounded up) and \`caller.secondsRemaining\`
- After expiry, every path under this link returns \`401 token_expired\` with
  \`expiredAt\` and \`accessLinksUrl\` (the /mcp page → Access links section)
- Ask the user for a **new** link there if you see that error (or \`access_link_invalid\`)

## What you can do

1. Read status, flows, installed **node-types**, and your own proposals (JSON).
2. Submit a **pending proposal** (does **not** deploy by itself).
3. For large content (e.g. HTML in a \`template\` node), use **chunked drafts**.
4. Search the public palette catalogue (**recommend only** — never installs).

## What you cannot do

- **Create / mint tokens** — this GET link **cannot** create access tokens.
  There is no \`./links\` create operation under \`/mcp/a/<token>\`. Only a human
  admin with \`*\` may mint tokens via \`POST /mcp/api/v1/links\` on the \`/mcp\`
  Access links page. Attempts under this URL return \`403 link_create_not_supported\`.
- Approve or reject proposals (human on \`/mcp\` only).
- Use this path token as a REST or MCP Bearer (wrong kind — need separate tokens).

A human reviews proposals on the Node-RED \`/mcp\` page and approves or rejects.
Submit responses include \`title\` (display title; \` in <flow>\` is appended
when it does not name the flow), \`storedTitle\` (the title as saved: your title without the
\` in <flow>\` suffix, or the auto-generated title, which may already name the flow),
\`flowLabel\`, \`displayName\` (\`title ·\` **server-local**
datetime with offset, e.g. \`16 Oct 01:35 +00:00\`), \`reviewUrl\` (absolute when
Host is known), and \`reviewPath\` (relative \`/mcp#proposal=<id>\`).
\`createdAt\` is ISO-8601. **Always tell the user about the proposal using
\`displayName\` + \`reviewUrl\` — not the raw id.**

### GET propose response shape (differs from REST/MCP)

\`GET ./propose\` returns a **wrapper** object:

\`\`\`json
{ "ok": true, "proposal": { /* lean proposal fields */ }, "hint": "…", "conflictingProposals": [] }
\`\`\`

REST \`POST /proposals\` and MCP \`submit_proposal\` return the **proposal
fields at the top level** (no \`ok\` / \`proposal\` wrapper). Read
\`response.proposal\` on GET; read the body itself on REST/MCP.

Lean by default (no \`payload\` / \`baseFlow\`). Pass
\`?include=payload,baseFlow\` or \`?include_payload=true\` to include them.
`;
}

function docsWorkflow(): string {
  return `## Step-by-step workflow

1. \`GET ./status\` — confirm the link works; note \`caller.expiresAt\` /
   \`caller.minutesRemaining\`.
2. \`GET ./flows\` — list tabs + current \`rev\`.
3. **Layered read (prefer this before loading whole tabs):**
   - \`GET ./flows/<id>?summary=1\` — node list with \`id\`/\`type\`/\`name\`/\`wires\` +
     per-node \`bytes\` (no field contents).
   - \`GET ./search?q=<text>&flow=<id>\` — hits with node id, field, line numbers,
     short snippet (\`truncated:true\` when the result cap is hit).
   - \`GET ./nodes/<id>\` — one full node (\`flowId\` included when known).
   - \`GET ./nodes/<id>/field/<name>?lines=A-B\` — one field (optional 1-based
     line range) plus \`totalLines\` and \`bytes\`.
4. Prefer a **targeted text replace** for small edits inside long string fields
   (\`template\`, \`func\`, …) — unique \`find\` (or \`occurrence\`) keeps the diff short:

\`\`\`
GET ./propose?flow=<flowId>&rev=<rev>&node=<nodeId>&field=<prop>&find=<text>&replace=<text>&occurrence=<n>&title=<text>
\`\`\`

5. Or set whole properties (optional \`title\` ≤80 chars; \`summary\` is a title fallback):

\`\`\`
GET ./propose?flow=<flowId>&rev=<rev>&node=<nodeId>&set.<prop>=<urlencoded>&title=<text>
\`\`\`

6. Or multi-node / add / remove / \`replace_text\` / full tab via base64url JSON patch:

\`\`\`
GET ./propose?flow=<flowId>&rev=<rev>&patch=<base64url-json>&title=<text>
\`\`\`

7. Poll \`GET ./proposals\` / \`./proposals/<id>\` until approved, rejected, or
   withdrawn. Every token can list/read **all** proposals; each item has
   \`mine:true|false\`. Filter with \`?mine=true\` (own) or \`?mine=false\` (others'),
   \`?status=pending,superseded\` (comma-separated or repeated), \`?flowId=\`;
   paginate with \`?limit=\` (1–200) / \`?offset=\` (response includes \`total\`,
   \`offset\`, \`hasMore\`, and \`nextOffset\` when more remain). Invalid filters
   return \`400 invalid_filter\` naming the parameter. Cite \`displayName\` +
   \`reviewUrl\` when updating the user.
8. Optional: \`GET ./proposals/<id>/diff\` (default \`format=summary\` compact
   line hunks + byte sizes; \`format=full\` for complete text) against the
   **base snapshot** stored at submit. Added/removed nodes are presence blocks
   with a summary sentence; pending+stale may include \`vsCurrent\`.
9. Withdraw your own pending proposal:
   \`GET ./proposals/<id>/withdraw?confirm=1&reason=<text>\` (status becomes \`withdrawn\`,
   not \`rejected\`).

**Recommended edit loop:** summary → search → read a line range →
\`replace_text\` → propose.

On submit and on read of a pending proposal, the response may include
\`conflictingProposals\` (same-rev or overlapping pending work; list omits this) with
\`overlappingNodeIds\` / \`overlappingFields\` when detectable — treat like a
git conflict warning; prefer one pending change per flow when possible.

## Node types and palette (read-only)

Before proposing unfamiliar nodes:

1. \`GET ./node-types?q=<text>\` — list installed palette types (filter optional;
   results capped; may include \`truncated\` / \`total\`).
2. \`GET ./node-types/<type>\` — detail (\`defaults\` as JSON, \`inputs\`/\`outputs\`,
   \`requiredConfigNodeTypes\`, help sections). Pass \`?help=0\` to omit help.
   Types are **case-sensitive** (\`Debug\` → did you mean \`debug\`?).
3. \`GET ./palette/search?q=<text>\` — search the public Node-RED catalogue.
   **Recommend only** — ask the user to install via **Manage palette**, then
   recheck \`./node-types\`. This API **never installs** packages.
   Core \`node-red\` types are **not** in the catalogue — use \`./node-types\`.

Submit/propose with an unknown \`node.type\` returns \`400 unknown_node_type\`
with \`nearest\` suggestions — call node-types / palette search and ask the user
to install the module, then retry.
`;
}

function docsUrlTable(): string {
  return `## Exact URLs for this token (relative)

| Purpose | Method + path |
| --- | --- |
| These docs | \`GET ./\` (this URL) |
| Status | \`GET ./status\` |
| List flows | \`GET ./flows\` |
| One flow | \`GET ./flows/<id>\` |
| Flow summary (no field bodies) | \`GET ./flows/<id>?summary=1\` |
| One node | \`GET ./nodes/<id>\` |
| One field (optional lines) | \`GET ./nodes/<id>/field/<name>?lines=A-B\` |
| Text search | \`GET ./search?q=&flow=\` |
| List node types | \`GET ./node-types?q=\` |
| One node type | \`GET ./node-types/<type>\` (\`?help=0\` omits help) |
| Palette search (recommend only) | \`GET ./palette/search?q=\` |
| All proposals (\`?mine=\` / \`?status=\` / \`?flowId=\` / \`?limit=\` / \`?offset=\`) | \`GET ./proposals\` |
| One proposal | \`GET ./proposals/<id>\` |
| Proposal diff | \`GET ./proposals/<id>/diff\` |
| Withdraw own pending | \`GET ./proposals/<id>/withdraw?confirm=1&reason=\` |
| Propose (query) | \`GET ./propose?…\` |
| Draft start | \`GET ./draft/new?flow=&rev=&node=&field=&title=\` |
| Draft chunk | \`GET ./draft/<draftId>/append?seq=N&data=<base64url>\` |
| Draft submit | \`GET ./draft/<draftId>/submit?sha256=<hex>&title=\` |

There is **no** \`POST ./links\` (or any create-link) under this URL — GET links
**cannot mint tokens**.

Unknown paths under this link return JSON \`{ "code": "not_found" }\` (never HTML,
and the token is never echoed). Attempted mint paths (\`./links\`) return
\`403 link_create_not_supported\`.
`;
}

function docsProposeExamples(): string {
  return `## Propose examples

**Recommended for small edits to long fields** — \`replace_text\` (find must be
**unique** unless you pass \`occurrence\` as a 1-based index). Creates a normal
pending proposal with a short readable diff:

\`\`\`
GET ./propose?flow=tab1&rev=abc123&node=n1&field=template&find=Hello&replace=Hi&title=Tweak%20greeting
\`\`\`

Errors: \`400 text_not_found\`; \`409 ambiguous_match\` (body includes \`matchCount\`).

Same op in patch JSON (multiple \`replace_text\` ops apply **in order**):

\`\`\`json
{
  "nodes": [
    { "op": "replace_text", "node": "n1", "field": "func", "find": "oldFn()", "replace": "newFn()" },
    { "op": "replace_text", "node": "n1", "field": "func", "find": "TODO", "replace": "done", "occurrence": 2 }
  ]
}
\`\`\`

REST / MCP \`submit_proposal\` can send the same ops without a full tab:

\`\`\`json
{
  "type": "replace_flow",
  "expectedRev": "abc123",
  "title": "Tweak greeting",
  "payload": {
    "flowId": "tab1",
    "nodes": [
      { "op": "replace_text", "node": "n1", "field": "template", "find": "Hello", "replace": "Hi" }
    ]
  }
}
\`\`\`

**Rename a node** (URL-encode values):

\`\`\`
GET ./propose?flow=tab1&rev=abc123&node=n1&set.name=Hello&title=Rename%20inject
\`\`\`

**Patch JSON** — node-level ops (\`set\` / \`add\` / \`remove\` / \`replace_text\`):

\`\`\`json
{
  "nodes": [
    { "op": "set", "id": "n1", "set": { "name": "Hi" } },
    { "op": "add", "node": { "id": "n3", "type": "debug", "z": "tab1", "name": "out", "wires": [[]] } },
    { "op": "remove", "id": "n2" }
  ]
}
\`\`\`

Legacy set without \`op\` still works: \`{"nodes":[{"id":"n1","set":{"name":"Hi"}}]}\`.

Base64url-encode that JSON and call:

\`\`\`
GET ./propose?flow=tab1&rev=abc123&patch=<base64url>
\`\`\`

**Full tab replace** (when you need a complete \`flow\` object):

\`\`\`json
{
  "type": "replace_flow",
  "flowId": "tab1",
  "flow": { "id": "tab1", "type": "tab", "label": "Main", "nodes": [ /* full list */ ] }
}
\`\`\`

Node-level proposes create a normal \`replace_flow\` proposal; owners should
approve with deployment type **\`nodes\`** (plugin default) so only changed
nodes deploy.
`;
}

function docsDrafts(): string {
  return `## Chunked drafts (long HTML / large fields)

When the GET URL would exceed **${MAX_GET_ACCESS_URL_BYTES} bytes**, do not
stuff everything into \`propose\`. Use drafts (expire after **30 minutes**,
max **${MAX_PROPOSAL_JSON_BYTES}** decoded bytes):

### Recommended chunk size

- Split the **raw UTF-8** payload into chunks of about **4–5 KB** each.
- Base64url encoding adds roughly **33%**; keep each request URL under ~**8 KB**.
- \`append\` reports \`totalBytes\` as **decoded** bytes vs \`maxBytes\`.

### Field mode (replace one named string field)

Field-mode drafts **replace the entire named string field** (e.g. \`template\`,
\`func\`) with the assembled bytes — they do **not** merge partial edits. Use
when the GET URL cannot hold the whole new field value.

1. \`GET ./draft/new?flow=tab1&rev=abc&node=n1&field=template\`
   → validates that \`node\`/\`field\` exist **before** upload; returns \`{ draftId }\`
2. Split the UTF-8 field bytes, base64url-encode each chunk, upload in order:
   \`GET ./draft/<draftId>/append?seq=0&data=…\`
   (idempotent per \`seq\`; response lists \`missingSeqs\`)
3. \`GET ./draft/<draftId>/submit?sha256=<sha256-hex-of-assembled-bytes>\`
   → creates a pending proposal after hash verification

For **small edits** inside a large field, prefer \`replace_text\` / \`./propose\`
(find+replace) instead of uploading the whole field via drafts.

### JSON mode (\`mode=json\`) — structural / multi-node changes

Omit \`node\`/\`field\` (or pass \`mode=json\`) and assemble a **JSON document**
with the same shapes as \`patch\` above (add / remove / set / \`replace_text\` /
full tab), then submit:

\`\`\`json
{
  "nodes": [
    { "op": "set", "id": "n1", "set": { "template": "<html>…</html>" } },
    { "op": "add", "node": { "id": "n9", "type": "template", "z": "tab1", "template": "…", "wires": [[]] } },
    { "op": "remove", "id": "n2" }
  ]
}
\`\`\`

Or a full \`replace_flow\` document. JSON-mode drafts **may add nodes**, so
\`draft/new\` does not require an existing \`node\`/\`field\`. Use JSON mode for
structural changes; use field-mode only when you need to replace one whole
string field that is too large for a single propose URL.
`;
}

function docsLastResortPaste(): string {
  return `## Last resort: content larger than chunked drafts

If the field is still too large for chunked drafts (decoded size over the
proposal cap), use this fallback only after drafts fail:

1. Propose the node with **empty or short placeholder** content (via
   \`set.<field>=\` / patch \`set\` / a tiny draft) and tell the user clearly.
2. The human **approves and deploys** that placeholder proposal on \`/mcp\`.
3. You then give the user the **full content to paste** into the node in the
   Node-RED editor.

**Trade-off:** pasted content is **not** reviewed through the proposal diff.
Prefer \`replace_text\` or chunked drafts whenever they fit so the human can
still see a readable change on \`/mcp\`.
`;
}

function docsRestNodesPayload(): string {
  return `## Size cap and REST/MCP nodes payload shapes

The proposal JSON cap is **${MAX_PROPOSAL_JSON_BYTES} bytes**
(\`MAX_PROPOSAL_JSON_BYTES\` / ~1.5MB) on **every** channel: GET propose/drafts,
REST \`POST /proposals\`, and MCP \`submit_proposal\`. Oversized bodies return
\`413 payload_too_large\` (never truncated).

### Canonical REST/MCP nodes ops (preferred)

Send \`type: "replace_flow"\`, top-level \`expectedRev\`, and
\`payload: { flowId, nodes: [...] }\` (no \`payload.flow\`). The server loads
the live tab at \`expectedRev\` and applies ops in order.

Supported ops:

| op | Required fields |
| --- | --- |
| \`replace_text\` | \`node\`, \`field\`, \`find\`, \`replace\` (\`occurrence\` 1-based optional) |
| \`set\` | \`id\` + \`set\` object, **or** \`op:"set"\` + \`id\` + properties |
| \`add\` | \`node\` object with \`id\` + \`type\` |
| \`remove\` | \`id\` |

Example (canonical):

\`\`\`json
{
  "type": "replace_flow",
  "expectedRev": "<rev>",
  "payload": {
    "flowId": "tab1",
    "nodes": [
      {
        "op": "replace_text",
        "node": "n1",
        "field": "template",
        "find": "Hello",
        "replace": "Hi"
      }
    ]
  }
}
\`\`\`

**Alternative (also accepted):** top-level \`nodes\` array as an alias for
\`payload.nodes\` (same op shapes). Full-tab replace remains supported via
\`payload.flow\` (from \`GET ./flows/<id>\` / REST \`GET /flows/{id}\`).
`;
}

function docsKnownIssues(): string {
  return `## Known issues

- **Rate limits are per token (and per IP).** Each access-link token has its own
  token bucket. Several tokens can each use the full per-token limit at the same
  time; the shared IP bucket still applies across them.
- **\`RateLimit-*\` headers describe the per-token bucket** (default
  \`RateLimit-Policy: 300;w=60\`) on token requests; requests without a token
  report the per-IP bucket (\`600;w=60\`). Both are enforced.
`;
}

function docsErrorsAndAlso(): string {
  return `## Error codes (JSON unless docs)

${renderGetLinkErrorTable()}

All JSON responses use \`Cache-Control: no-store\`. Never put secrets in query
strings you will paste publicly beyond this temporary link.
`;
}

export function renderGetLinkDocs(ctx: GetLinkDocsContext): string {
  const { link, openapiPath, restApiBase, mcpRpcPath, publicOrigin } = ctx;
  const expires = escapeForDocs(link.expiresAt);
  const label = link.label ? ` (${escapeForDocs(link.label)})` : '';
  const openapi = escapeForDocs(openapiPath);
  const rest = escapeForDocs(restApiBase);
  const rpc = escapeForDocs(mcpRpcPath);

  return [
    docsIntro(label, expires),
    docsAlsoAvailable(
      rest,
      openapi,
      rpc,
      publicOrigin ? escapeForDocs(`${publicOrigin}${mcpRpcPath}`) : DEFAULT_RPC_URL_PLACEHOLDER
    ),
    docsWorkflow(),
    docsUrlTable(),
    docsProposeExamples(),
    docsRestNodesPayload(),
    docsDrafts(),
    docsLastResortPaste(),
    docsKnownIssues(),
    docsErrorsAndAlso(),
  ].join('\n');
}
