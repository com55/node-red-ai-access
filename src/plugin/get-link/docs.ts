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

function docsIntro(label: string, expires: string): string {
  return `# Node-RED AI Access — self-contained link${label}

This URL is a **temporary access link** for an AI client that can only issue
**HTTP GET** (no custom headers, no MCP). A **human owner** must approve every
flow change before it is deployed.

All paths below are **relative to this link URL** (the address you used to open
these docs).

## Expiry

- Link expires at: **${expires}** (ISO-8601)
- After expiry, every path under this link returns \`401 access_link_invalid\`
- Ask the user for a **new** link if you see that error

## What you can do

1. Read status, flows, and your own proposals (JSON).
2. Submit a **pending proposal** (does **not** deploy by itself).
3. For large content (e.g. HTML in a \`template\` node), use **chunked drafts**.

A human reviews proposals on the Node-RED \`/mcp\` page and approves or rejects.

## Step-by-step workflow

1. \`GET ./status\` — confirm the link works; note \`caller.expiresAt\`.
2. \`GET ./flows\` — list tabs + current \`rev\`.
3. \`GET ./flows/<id>\` — get one tab (\`type\` is always present) + \`rev\`.
4. Propose a small node property change:

\`\`\`
GET ./propose?flow=<flowId>&rev=<rev>&node=<nodeId>&set.<prop>=<urlencoded>&summary=<text>
\`\`\`

5. Or multi-node / add / remove / full tab via base64url JSON patch:

\`\`\`
GET ./propose?flow=<flowId>&rev=<rev>&patch=<base64url-json>
\`\`\`

6. Poll \`GET ./proposals\` / \`./proposals/<id>\` until approved or rejected.
7. Optional: \`GET ./proposals/<id>/diff\` for a structured diff against the
   **base snapshot** stored at submit (not the live flow). Added/removed nodes
   are single presence blocks; pending+stale may include \`vsCurrent\`.
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
| My proposals | \`GET ./proposals\` |
| One proposal | \`GET ./proposals/<id>\` |
| Proposal diff | \`GET ./proposals/<id>/diff\` |
| Propose (query) | \`GET ./propose?…\` |
| Draft start | \`GET ./draft/new?flow=&rev=&node=&field=\` |
| Draft chunk | \`GET ./draft/<draftId>/append?seq=N&data=<base64url>\` |
| Draft submit | \`GET ./draft/<draftId>/submit?sha256=<hex>\` |

Unknown paths under this link return JSON \`{ "code": "not_found" }\` (never HTML,
and the token is never echoed).
`;
}

function docsProposeExamples(): string {
  return `## Propose examples

**Rename a node** (URL-encode values):

\`\`\`
GET ./propose?flow=tab1&rev=abc123&node=n1&set.name=Hello&summary=rename
\`\`\`

**Patch JSON** — node-level ops (\`set\` / \`add\` / \`remove\`):

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

### Field mode (edit one existing property)

1. \`GET ./draft/new?flow=tab1&rev=abc&node=n1&field=template\`
   → validates that \`node\`/\`field\` exist **before** upload; returns \`{ draftId }\`
2. Split the UTF-8 field bytes, base64url-encode each chunk, upload in order:
   \`GET ./draft/<draftId>/append?seq=0&data=…\`
   (idempotent per \`seq\`; response lists \`missingSeqs\`)
3. \`GET ./draft/<draftId>/submit?sha256=<sha256-hex-of-assembled-bytes>\`
   → creates a pending proposal after hash verification

### JSON mode (\`mode=json\`) — add / remove / multi-edit

Omit \`node\`/\`field\` (or pass \`mode=json\`) and assemble a **JSON document**
with the same shapes as \`patch\` above, then submit:

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
\`draft/new\` does not require an existing \`node\`/\`field\`.
`;
}

function docsErrorsAndAlso(rest: string, openapi: string, rpc: string): string {
  return `## Error codes (JSON unless docs)

| Code | Meaning | Next step |
| --- | --- | --- |
| \`access_link_missing\` / \`access_link_invalid\` | Bad or expired link | Ask user for a new link |
| \`url_too_long\` | GET URL over ~8KB | Use drafts or Bearer POST |
| \`version_mismatch\` | Stale \`rev\` | Re-read flows and retry |
| \`node_not_found\` / \`field_not_found\` | Unknown node/field at draft/new or propose | Re-read the flow |
| \`chunk_conflict\` | Same seq, different data | Re-send identical data or new draft |
| \`draft_hash_mismatch\` / \`missing_chunks\` | Draft incomplete | Fix seqs / sha256 |
| \`payload_too_large\` | Over decoded size cap | Shrink content |
| \`rate_limited\` | Too many calls | Wait and retry |
| \`not_found\` | Unknown path under this link | Re-read these docs |

All JSON responses use \`Cache-Control: no-store\`. Never put secrets in query
strings you will paste publicly beyond this temporary link.

## Also available (if your client can send headers)

- REST: \`${rest}\` with \`Authorization: Bearer <token>\`
- OpenAPI: \`${openapi}\`
- MCP Streamable HTTP: \`POST ${rpc}\`
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
    docsUrlTable(),
    docsProposeExamples(),
    docsDrafts(),
    docsErrorsAndAlso(rest, openapi, rpc),
  ].join('\n');
}
