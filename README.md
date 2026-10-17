# Node-RED AI Access

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/com55/node-red-ai-access/actions/workflows/ci.yml/badge.svg)](https://github.com/com55/node-red-ai-access/actions)

Temporary, owner-approved Node-RED access for AI clients. Ships as a **Node-RED
4.x+ plugin** with:

- an admin page at `/mcp`
- a versioned REST API under `/mcp/api/v1`
- an MCP JSON-RPC endpoint at `/mcp/rpc` (Streamable HTTP) over the same
  services

**Git mental model:** a proposal is like a pull request. Human approve = merge;
reject = close; withdraw = the author closes their own PR. If `rev` /
`expectedRev` does not match, treat it as a conflict: re-read the flow, rebase
the edit, and resubmit. Every access link can see all proposals
(`mine: true|false`).

Derived from
[ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp).

## Install (Node-RED plugin)

Requirements: **Node-RED 4.x or newer**, Node.js 20+, and **`adminAuth`
enabled** (recommended). Without `adminAuth`, AI features stay off unless you
opt in (see Configuration).

1. Install into your Node-RED user directory (or via the palette):

   ```bash
   cd ~/.node-red
   npm install @com55/node-red-ai-access
   ```

2. Restart Node-RED.
3. Log in to the editor, then open **`/mcp`** on the admin root (for example
   `http://localhost:1880/mcp`, or `{httpAdminRoot}/mcp` when `httpAdminRoot` is
   set).

The `/mcp` HTML shell is served without adminAuth so the page can read the
editor token from browser `localStorage` (Node-RED does not use cookies) and
call APIs with `Authorization: Bearer`. If no valid token is present, the page
redirects to the editor login. All data and actions stay behind permission
checks.

On `/mcp` you can create access links, review proposals (with a readable
node/property diff against the live flow), approve or reject changes, and read a
human-readable audit log. Users with `read` (including guest, if configured) get
a read-only view; only users with `*` can create/revoke links and approve/reject
proposals.

## Configuration

In `settings.js`:

```js
module.exports = {
  // adminAuth: { ... }, // required for AI features in normal setups
  aiAccess: {
    // Master switch (default: true). Also editable in the editor sidebar tab.
    enabled: true,
    // Local-only opt-in when adminAuth is disabled (default: false)
    allowWithoutAdminAuth: false,
    // Access-link default TTL in seconds (default: 14400 = 4h)
    defaultLinkTtlSeconds: 14400,
    // Max concurrent active access links (default: 10)
    maxActiveLinks: 10,
    // Deploy type used on approve (default: "nodes"; also "flows" | "full")
    defaultDeploymentType: 'nodes',
    // In-memory rate limits for /mcp/api and /mcp/a (per IP + per access token)
    rateLimitWindowMs: 60000,
    rateLimitMaxPerIp: 600,
    rateLimitMaxPerToken: 300,
    // Public base URL for absolute links (access-link url, reviewUrl,
    // accessLinksUrl). Set this behind a TLS-terminating proxy (default: unset)
    // publicBaseUrl: 'https://nodered.example.com',
    // Browser origins allowed to call /mcp/a, /mcp/api, and /mcp/rpc
    // cross-origin (default: none — no CORS headers are sent)
    // corsAllowedOrigins: ['https://app.example.com'],
  },
};
```

### Absolute URLs behind a reverse proxy

Access-link `url`, proposal `reviewUrl`, and `accessLinksUrl` (in
`token_expired`) are absolute URLs built by one shared helper:

1. `aiAccess.publicBaseUrl`, when set, is used as-is (scheme, host, and an
   optional path prefix). It is read from `settings.js` only.
2. Otherwise, when Express `trust proxy` is enabled (for example
   `httpServerOptions: { 'trust proxy': true }`), the first `X-Forwarded-Proto`
   and `X-Forwarded-Host` values are used.
3. Otherwise the request `Host` header and the connection protocol are used;
   `X-Forwarded-*` headers are ignored so clients cannot spoof link origins.

Forwarded and `Host` values are validated: the scheme must be `http` or `https`
(else the connection scheme is used) and the host must be a DNS name, IPv4, or
bracketed IPv6 literal with an optional port. An invalid forwarded host falls
back to `Host`; an invalid `Host` yields relative paths. The MCP client snippets
in the GET-link guide use the same origin, and show a `https://YOUR-NODE-RED`
placeholder only when no origin can be determined.

Behind a TLS-terminating proxy (for example Cloudflare) with neither option set,
links therefore start with `http://`.

### CORS

CORS only affects code running in a browser (a web page calling the plugin from
another origin). Server-side AI fetchers and agents (for example Gemini,
ChatGPT, or an MCP client running outside a browser) ignore CORS and are not
affected by this setting.

By default the AI-facing endpoints (`/mcp/a/*`, `/mcp/api/*`, `/mcp/rpc`) send
**no** CORS headers, overriding Node-RED's built-in
`Access-Control-Allow-Origin: *` for those paths. To allow a browser app, list
its origin in `aiAccess.corsAllowedOrigins` (`settings.js` only, restart
required). For a listed `Origin` the response echoes it in
`Access-Control-Allow-Origin` with `Vary: Origin`, and `OPTIONS` preflight
returns `204` with allowed methods (`GET, POST, DELETE, OPTIONS`) and headers
(`Authorization`, `Content-Type`, `Accept`, `Mcp-Session-Id`,
`Mcp-Protocol-Version`, `Last-Event-ID`). Origins match case-insensitively and
the configured origin is echoed; malformed origins are rejected. Exposed headers
include `Mcp-Session-Id`, `WWW-Authenticate`, `Retry-After`, and the
`RateLimit*` headers. Other origins get no CORS headers.

### Settings precedence

Effective values are resolved **without restart** in this order (highest wins):

1. **Disk** — `<userDir>/.ai-access/settings.json` (editor sidebar **AI Access**
   tab, or `PUT /mcp/api/v1/settings`)
2. **`settings.js`** — `aiAccess` block (install / bootstrap defaults)
3. **Built-in defaults** — as documented above

Only keys present on disk override; omitted keys fall through to `settings.js`,
then defaults. The editor right-hand sidebar tab (**AI Access**, next to
Information / Help / Debug / Configuration nodes / Context Data) lets `*` admins
change enable/disable, default deploy type, and default access-link TTL; `read`
users see the same values read-only. A button opens the `/mcp` page. When
`adminAuth` is off, the tab exposes the `allowWithoutAdminAuth` opt-in with a
clear local-only warning.

Storage lives under **`<userDir>/.ai-access`** (`settings.json`,
`proposals/*.json`, and append-only `logs/audit.jsonl`). Directories use mode
`0700`, files `0600`. Proposal JSON is capped at **1_500_000 bytes**; oversized
proposal JSON or audit lines return HTTP **413** with `code: payload_too_large`
(never silently truncated). Malformed JSON returns **400** JSON (REST
`invalid_json`, MCP JSON-RPC `-32700`) — never HTML stack traces (middleware is
attached to the editor-api app that owns body-parser, not only the nested plugin
`httpAdmin`). Unauthenticated `/mcp/api/v1` admin calls return JSON
`{ code: "auth_required" }` rather than plain-text `Unauthorized`.

## Docs

- [Channel index](docs/README.md) — GET link / REST / MCP overview
- [MCP client setup](docs/mcp-clients.md) — Claude Desktop, Cursor, VS Code, CLI
- [MCP tools reference](docs/mcp-tools.md) — generated from live `tools/list`
- [Error codes](docs/errors.md) — code, status, hint, channels
- [OpenAPI 3.1](docs/api/openapi.yaml) — also `GET /mcp/api/v1/openapi.yaml`
  (JSON: `GET /mcp/api/v1/openapi.json`)

Regenerate the MCP tools doc after tool changes: `yarn generate:mcp-tools`.

## REST API

OpenAPI: **`GET /mcp/api/v1/openapi.yaml`** or
**`GET /mcp/api/v1/openapi.json`** (also in
[`docs/api/openapi.yaml`](docs/api/openapi.yaml)).

| Path                                     | Purpose                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `GET /mcp`                               | Admin UI (status, links, proposals, audit log)   |
| `GET /mcp/a/<token>`                     | Self-contained GET link (markdown docs)          |
| `GET /mcp/a/<token>/…`                   | Token-scoped GET status/flows/propose/drafts     |
| `POST /mcp/rpc`                          | MCP Streamable HTTP (access-link Bearer; tools)  |
| `GET /mcp/api/v1`                        | Discovery index (no auth; endpoints + auth hint) |
| `GET /mcp/api/v1/openapi.yaml`           | OpenAPI 3.1 specification (YAML)                 |
| `GET /mcp/api/v1/openapi.json`           | OpenAPI 3.1 specification (JSON)                 |
| `GET /mcp/api/v1/status`                 | Plugin status JSON (admin or access link)        |
| `GET /mcp/api/v1/settings`               | Effective AI Access settings (admin `read`)      |
| `PUT /mcp/api/v1/settings`               | Update settings (`*`; persists to disk, hot)     |
| `GET /mcp/api/v1/links`                  | List active access links (`*` only)              |
| `POST /mcp/api/v1/links`                 | Create access link (`*` only; token once)        |
| `DELETE /mcp/api/v1/links/:id`           | Revoke access link (`*` only)                    |
| `GET /mcp/api/v1/flows`                  | List flows + rev (admin `read` or access link)   |
| `GET /mcp/api/v1/flows/:id`              | Get one flow + rev (admin `read` or access link) |
| `POST /mcp/api/v1/proposals`             | Create proposal (access-link Bearer only)        |
| `GET /mcp/api/v1/proposals`              | List proposals (admin: all; link: own)           |
| `GET /mcp/api/v1/proposals/:id`          | Get proposal (admin: any; link: own)             |
| `GET /mcp/api/v1/proposals/:id/diff`     | Diff proposal vs current flow (admin `read`/own) |
| `POST /mcp/api/v1/proposals/:id/approve` | Approve + deploy (`*`; optional deploymentType)  |
| `POST /mcp/api/v1/proposals/:id/reject`  | Reject with reason (`*`; no flow mutate)         |
| `GET /mcp/api/v1/logs`                   | Append-only audit log (admin `read`)             |

### MCP JSON-RPC (`POST /mcp/rpc`)

AI clients can use the official MCP Streamable HTTP transport against
`{httpAdminRoot}/mcp/rpc` with the same access-link Bearer token as the REST
API. Tools mirror the AI-facing REST surface only:

`get_status`, `list_flows`, `get_flow`, `submit_proposal` (including
`replace_flow` with `expectedRev`; `expected_rev` accepted as alias; optional
`title` ≤80 chars), `list_proposals` (alias `list_my_proposals`),
`get_proposal`. Tool descriptions document purpose, inputs, returns, and when to
use them. Proposal create/list/get responses include `title`, `displayName`
(`title ·` **server-local** datetime with explicit offset, e.g.
`16 Oct 01:35 +00:00`), `reviewUrl` (absolute URL using the request
Host/protocol — `X-Forwarded-*` only when Express `trust proxy` is set), and
`reviewPath` (relative `/mcp#proposal=<id>`). `createdAt` remains ISO-8601. The
`/mcp` page renders times in the browser's local timezone. AI clients should
refer to proposals by `displayName` + `reviewUrl`, not the raw id. For
access-link callers, `get_status` reports `permission: null` and
`caller.kind: "access-link"` (expected — AI tokens are not admin sessions).

Approve, reject, and access-link management stay human-only on the `/mcp` admin
page (and the corresponding REST routes). Rate limits, payload size limits, and
audit logging match REST. Missing tokens return **401** `access_link_missing`;
known-expired tokens return **401** `token_expired`; other invalid/revoked
tokens return **401** `access_link_invalid` (all with `WWW-Authenticate`)
telling the AI to ask the user for a new access link. Every error JSON includes
a `code`. `token_expired` also includes `expiredAt` and `accessLinksUrl` (the
`/mcp` page's Access links section). Access-link `/status` includes `expiresAt`,
`minutesRemaining` (rounded up), and `secondsRemaining`. See `docs/errors.md`
(generated from `src/plugin/error-registry.ts`).

Access links are **in memory** (default TTL **4h**, max 10). Caps: **get_link ≤
24h**, **rest/mcp ≤ 30d**. Creating a link returns the raw `token` plus a
self-contained `url` for `get_link` (`/mcp/a/<token>`). While the link remains
active, `GET /links` includes `url` again so admins can re-copy from `/mcp` (the
raw `token` field stays create-only). After a restart every old token is
invalid.

Call `list_flows` or `get_flow` first and pass the returned `rev` as
`expectedRev`. Submit checks the live rev (**409** if stale). Approve may send
`deploymentType`: `nodes` (default), `flows`, or `full`. A stale `expectedRev`
at approve marks the proposal **rejected** with a resubmit message; other deploy
errors mark it **failed**. Reject never mutates flows.

### Flow runtime adapter

- **RedAdapter** — in-process flows API (`RED.runtime.flows`, or the initialized
  `@node-red/runtime` singleton when the plugin RED object has no `.runtime`)
- **HttpAdapter** — localhost Admin API v2 fallback only when credentials are
  available (or adminAuth is off). Never selected silently without credentials
  when adminAuth is on; upstream 401/403 becomes `plugin_misconfigured`
- **`updateFlow`** — requires `expectedRev`; default deployment type `nodes`

## AI quickstart

### Self-contained GET link (chat AIs that can only HTTP GET)

1. An owner with `*` opens `/mcp` → **Access links** → create a **GET link**
   (default TTL **4 hours**, max **24 hours**). Copy the full URL
   `http(s)://<host><httpAdminRoot>/mcp/a/<token>` (or **Copy link for AI**).
2. The AI opens that URL for markdown docs, then uses GET-only routes under the
   same path (`/status`, `/flows`, `/flows/<id>`, `/proposals`, `/propose` with
   preferred `replace_text` for small string edits, chunked `/draft/…` for large
   HTML/fields; URL soft-cap ~8KB; prefer ~4–5 KB raw chunks — base64url adds
   ~33%). Patch / `mode=json` drafts support
   `nodes:[{op:'add'|'remove'|'set',...}]` (or a full `replace_flow` document).
   Field drafts validate node/field at `draft/new`. Unknown `/mcp/a/*` paths
   return JSON `not_found` without echoing the token.

   Responses on GET links default to HTML, because some AI web fetchers only
   read `text/html`. The HTML is a minimal document (no scripts or external
   resources) holding the same markdown or pretty-printed JSON, fully escaped in
   one `<pre>`, with relative `./…` links clickable. Request the real type via
   Accept or `?format=`: `Accept: text/markdown` or `?format=md` for the guide,
   `Accept: application/json` or `?format=json` for JSON. An explicit
   `Accept: text/plain` returns the same raw text as `text/plain`. No Accept,
   `*/*`, `text/html`, or browser-style lists get HTML. Status codes and data
   are unchanged; every response carries `Vary: Accept`,
   `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
   `X-Robots-Tag: noindex, nofollow`, and `X-Content-Type-Options: nosniff`, and
   HTML adds a restrictive `Content-Security-Policy`. REST and MCP endpoints are
   not affected.

3. Changes become **pending proposals**; a human approves on `/mcp`. JSON
   responses use `Cache-Control: no-store`.

### Bearer REST / MCP

1. Optional: `GET /mcp/api/v1` (no auth) lists endpoints, auth scheme, OpenAPI,
   and MCP URLs. Spec: `GET /mcp/api/v1/openapi.yaml`.
2. Send `Authorization: Bearer <token>` to REST and/or MCP:

   - REST: `GET /mcp/api/v1/status`, `GET /mcp/api/v1/flows`,
     `GET /mcp/api/v1/flows/{id}?summary=1`, `GET /mcp/api/v1/nodes/{id}`,
     `GET /mcp/api/v1/nodes/{id}/field/{name}`, `GET /mcp/api/v1/search`,
     `POST /mcp/api/v1/proposals`, `GET /mcp/api/v1/proposals`
   - MCP: `POST /mcp/rpc` tools `list_flows`, `get_flow` (optional `summary`),
     `get_node`, `get_node_field`, `search_flows`, `submit_proposal`,
     `list_proposals` / alias `list_my_proposals` (same access-link auth and
     limits)

3. The owner reviews the proposal on `/mcp` and approves or rejects it.
4. If the token is invalid, expired, revoked, or cleared by a restart, the API
   returns **401** telling the AI to **ask the user for a new access link**.

Example create body:

```json
{
  "type": "replace_flow",
  "expectedRev": "abc123",
  "title": "Rename inject to Hello",
  "payload": {
    "flowId": "tab-1",
    "flow": {
      "id": "tab-1",
      "type": "tab",
      "label": "Main",
      "nodes": []
    }
  }
}
```

## Development

```bash
yarn install
yarn build
yarn test
yarn quality
```

## License

MIT — see [LICENSE](LICENSE).
