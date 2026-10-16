/**
 * AI-oriented markdown docs for GET /mcp/a/<token>.
 *
 * Uses relative paths (./status, ./flows, …) so the path token is never
 * reflected into the response body (avoids XSS via content sniffing).
 */

import { MAX_PROPOSAL_JSON_BYTES } from '../../storage/trusted-write.js';
import { MAX_GET_ACCESS_URL_BYTES } from '../access-path.js';
import type { AccessLinkAuthInfo } from '../types.js';

export interface GetLinkDocsContext {
  link: AccessLinkAuthInfo;
  openapiPath: string;
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

function docsAlsoAvailable(rest: string, openapi: string, rpc: string): string {
  return `## Also available (prefer when your client can send headers)

**Prefer MCP or REST** whenever the AI client can send custom headers and JSON
bodies — no URL length limits and no chunked drafts. Use this **GET link
(get_link) only as a fallback** for headerless GET-only clients.

The path token in this URL is **get_link only**. It will **not** work as a
Bearer on REST or MCP. Ask the owner for a separate **rest** or **mcp** token
from the Access links page.

- REST: \`${rest}\` with \`Authorization: Bearer <rest-token>\` (**rest** kind —
  not this path token)
- OpenAPI: \`${openapi}\`
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
      "url": "https://YOUR-NODE-RED/mcp/rpc",
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
      "url": "https://YOUR-NODE-RED/mcp/rpc",
      "headers": {
        "Authorization": "Bearer aia_…"
      }
    }
  }
}
\`\`\`

**ChatGPT connectors / custom GPT:** use Streamable HTTP URL
\`https://YOUR-NODE-RED/mcp/rpc\` and set Authorization Bearer \`aia_…\`
(an **mcp** token).

**Generic Streamable HTTP** (curl):

\`\`\`bash
curl -sS -X POST "https://YOUR-NODE-RED/mcp/rpc" \\
  -H "Authorization: Bearer aia_…" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`
`;
}

function docsIntro(label: string, expires: string): string {
  return `# Node-RED AI Access — self-contained GET link (get_link)${label}

This URL is a **temporary get_link access link** for an AI client that can only
issue **HTTP GET** (no custom headers, no MCP). It is **not** a REST or MCP
Bearer token — those need a separate **rest** or **mcp** token from the owner.
A **human owner** must approve every flow change before it is deployed.

All paths below are **relative to this link URL** (the address you used to open
these docs).

## Expiry

- Link expires at: **${expires}** (ISO-8601)
- After expiry, every path under this link returns \`401 access_link_invalid\`
- Ask the user for a **new** link if you see that error

## What you can do

1. Read status, flows, installed **node-types**, and your own proposals (JSON).
2. Submit a **pending proposal** (does **not** deploy by itself).
3. For large content (e.g. HTML in a \`template\` node), use **chunked drafts**.
4. Search the public palette catalogue (**recommend only** — never installs).

A human reviews proposals on the Node-RED \`/mcp\` page and approves or rejects.
Submit responses include \`title\`, \`displayName\` (\`title ·\` **server-local**
datetime with offset, e.g. \`16 Oct 01:35 +00:00\`), \`reviewUrl\` (absolute when
Host is known), and \`reviewPath\` (relative \`/mcp#proposal=<id>\`).
\`createdAt\` is ISO-8601. **Always tell the user about the proposal using
\`displayName\` + \`reviewUrl\` — not the raw id.**
`;
}

function docsWorkflow(): string {
  return `## Step-by-step workflow

1. \`GET ./status\` — confirm the link works; note \`caller.expiresAt\`.
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

7. Poll \`GET ./proposals\` / \`./proposals/<id>\` until approved or rejected.
   Cite \`displayName\` + \`reviewUrl\` from the response when updating the user.
8. Optional: \`GET ./proposals/<id>/diff\` (default \`format=summary\` compact
   line hunks + byte sizes; \`format=full\` for complete text) against the
   **base snapshot** stored at submit. Added/removed nodes are presence blocks
   with a summary sentence; pending+stale may include \`vsCurrent\`.

**Recommended edit loop:** summary → search → read a line range →
\`replace_text\` → propose.

If another pending proposal shares the same flow + rev, the propose/draft
response includes \`siblingsOnSameRev\` and a warning — approve order may
conflict; prefer one pending change per rev.

## Node types and palette (read-only)

Before proposing unfamiliar nodes:

1. \`GET ./node-types?q=<text>\` — list installed palette types (filter optional;
   results capped; may include \`truncated\` / \`total\`).
2. \`GET ./node-types/<type>\` — detail (properties/defaults, inputs/outputs,
   requiredConfigNodeTypes, short help). \`404 node_type_not_found\` when unknown.
3. \`GET ./palette/search?q=<text>\` — search the public Node-RED catalogue.
   **Recommend only** — ask the user to install via **Manage palette**, then
   recheck \`./node-types\`. This API **never installs** packages.

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
| One node type | \`GET ./node-types/<type>\` |
| Palette search (recommend only) | \`GET ./palette/search?q=\` |
| My proposals | \`GET ./proposals\` |
| One proposal | \`GET ./proposals/<id>\` |
| Proposal diff | \`GET ./proposals/<id>/diff\` |
| Propose (query) | \`GET ./propose?…\` |
| Draft start | \`GET ./draft/new?flow=&rev=&node=&field=&title=\` |
| Draft chunk | \`GET ./draft/<draftId>/append?seq=N&data=<base64url>\` |
| Draft submit | \`GET ./draft/<draftId>/submit?sha256=<hex>&title=\` |

Unknown paths under this link return JSON \`{ "code": "not_found" }\` (never HTML,
and the token is never echoed).
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

function docsErrorsAndAlso(): string {
  return `## Error codes (JSON unless docs)

| Code | Meaning | Next step |
| --- | --- | --- |
| \`access_link_missing\` / \`access_link_invalid\` | Bad or expired link | Ask user for a new link |
| \`url_too_long\` | GET URL over ~8KB | Use drafts or Bearer POST |
| \`version_mismatch\` | Stale \`rev\` | Re-read flows and retry |
| \`node_not_found\` / \`field_not_found\` | Unknown node/field at draft/new or propose | Re-read the flow |
| \`text_not_found\` | \`replace_text\` find had no match | Re-read the field; find is exact |
| \`ambiguous_match\` | \`replace_text\` find matched more than once | Pass \`occurrence\` (1-based) or a unique find |
| \`chunk_conflict\` | Same seq, different data | Re-send identical data or new draft |
| \`draft_hash_mismatch\` / \`missing_chunks\` | Draft incomplete | Fix seqs / sha256 |
| \`payload_too_large\` | Over decoded size cap | Shrink content or use last-resort paste |
| \`rate_limited\` | Too many calls (per IP or per token) | Wait \`retryAfter\` seconds (\`Retry-After\` header) |
| \`unknown_node_type\` | Proposal uses a type not installed | Call \`./node-types\` / \`./palette/search\`; ask user to install via Manage palette |
| \`node_type_not_found\` | Unknown type on \`./node-types/<type>\` | List types or search palette; ask user to install |
| \`not_found\` | Unknown path under this link | Re-read these docs |

All JSON responses use \`Cache-Control: no-store\`. Never put secrets in query
strings you will paste publicly beyond this temporary link.
`;
}

export function renderGetLinkDocs(ctx: GetLinkDocsContext): string {
  const { link, openapiPath, restApiBase, mcpRpcPath } = ctx;
  const expires = escapeForDocs(link.expiresAt);
  const label = link.label ? ` (${escapeForDocs(link.label)})` : '';
  const openapi = escapeForDocs(openapiPath);
  const rest = escapeForDocs(restApiBase);
  const rpc = escapeForDocs(mcpRpcPath);

  return [
    docsIntro(label, expires),
    docsAlsoAvailable(rest, openapi, rpc),
    docsWorkflow(),
    docsUrlTable(),
    docsProposeExamples(),
    docsDrafts(),
    docsLastResortPaste(),
    docsErrorsAndAlso(),
  ].join('\n');
}
