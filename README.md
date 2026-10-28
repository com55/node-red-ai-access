# Node-RED AI Access

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/com55/node-red-ai-access/actions/workflows/ci.yml/badge.svg)](https://github.com/com55/node-red-ai-access/actions)

Temporary, owner-approved Node-RED access for AI clients. Ships as a **Node-RED
4.x+ plugin** with:

- an admin dashboard at `/ai-access` (browser `GET /mcp` redirects there)
- a versioned REST API under `/mcp/api/v1`
- an MCP JSON-RPC endpoint at `/mcp/rpc` (Streamable HTTP) over the same
  services

**Git mental model:** a proposal is like a pull request. Human approve = merge;
reject = close; withdraw = the author closes their own PR. Revision changes
auto-rebase open proposals. A `conflict` blocks approval until resolved. Open
proposals expire after a configurable TTL (default 7 days). Every access link
can see all proposals (`mine: true|false`).

Derived from
[ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp).

## Install (Node-RED plugin)

Requirements: **Node-RED 4.x or newer**, Node.js 20.19+ (tested: Node-RED 4.1 on
Node 20/22, Node-RED 5.0 on Node 22/24), and **`adminAuth` enabled**
(recommended). Without `adminAuth`, AI features stay off unless you opt in (see
Configuration).

1. Install into your Node-RED user directory (or via the palette):

   ```bash
   cd ~/.node-red
   npm install @com55/node-red-ai-access
   ```

2. Restart Node-RED.
3. Log in to the editor, then open **`/ai-access`** on the admin root (for
   example `http://localhost:1880/ai-access`, or `{httpAdminRoot}/ai-access`
   when `httpAdminRoot` is set), or click **Open AI Access dashboard** in the
   editor sidebar. Opening `/mcp` in a browser redirects to the dashboard (MCP
   clients keep using `/mcp`).

The `/ai-access` HTML shell is served without adminAuth so the page can read the
editor token from browser `localStorage` (Node-RED does not use cookies) and
call APIs with `Authorization: Bearer`. If no valid token is present, the page
shows a sign-in card. With credentials login, it posts to
`<httpAdminRoot>/auth/token` as client `node-red-editor` using the password
grant. The token is shared with the editor, stored under the editor's
`localStorage` key (`auth-tokens` at `/`, or e.g. `auth-tokens-admin` at
`/admin`). Other login strategies open the editor to sign in. All data and
actions stay behind permission checks.

The dashboard has tabs for **Overview** (status and diagnostics), **Settings**,
**Access tokens**, **OAuth**, **Proposals** and **Audit log**. You can create
access tokens, review proposals (with a readable node/property diff against the
live flow), approve or reject changes, and read a human-readable audit log.
Users with `read` (including guest, if configured) get a read-only view; only
users with `*` can create/revoke links and approve/reject proposals.

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
    // Secret-like names redacted from AI responses (default list below;
    // [] turns off name matching — token formats are always redacted)
    // secretNamePatterns: ['PASSWORD', 'SECRET', 'TOKEN', 'API_KEY', 'KEY'],
    // MCP OAuth (disabled by default; publicBaseUrl is the issuer)
    // oauth: {
    //   enabled: true,
    //   accessTokenTtlSec: 3600,
    //   refreshIdleTtlSec: 2592000,
    //   dcrMaxClients: 5,
    // },
  },
};
```

### Absolute URLs behind a reverse proxy

Access-link `url`, proposal `reviewUrl`, and `accessLinksUrl` (in
`token_expired`) are absolute URLs built by one shared helper:

1. Effective `aiAccess.publicBaseUrl`, when set, overrides the request origin.
   The sidebar/settings API accepts an HTTPS origin without a path, query,
   fragment, or credentials (HTTP localhost / loopback is allowed for
   development). An empty value uses the request origin.
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
its origin in `aiAccess.corsAllowedOrigins` via the AI Access sidebar or
settings API. Changes apply immediately. The API rejects any invalid origin in
the supplied list (including paths, credentials, queries, and fragments). For a
listed `Origin` the response echoes it in `Access-Control-Allow-Origin` with
`Vary: Origin`, and `OPTIONS` preflight returns `204` with allowed methods
(`GET, POST, DELETE, OPTIONS`) and headers (`Authorization`, `Content-Type`,
`Accept`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Last-Event-ID`). Origins
match case-insensitively and the configured origin is echoed; malformed origins
are rejected. Exposed headers include `Mcp-Session-Id`, `WWW-Authenticate`,
`Retry-After`, and the `RateLimit*` headers. Other origins get no CORS headers.

### Secret redaction

Every AI-facing response (MCP tools, REST with an access link or OAuth token,
GET links, and proposal bodies/diffs shown to AI) has likely secrets replaced
with `[REDACTED]`. The dashboard (admin session) always shows real values.

- **By name**: env entries on tabs, groups, subflows, subflow instances, and
  `global-config`, secret-named node settings (e.g. `password`), and name/value
  pairs inside node config (change rules, inject props, http request headers)
  whose name matches a pattern. Redacted env entries get `redacted: true`.
- **By content**: all other string fields, including function
  `func`/`initialize`/`finalize`, are scanned for AWS (`AKIA…`), GitHub
  (`ghp_…`, `github_pat_…`), Slack (`xox…`, webhook URLs), OpenAI (`sk-…`),
  Stripe, Google (`AIza…`), JWTs, PEM private keys, `Bearer`/`Basic` headers,
  `scheme://user:password@` URLs, and `name = "literal"` / `name: 'literal'`
  assignments whose name matches a pattern. Only the literal is replaced.
- Redacted nodes list the redacted field paths in `_aiRedactions`.
- Also caught: connection strings / DSNs (`Server=…;Password=…;`), URL query
  params with a secret name (`?key=abc123&x=1` → only `abc123`), unquoted
  `password: x` / `token=x` in non-code text fields, and
  `Buffer.from("user:pw")` / `btoa('user:pw')` basic-auth literals. Node
  `name`/`label`/`info` are content-scanned only (no key-name rule). Any single
  string field over 256 KB is sent to AI as `[REDACTED]` (decided by length
  only, so reads and submits always agree). All patterns are length-bounded /
  linear (no ReDoS).
- **Unquoted values** depend on name strength. Strong names
  (`PASSWORD PASSWD PASSPHRASE SECRET CLIENT_SECRET TOKEN API_KEY APIKEY PRIVATE CREDENTIAL PWD PW`):
  any value of 3+ chars except `none`/`null`/`${VAR}`-style references. Weak
  names (`KEY AUTH SESSION COOKIE CONN PASS …` and custom patterns): the value
  must look random — a digit or symbol, 16+ chars, 3+ character classes, or
  Shannon entropy ≥ 3 — so prose like `Session: started` / `key: value` stays.
- **Proposals (strict restore)**: a `[REDACTED]` placeholder is restored to the
  original secret on submit only when it stays exactly where it was shown: same
  node id and field, env and name/value entries (headers, change rules) matched
  by their exact name — never by array position — no more placeholders in the
  field than the original had, and the text around each placeholder on its line
  unchanged. Anything else (a new or duplicated placeholder, a renamed env var,
  a header renamed to take a secret value, an edited line) makes the submit fail
  with `redacted_placeholder_mismatch` and nothing is stored.
- Approving: the proposal card lists every field whose secret was restored, and
  shows a red warning (`secret_destination_changed`) when a node holding a
  restored secret had its `url`/`host`/`port`/`method`/`headers`/type or similar
  destination changed, or `secret_node_code_changed` when its code changed. Also
  flagged when secrets were restored: `secret_wires_changed` (its output wires
  changed), `secret_scope_changed` (tab/group env such as `${API_HOST}`, or a
  config node it uses, changed), `outbound_node_changed` (an http, mqtt, tcp,
  udp, email, websocket, function, exec or file node was added/changed), and
  `secret_tab_changed` (any other node in the tab changed).
- Always flagged (with or without restored secrets): `outbound_node_changed` for
  any added/changed http request/response, mqtt, tcp, udp, email, websocket,
  link out/call, function, exec or file node — or any node type with a
  `url`/`host`/`server`/`broker`/`endpoint` field — and `secret_reference_added`
  when added/changed code or config reads a secret-named value (`env.get("X")`,
  `$env('X')`, `${X}`, `global.get`, `flow.get`, typed inputs of type
  `env`/`global`/`flow`).
- Node-RED credentials (and `cred` env entries) are never part of flow output.
- The audit log records `ai.redacted` with the count per response (never
  values).

**Redaction is not exfiltration protection.** It keeps secret values out of what
the AI reads; it cannot stop an approved flow from sending data. Review every
proposal — especially red security banners — before approving.

**Limits — redaction is best-effort.** Detection uses names and known token
formats; secrets with unusual names or formats can still reach AI. Strict
restore only stops the AI from _copying_ a placeholder to a new place: an AI
proposal can still read an existing variable at runtime (e.g. add
`fetch(evil, {body: env.get('API_TOKEN')})`, or use `token` already defined in a
function) because flows run with the real values. Always review code and
destination changes in proposals before approving, especially on nodes flagged
above.

Default patterns (case-insensitive whole words; a trailing `S` is allowed, and
patterns of 6+ letters also match glued names like `DBPASSWORD`):
`PASSWORD PASSWD PASS PWD PW PASSPHRASE SECRET CLIENT_SECRET TOKEN API_KEY APIKEY KEY PRIVATE CREDENTIAL AUTH AUTHORIZATION BEARER SESSION COOKIE CONNECTION_STRING CONN_STR CONN DSN`.
`KEY` matches `API_KEY` / `apiKey` but not `KEYBOARD` or `MONKEY`; `AUTH` does
not match `AUTHOR` or `OAUTH`. Names ending in a descriptor word (`TOKEN_URL`,
`AUTH_TYPE`, `SESSION_TIMEOUT`, `keyType`) are not redacted. Edit the list on
the dashboard **Settings** tab (add, remove, reset to defaults) or lock it with
`aiAccess.secretNamePatterns`.

### Settings precedence

Effective values are resolved **without restart** in this order (highest wins):

1. **`settings.js`** — keys present in the `aiAccess` block are locked
2. **Disk** — `<userDir>/.ai-access/config.json` (dashboard **Settings** /
   **OAuth** tabs, editor sidebar toggles, or `PUT /mcp/api/v1/settings`)
3. **Built-in defaults** — as documented above

This is a breaking precedence change in 0.2.0: settings.js now wins over disk.
Legacy `settings.json` is read when `config.json` is absent; the next save
writes `config.json`. Locked fields show a lock indicator and disabled input.
PUT ignores locked keys while applying unlocked ones; GET and PUT return
per-field `sources` (`settings.js`, `disk`, or `default`) and the precedence
order.

The editor right-hand sidebar tab (**AI Access**) holds only: the **Enable AI
Access features** toggle (the `allowWithoutAdminAuth` local-only opt-in when
`adminAuth` is off), the **Enable MCP OAuth** toggle, an OAuth route-conflict
warning with links that reveal the conflicting node (only when conflicts exist),
and an **Open AI Access dashboard** button.

Everything else is on the dashboard. The **Settings** tab lets `*` admins change
default deploy type, access-token TTL, maximum active tokens, Public URL (with a
reachability **Check**), CORS origins, secret redaction patterns, and the three
rate limits, and shows Express's effective `trust proxy` setting. The **OAuth**
tab configures token lifetimes and the client limit, lists registered clients
with revoke buttons, and reports route collisions (linking `http in` nodes to
the editor) and the `httpNodeRoot: false` metadata fallback. `read` users see
the same values read-only; writes need `*`, exactly as before. Changes apply
immediately; changing limits starts fresh rate-limit buckets. Enabling OAuth
with no Public URL or an HTTP non-loopback URL shows a warning confirmation; it
does not block the change. Fields set in `settings.js` are locked.

### MCP OAuth

OAuth is disabled by default. Set `aiAccess.publicBaseUrl` to the public HTTPS
origin before enabling it; localhost and loopback HTTP are supported for local
development. Node-RED serves authorization, token, dynamic client registration,
and revocation under `/mcp/oauth/*`. It publishes authorization server metadata
at `/.well-known/oauth-authorization-server` and protected resource metadata at
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource`. The issuer is `publicBaseUrl` and the
resource indicator is `{publicBaseUrl}/mcp`. When `httpNodeRoot` is false,
metadata is available under the admin `/mcp` path instead; the dashboard OAuth
tab displays this fallback. Route collisions disable the affected OAuth
endpoints and appear in the sidebar and on the OAuth tab.

Clients use authorization code with PKCE S256 and can request `read` or
`propose`. Consent uses the Node-RED editor login. Access tokens last one hour
by default; refresh tokens expire after 30 days of inactivity and rotate on each
use. Reusing a rotated refresh token revokes its token family. Tokens are stored
as SHA-256 hashes in `<userDir>/.ai-access/oauth.json`. Access-link `aia_`
bearer tokens continue to work. See [MCP client setup](docs/mcp-clients.md).

Add `{publicBaseUrl}/mcp` as the server URL in ChatGPT, Claude and other MCP
clients; `/mcp` and `/mcp/rpc` serve the same MCP endpoint (browsers opening
`/mcp` are redirected to `/ai-access`). At most `oauth.dcrMaxClients`
(default 5) approved clients are kept: lowering the limit removes none, but new
registrations are refused with `400` until clients are revoked.

When you are signed out and Node-RED uses `credentials` login, the consent page
shows its own sign-in form. It calls Node-RED's `/auth/token` endpoint and
stores the resulting editor token in `localStorage` under the editor's key, so
this also signs you in to the Node-RED editor in that browser.

> **Exposing Node-RED publicly:** Node-RED's own `/auth/token` login endpoint is
> not rate limited (neither by Node-RED nor by this plugin). Before exposing
> Node-RED to the internet for OAuth, put it behind a reverse proxy or other
> limiter that throttles `POST {httpAdminRoot}/auth/token` (and preferably the
> whole admin path), and use strong passwords.

Public URL **Check** uses `POST /mcp/api/v1/settings/check-public-url` and
requires `*` permission because it performs an outbound request. It validates
the form URL, fetches only `{publicBaseUrl}{httpAdminRoot}/mcp/api/v1`
(discovery), times out after 5 seconds, and never follows redirects. The result
reports the HTTP status or a connection/timeout error; it does not save the
form. Loopback checks use Node-RED's own listening port; behind a reverse proxy,
use the internal Node-RED port. Unix-socket listeners are not supported. HTTPS
checks using a self-signed certificate fail because TLS verification remains
enabled. Saving a Public URL with a private/internal IP literal is allowed, but
the settings response and sidebar show a warning.

Storage lives under **`<userDir>/.ai-access`** (`config.json`,
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

| Path                                     | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `GET /ai-access`                         | Admin dashboard (overview, settings, tokens, OAuth, …)    |
| `GET /mcp` (browser)                     | `302` redirect to `/ai-access`                            |
| `GET /mcp/a/<token>`                     | Self-contained GET link (markdown docs)                   |
| `GET /mcp/a/<token>/…`                   | Token-scoped GET status/flows/propose/drafts              |
| `POST /mcp/rpc`                          | MCP Streamable HTTP (access-link Bearer; tools)           |
| `POST /mcp`                              | Same MCP endpoint (OAuth resource URL for ChatGPT/Claude) |
| `GET /mcp/api/v1`                        | Discovery index (no auth; endpoints + auth hint)          |
| `GET /mcp/api/v1/openapi.yaml`           | OpenAPI 3.1 specification (YAML)                          |
| `GET /mcp/api/v1/openapi.json`           | OpenAPI 3.1 specification (JSON)                          |
| `GET /mcp/api/v1/status`                 | Plugin status JSON (admin or access link)                 |
| `GET /mcp/api/v1/settings`               | Effective AI Access settings (admin `read`)               |
| `PUT /mcp/api/v1/settings`               | Update settings (`*`; persists to disk, hot)              |
| `GET /mcp/api/v1/links`                  | List active access links (`*` only)                       |
| `POST /mcp/api/v1/links`                 | Create access link (`*` only; token once)                 |
| `DELETE /mcp/api/v1/links/:id`           | Revoke access link (`*` only)                             |
| `GET /mcp/api/v1/flows`                  | List flows + rev (admin `read` or access link)            |
| `GET /mcp/api/v1/flows/:id`              | Get one flow + rev (admin `read` or access link)          |
| `POST /mcp/api/v1/proposals`             | Create proposal (access-link Bearer only)                 |
| `GET /mcp/api/v1/proposals`              | List proposals (admin: all; link: own)                    |
| `GET /mcp/api/v1/proposals/:id`          | Get proposal (admin: any; link: own)                      |
| `GET /mcp/api/v1/proposals/:id/diff`     | Diff proposal vs current flow (admin `read`/own)          |
| `POST /mcp/api/v1/proposals/:id/approve` | Approve + deploy (`*`; optional deploymentType)           |
| `POST /mcp/api/v1/proposals/:id/reject`  | Reject with reason (`*`; no flow mutate)                  |
| `GET /mcp/api/v1/logs`                   | Append-only audit log (admin `read`)                      |

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
`reviewPath` (relative `/ai-access#proposal=<id>`). `createdAt` remains
ISO-8601. The `/ai-access` dashboard renders times in the browser's local
timezone. AI clients should refer to proposals by `displayName` + `reviewUrl`,
not the raw id. For access-link callers, `get_status` reports `permission: null`
and `caller.kind: "access-link"` (expected — AI tokens are not admin sessions).

Approve, reject, and access-link management stay human-only on the `/ai-access`
admin page (and the corresponding REST routes). Rate limits, payload size
limits, and audit logging match REST. Missing tokens return **401**
`access_link_missing`; known-expired tokens return **401** `token_expired`;
other invalid/revoked tokens return **401** `access_link_invalid` (all with
`WWW-Authenticate`) telling the AI to ask the user for a new access link. Every
error JSON includes a `code`. `token_expired` also includes `expiredAt` and
`accessLinksUrl` (the `/ai-access` dashboard's Access tokens tab). Access-link
`/status` includes `expiresAt`, `minutesRemaining` (rounded up), and
`secondsRemaining`. See `docs/errors.md` (generated from
`src/plugin/error-registry.ts`).

Access links are **in memory** (default TTL **4h**, max 10). Caps: **get_link ≤
24h**, **rest/mcp ≤ 30d**. Creating a link returns the raw `token` plus a
self-contained `url` for `get_link` (`/mcp/a/<token>`). The token is shown only
once: `GET /links` never returns `token` or `url`, so to give access again
revoke the link and create a new one. After a restart every old token is
invalid.

Call `list_flows` or `get_flow` first and pass the returned `rev` as
`expectedRev`. Recent known stale revisions are accepted and auto-rebased;
unknown revisions return **409** `version_mismatch`. Human approval waits up to
60 seconds for deployment. A timeout returns **504** `deploy_timeout`, leaves
the proposal pending, and releases the approval queue. Check the live flows
before retrying: the runtime operation cannot be cancelled and may still finish.
When choosing **proposed** during conflict resolution, unchanged secret spans
keep their live editor values. If spans cannot be aligned safely, proposed
values are retained with a `secret_may_revert` warning on the dashboard card.

Open proposals auto-rebase on editor changes. A `conflict` blocks approval until
resolved using REST `POST /proposals/:id/resolve`, admin
`POST /proposals/:id/resolve-conflict`, or MCP `resolve_proposal_conflict`.
Diffs include `rebase`, `liveChanges` and (without conflicts) `vsCurrent`, the
merged deployment. Approval requires the reviewed `mergedHash` when editor
changes are merged. Proposals expire after `proposalTtlDays` (integer 1–365,
default 7), editable through the settings API. Approve may send
`deploymentType`: `nodes` (default), `flows`, or `full`. Approval rebases
against the current revision; conflicts leave the proposal open for resolution.
Deploy timeouts keep it **pending**; other deploy errors mark it **failed**.
Reject never mutates flows.

### Flow runtime adapter

- **RedAdapter** — in-process flows API (`RED.runtime.flows`, or the initialized
  `@node-red/runtime` singleton when the plugin RED object has no `.runtime`)
- **HttpAdapter** — localhost Admin API v2 fallback only when credentials are
  available (or adminAuth is off). Never selected silently without credentials
  when adminAuth is on; upstream 401/403 becomes `plugin_misconfigured`
- **`updateFlow`** — requires `expectedRev`; default deployment type `nodes`

## AI quickstart

### Self-contained GET link (chat AIs that can only HTTP GET)

1. An owner with `*` opens `/ai-access` → **Access tokens** → create a **GET
   link** (default TTL **4 hours**, max **24 hours**). Copy the full URL
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

3. Changes become **pending proposals**; a human approves on `/ai-access`. JSON
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

3. The owner reviews the proposal on `/ai-access` and approves or rejects it.
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
