# Changelog

All notable changes to Node-RED AI Access will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0-beta.8] - 2026-10-29

- Proposal review shows human conflict reasons and Base / Live / Proposed field
  values, including flow environment variables. Choices have explanations,
  confirmation, a visible chosen state, and persisted undo of the latest choice.
- Proposals with no net deployment change clearly say nothing changes and hide
  approval and security notes.
- Consolidate review notes with a count and separate security from
  configuration; omit duplicate comparisons and unchanged editor diffs. Re-check
  shows progress and a result toast. Pending totals match the badge, including
  conflicts.
- Improve light-theme readability, settings width, sticky navigation clearance,
  sign-in footer visibility and stable sign-in button colors; errors use alerts.
- Reject invalid TTL settings with a minimum of 1; keep invalid input visible
  and never report it saved. Investigate the NR4 Active link (box-only
  findings).

- Merge disjoint fields on the same node and tab, including env entries by
  unique name and credentials by key. Conflict choices preserve independent
  changes from both sides and retain secret safeguards and warnings.
- Keep peer proposals mergeable after approval of a different field on the same
  node.
- Report actual changed fields in `outbound_node_changed` warnings.
- Expose `baseRev` and rename the informational revision flag to
  `baseRevChanged`; use `rebase.state` and `rebase.rev` to assess the checked
  merge.
- Add `nodeId` + `choice` to MCP/REST proposal resolution and clarify that
  replacement operations apply to the flow snapshot at `expectedRev`.
- Allow full admins to withdraw proposals after token loss, with recovery
  authority and original ownership in the audit log. Other tokens remain
  blocked.

## [0.2.0-beta.7] - 2026-10-28

### Fixed

- Unrelated flow changes no longer expire or reject pending proposals.

### Added

- Automatic three-way rebasing onto live flows, with a `conflict` status that
  blocks approval until resolved.
- Configurable `proposalTtlDays` (1–365 days, default 7); only TTL expiry closes
  old open proposals.
- Admin conflict-choice and recheck routes, AI REST resolution, and the MCP
  `resolve_proposal_conflict` tool.
- Diffs include editor changes and the merged deployment; approval requires a
  `mergedHash` acknowledgement when live changes are merged.
- Recent known stale revisions are accepted at submit and rebased immediately.

## [0.2.0-beta.6] - 2026-10-28

### Added

- OAuth consent page signs in automatically once you sign in to the Node-RED
  editor in another tab (it watches the editor token in `localStorage` and
  re-checks on tab focus / visibility). Works for `adminAuth` `strategy`
  (OIDC/passport) logins, which cannot return to the consent page by themselves.
  The Retry button stays as a fallback.
- Dashboard (`/ai-access`) refreshes status, access links, proposals, logs and
  the OAuth client list when you return to a tab left open (visibility / focus,
  at most every 5 s). It never reloads while a dialog — such as the one-time
  token modal — is open or while you are typing in a field, and never reloads
  settings forms.
- Proposals view: flow names and modified/removed nodes link to the editor
  (`#flow/<id>`, `#node/<id>`). A click reveals the item in an already open
  editor tab (via a same-origin `BroadcastChannel` answered by the editor
  sidebar script, using `RED.view.reveal` / `RED.workspaces.show`); with no open
  editor it opens one in a named `node-red-editor` window that later clicks
  reuse. Browsers do not let a page bring another tab to the front, so the
  dashboard shows a toast when the item was revealed in the existing tab.

## [0.2.0-beta.5] - 2026-10-28

### Security

- `outbound_node_changed` (now incl. http response, link out/call and
  third-party nodes with url/host fields) and new `secret_reference_added`
  (code/config newly reading a secret-named env/global/flow value) are emitted
  on every proposal, not only when secrets were restored; red approve banner.
- Unquoted values: strong secret names redact any value; weak names need a
  random-looking value (digit/symbol, 16+ chars, or high entropy).
- Full-field redaction is decided by length only (no time budget), so reads and
  submits agree.
- Redaction scanning is linear-time: the connection-string rule is a plain split
  (was quadratic: 250k chars took ~46 s), every regex is length-bounded, and
  fields over 256 KB are hidden whole.
- More reviewer warnings when secrets are restored: `secret_wires_changed`,
  `secret_scope_changed`, `outbound_node_changed`, `secret_tab_changed`.
- Secret-named URL query params are redacted; duplicate header names restore
  one-to-one.
- Strict placeholder restore on proposal submit: `[REDACTED]` becomes the real
  secret only in its original node/field/line, env and header entries matched by
  exact name (never by index); added, duplicated, moved or renamed placeholders
  reject the submit (`redacted_placeholder_mismatch`). Approve cards list
  restored-secret fields and warn loudly (`secret_destination_changed`,
  `secret_node_code_changed`) when such a node's destination or code changes.
- Detection also covers DSN/connection strings, unquoted `password: x`,
  `Buffer.from("user:pw")`, the `PW` pattern, and content of node
  `name`/`label`/`info`; string fields over 256 KB are fully redacted for AI.
  The dashboard warns when the pattern list is empty, and the REST redaction
  audit middleware only acts on AI REST routes under `/mcp/`.
- Likely secrets are redacted from everything AI clients receive: MCP tools
  (`list_flows`, `get_flow`, `get_node`, `get_node_field`, `search_flows`,
  proposal tools and diffs), REST with an access link or OAuth token, and GET
  links. Previously `list_flows` returned plaintext env values such as a group
  `OAUTH_POC_PASSWORD` to OAuth read clients. Admin-session (dashboard) reads
  are unchanged and show real values.
  - Env entries (tab, group, subflow, subflow instance, node, `global-config`)
    whose name matches a secret pattern get `value: "[REDACTED]"` and
    `redacted: true`; secret-named node settings and name/value pairs in node
    config (change rules, inject props, http headers) are redacted too.
  - Function `func`/`initialize`/`finalize` and all other string fields are
    scanned for known token formats (AWS, GitHub, Slack, OpenAI, Stripe, Google,
    JWT, PEM private keys, Bearer/Basic headers, URL passwords) and
    `name = "literal"` assignments; only the literal is replaced. Redacted nodes
    carry `_aiRedactions` (field paths).
  - Proposals restore `[REDACTED]` placeholders to the original secret on submit
    (full tab or node ops), so AI edits never overwrite a secret with the
    placeholder; unmatched placeholders produce a
    `redacted_placeholder_unresolved` warning.
  - The audit log records `ai.redacted` with the count per response and the
    operation (never values); `proposal.created` adds `restoredRedactions`.

### Added

- `secretNamePatterns` setting (dashboard Settings → Secret redaction: add,
  remove, reset to defaults; `PUT /settings` accepts a list or `null` to reset).
  Lockable via `settings.js` `aiAccess.secretNamePatterns`.

## [0.2.0-beta.4] - 2026-10-28

### Changed

- Removed dark-mode support from the `/ai-access` dashboard and the OAuth
  consent / sign-in pages. They always use the light theme
  (`color-scheme: light`), even when the OS prefers dark. The beta.3 dark
  variant left some components unreadable (e.g. removed-node diff rows in
  proposal cards).

## [0.2.0-beta.3] - 2026-10-28

### Breaking

- **Dashboard moved from `<httpAdminRoot>/mcp` to `<httpAdminRoot>/ai-access`.**
  Browser `GET /mcp` (anything that is not an MCP `text/event-stream` request)
  now answers `302` → `/ai-access`; MCP traffic on `/mcp` and `/mcp/rpc` (OAuth
  resource, ChatGPT/Claude) is unchanged. Proposal `reviewPath` / `reviewUrl`,
  `accessLinksUrl`, settings `mcpPageUrl`, error hints and docs now point at
  `/ai-access` (`#proposal=<id>`, `#links`). Old dashboard URLs and bookmarks
  (`<httpAdminRoot>/mcp`, including `#proposal=<id>` / `#links` fragments) keep
  working through the redirect (browsers carry the fragment across a `302`), but
  update bookmarks to `/ai-access`: the redirect is only for browsers and `/mcp`
  is the MCP endpoint.
- **Settings moved out of the editor sidebar.** The sidebar now holds only the
  Enable AI Access toggle (or the local-only opt-in without adminAuth), the
  Enable MCP OAuth toggle, the OAuth route-conflict warning (with reveal links,
  shown only when conflicts exist) and an "Open AI Access dashboard" button.
  Public URL + check, CORS, rate limits, trust proxy, default deploy type,
  default token expiry, max active tokens, OAuth lifetimes / max clients,
  registered OAuth clients + revoke and the pending-proposal counter moved to
  the dashboard. Permission checks are unchanged (writes need `*`).

### Added

- Dashboard redesign: top tabs Overview, Settings, Access tokens, OAuth,
  Proposals, Audit log; card layout, number + unit inputs on one line, prominent
  Public URL check result, responsive, dark-mode aware (`prefers-color-scheme`),
  no external assets. Hash aliases `#overview`, `#tokens`, plus `#settings` and
  `#oauth`.
- OAuth tab collision list links `http in` nodes to the editor
  (`<httpAdminRoot>/#node/<id>`, falling back to `#flow/<tabId>`); collision
  details now include `flowId`.

### Fixed

- MCP OAuth with ChatGPT: "Authentication succeeded, action discovery failed".
  The OAuth protected resource (and the URL users add in ChatGPT/Claude) is
  `<Public URL>/mcp`, but MCP was only served at `/mcp/rpc`, so the
  authenticated `POST /mcp` returned 404. `/mcp` now also serves MCP Streamable
  HTTP (POST; SSE `GET`/`DELETE` answer 405 like `/mcp/rpc`, and the same 401 +
  `resource_metadata` challenge). Browsers opening `/mcp` still get the
  dashboard.

- Editor sidebar: Revoke for registered OAuth clients appeared to do nothing
  because its confirm dialog rendered at the top of the scrolled settings panel
  (out of view). The dialog now overlays the whole tab.

### Changed

- Default "Maximum registered OAuth clients" (`oauth.dcrMaxClients`) is now 5
  (was 20). Upgrading with more than 5 approved clients removes none of them:
  existing clients keep working, but new registrations get `400` (Maximum active
  OAuth clients reached) until clients are revoked below the limit or the limit
  is raised.
- At most 25 OAuth clients may await consent at once (was 100).
- AI-facing CORS policy now also covers `/mcp`.
- Redesigned OAuth consent page: branded card, redirect host first, permission
  list with descriptions, signed-in user, prominent Allow / secondary Deny,
  responsive and dark-mode friendly, no external assets. When signed out with
  credentials login, the page shows an inline sign-in form in the same style.

## [0.2.0-beta.2] - 2026-10-28

### Fixed

- OAuth route collision check no longer counts disabled `http in` nodes or nodes
  on disabled flows; collisions are re-evaluated from scratch on every deploy,
  and an enabled `http in` node is reported once (not again as an Express "bound
  dispatch" route).
- OAuth route collision check ignores `http in` nodes in subflow templates
  without a running instance, compares real mounted paths (`httpAdminRoot` /
  `httpNodeRoot`), and matches paths case-insensitively like Express.
- `GET /mcp/api/v1/oauth/status` no longer exposes absolute `httpStatic`
  filesystem paths to users without full (`*`) permission.
- Editor sidebar: OAuth lifetime number inputs and unit dropdowns sit on one
  line, including the narrow Node-RED 5 sidebar.
- Editor sidebar: OAuth route collisions are shown as a readable bulleted list,
  one route per line with paths in `<code>`; `http in` nodes link to the node in
  the editor.
- Editor sidebar: Public URL "Check" result is shown as a clear green/red
  status; loopback notes and the trust proxy state are moved into a muted,
  collapsible "About the check" section with human-readable wording.
- OAuth route collision check also honours `httpStaticRoot` (and per-entry
  `httpStatic` roots).
- `/mcp` page Access links: the area under the form now always shows generic
  usage (with a `<YOUR_TOKEN>` placeholder) for the currently selected channel
  and updates when the channel changes. The real token and client setup are
  shown once in a modal right after creation; closing it removes the token from
  the page.
- Access link create/list responses are sent with `Cache-Control: no-store` and
  `Pragma: no-cache`.
- Access link tokens are kept in memory as a SHA-256 hash only (the raw token is
  no longer retained after creation).

### Breaking

- **Access tokens can no longer be viewed or copied after creation:**
  `GET /mcp/api/v1/links` no longer returns `token` (rest/mcp) or `url`
  (get_link), and the links table only offers Revoke. Revoke and create a new
  token instead.

### Added

- Editor sidebar: short "How to use MCP OAuth" help in the OAuth section.
- `GET /mcp/api/v1/oauth/status` returns structured `details` (path, source,
  node id/name) for each collision.

## [0.2.0-beta.1] - 2026-10-28

First pre-release of 0.2.0, published under the npm `beta` dist-tag.

### Added

- Node-RED settings and sidebar for configuring AI Access (#91).
- MCP OAuth authorization (#99): dynamic client registration (DCR), PKCE, an
  owner consent page, and sliding refresh tokens with defaults of 1 hour (access
  token), 30 days (refresh idle) and 90 days (refresh maximum).
- Route-collision check for the OAuth and metadata endpoints.
- MCP OAuth 2.1 authorization server and protected resource support with PKCE
  S256, dynamic client registration, resource-bound tokens, rotating refresh
  tokens, and `read`/`propose` scopes. Existing access-link tokens still work.
- Sidebar controls for OAuth lifetimes and client limits, registered-client
  revocation, route-collision and metadata-fallback warnings, and a Public URL
  warning when enabling OAuth, plus a refresh-token maximum lifetime (default 90
  days, 0 = unlimited).

### Changed

- CI now tests against a Node-RED 4 and Node-RED 5 matrix.
- Requires Node.js >= 20.19.

## [0.1.1] - 2026-10-17

### Added

- `/status` (REST and MCP `get_status`) now includes `openapiJson` in
  `caller.baseUrls` for `rest` tokens, pointing at the served
  `GET /mcp/api/v1/openapi.json`.
- Optional `aiAccess.corsAllowedOrigins` setting (settings.js): list of browser
  origins allowed to call the AI-facing endpoints cross-origin, with
  `Vary: Origin` and `OPTIONS` preflight support. Origins match
  case-insensitively and the configured canonical origin is echoed; malformed
  origins are rejected. `WWW-Authenticate`, `Retry-After`, and the `RateLimit*`
  headers are exposed to allowed origins.
- Optional `aiAccess.publicBaseUrl` setting (settings.js) that sets the public
  base URL for absolute links (access-link `url`, proposal `reviewUrl`,
  `accessLinksUrl`), overriding `Host` and `X-Forwarded-*`.
- The MCP client snippets in the GET-link guide use the public origin
  (`publicBaseUrl`, else the validated request origin) instead of the
  `https://YOUR-NODE-RED` placeholder, which remains only when the origin cannot
  be determined.

### Changed

- **Behavior change:** every response on the GET access-link channel
  (`/mcp/a/<token>/*`), including the markdown guide and JSON success and error
  bodies, now defaults to `Content-Type: text/html; charset=utf-8`, because some
  AI web fetchers only read `text/html`. The HTML is a minimal document with the
  same markdown or pretty-printed JSON, fully escaped in one `<pre>`, with safe
  relative `./…` links linkified (no scripts, no external resources). Status
  codes and data are unchanged. The previous representation is returned when
  `Accept` explicitly lists `text/markdown` or `application/json`, or
  `?format=md` / `?format=json` is set; an explicit `Accept: text/plain` returns
  the raw text as `text/plain`. All `/mcp/a/*` responses carry `Vary: Accept`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex, nofollow`, and `X-Content-Type-Options: nosniff`; HTML
  adds a restrictive `Content-Security-Policy`. REST and MCP are unchanged.
- **Behavior change:** the AI-facing endpoints (`/mcp/a/*`, `/mcp/api/*`,
  `/mcp/rpc`) no longer send `Access-Control-Allow-Origin: *` (inherited from
  Node-RED's admin app). No CORS headers are sent unless the request `Origin` is
  listed in `aiAccess.corsAllowedOrigins`. Only browser-based callers are
  affected; server-side clients are not.
- Attempts to create, list, or revoke access links under a GET access link
  (`/mcp/a/<token>/links`) now return **403** `link_create_not_supported`
  instead of 405. Error registry, `docs/errors.md`, OpenAPI, and get-link docs
  updated.
- `/status` (GET link, REST, and MCP `get_status`) no longer includes
  `storageDir` for access-link callers; it remains in admin-session responses
  (shown on the `/mcp` page).

### Fixed

- Proposal titles no longer repeat the flow name when a long `<title> in <flow>`
  was capped at 80 characters.
- GET-link HTML no longer linkifies template paths such as `./nodes/<id>`.

- **Security:** absolute URLs no longer copy unvalidated `X-Forwarded-Proto` /
  `X-Forwarded-Host` (or `Host`) values. The scheme must be exactly `http` or
  `https` (else the connection scheme is used); hosts must be a DNS name, IPv4,
  or bracketed IPv6 literal with an optional port 1-65535, with no userinfo,
  path, query, fragment, or whitespace. Invalid forwarded hosts fall back to
  `Host`; an invalid `Host` falls back to a relative path.

- Absolute URLs (access-link `url`, proposal `reviewUrl`, `accessLinksUrl`) used
  `http://` behind a TLS-terminating proxy. With Express `trust proxy` enabled
  the first `X-Forwarded-Proto` value is now used explicitly; without it, set
  `aiAccess.publicBaseUrl`. Forwarded headers stay ignored when `trust proxy` is
  off.

## [0.1.0] - 2026-10-16

First public release of **Node-RED AI Access**: an admin-gated Node-RED 4 plugin
that lets AI agents read flows and submit reviewable change proposals over REST,
MCP, and GET access links, with scoped, expiring tokens, a review UI, conflict
detection, an audit log, and an error-code registry shared by all channels.
Requires Node.js 20+.

### Release

- Initial independent release of **Node-RED AI Access**
  (`@com55/node-red-ai-access`), derived from
  [ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp).
- Package metadata, Docker image names, documentation, and CI retargeted to
  `com55/node-red-ai-access`.
- GitHub Actions CI runs on `ubuntu-latest` for all events.
- Requires Node.js `>=20`; CI tests Node 20, 22, and 23.
- `@modelcontextprotocol/sdk` raised to `^1.31.0`.
- Published package is a minified production build without source maps;
  `prepublishOnly` runs quality checks, tests, and the production build. The
  whole `docs/` folder ships; the OpenAPI spec exists once
  (`docs/api/openapi.yaml`) and is served at `GET /mcp/api/v1/openapi.yaml`.
- MCP `list_proposals` `status: []` (or `""`) means no status filter; an invalid
  status member returns the same `invalid_filter` message on every channel.

### Fixed (pre-release review)

- `RateLimit-*` headers on token requests report the per-token bucket
  (`300;w=60` by default) on every route; requests without a token report the
  per-IP bucket.
- Spec also served as JSON at `GET /mcp/api/v1/openapi.json`.
- Proposal responses include `storedTitle` (the title as saved).
- `duplicate_node_id` checks the whole resulting flows file: the tab id, nodes
  on other tabs, config nodes, and subflows.
- A single validation error returns its specific message at the top level.
- Hints come from the error registry on every channel (including
  `node_already_exists` and a top-level `validation_failed` hint); `errors[]`
  entries no longer carry `statusCode`.
- `status` list filter accepts several values (comma-separated or repeated on
  REST/GET; array or comma string on MCP); any invalid value is
  `invalid_filter`. Repeating a single-value filter is `invalid_filter`.
- `mine=false` returns only proposals created by other links.
- GET guide lists every error code, warnings, statuses (including `superseded`),
  and `autoClosedCount`.

### Changed

- List filters are validated on GET, REST, and MCP: bad `status`, `limit` (not
  1–200; no longer clamped), `offset`, or `mine` return **400** `invalid_filter`
  naming the parameter and allowed values. MCP argument schema errors return the
  same JSON body (`invalid_filter` / `invalid_arguments`) instead of raw Zod
  output.
- List responses on every channel share `total`, `offset`, `limit` (when set),
  `hasMore`, and `nextOffset` (offset-based pagination).
- Several validation errors in one proposal return **400** `validation_failed`
  (`N validation errors`, all listed in `errors[]`); a single error keeps its
  own code (e.g. **404** `node_not_found`).
- Out-of-range or non-positive `ttlSeconds` returns **400** `invalid_ttl` with a
  hint stating the per-kind caps (was `access_link_invalid`).
- `staleOnOlderRev` removed (stale peers are auto-closed on read); responses
  include `autoClosedCount` when a request auto-closed pending proposals.
- `minutesRemaining` rounds up; `/status` also reports `secondsRemaining`.
- `token_expired` includes `expiredAt` and `accessLinksUrl`; GET-link 401s
  include `WWW-Authenticate`.

### Added

- Duplicate node ids in a full tab or batch are rejected with
  `duplicate_node_id`.
- Central error-code registry (`src/plugin/error-registry.ts`) generating
  `docs/errors.md`, the GET guide error table, and the OpenAPI `ErrorCode` list
  (`yarn generate:errors`; CI staleness check `yarn check:errors`).
- Channel onboarding on `/mcp`: REST copies a ready-to-paste AI prompt (base
  URL, Bearer, OpenAPI + discovery, human-approve note, and a stop-and-ask-for-
  GET-link line when custom headers are unavailable); MCP shows a setup panel
  with Claude Desktop / Cursor / VS Code / Claude Code CLI / Streamable HTTP
  tabs (each with its own copy button); GET link still copies the URL. Docs:
  `docs/README.md`, `docs/mcp-clients.md`, `docs/errors.md`, generated
  `docs/mcp-tools.md` (`yarn generate:mcp-tools` / CI stale check).
- Access-link TTL UX: `/mcp` expiry dropdown (15m / 1h / 4h / 24h / 7d /
  Custom); `get_link` capped at 24h (7d hidden; switching to GET link with
  expiry above 24h — including Custom — resets to 1 hour with a short note);
  `rest` / `mcp` capped at 30d with a red warning above 24h. Server enforces the
  same caps. Status for access-link callers includes `expiresAt` and
  `minutesRemaining`. Known-expired tokens return **401** `token_expired`
  (distinct from `access_link_invalid`).
- Auto-close stale pending proposals: `expired` (live rev moved) and
  `superseded` (another proposal on the same flow was approved).
- Conflict trim: `conflictingProposals` lists same-rev or overlapping peers
  only; other older-rev peers appear as `staleOnOlderRev` count. List items omit
  `conflictingProposals`.
- GET withdraw requires `confirm=1` (prefetch-safe).
- Proposal list pagination and filters on GET/REST/MCP: `status`, `flowId`,
  `limit`/`offset` (response `total`; max limit 200). MCP tool renamed to
  `list_proposals` (`list_my_proposals` kept as alias).
- Proposal visibility: every access-link token can list/read **all** proposals
  with `mine: true|false`; filter with `?mine=true` / MCP `list_proposals`
  `{ mine: true }`.
- Cross-token conflict warnings on submit/read: `conflictingProposals` with
  optional `overlappingNodeIds` / `overlappingFields` (replaces private
  `otherLinkSiblingCount`).
- Withdraw own pending proposals (`withdrawn` status): GET
  `…/proposals/<id>/withdraw?confirm=1`, REST `POST /proposals/{id}/withdraw`,
  MCP `withdraw_proposal` (+ `/mcp` pill + audit `proposal.withdrawn`).
- Docs: Known issues (per-token rate limits stack), 1.5MB cap on every channel,
  canonical REST/MCP `payload.nodes` op shapes.
- Phase 2C: GET `/mcp/a/<token>` cannot mint tokens — explicit **405**
  `link_create_not_supported` on `/mcp/a/<token>/links`; OpenAPI documents
  `AccessLinkKind`, `CreateLinkRequest.kind`, `wrong_token_kind` /
  `invalid_link_kind`, and that get-link has no create-link operation; discovery
  advertises admin-only `POST /links` mint and `getLink.canMintTokens: false`.

### Fixed

- Access-link rate limits share one per-token bucket across GET
  `/mcp/a/<token>`, REST Bearer, and MCP (same limiter instances + unified token
  key).
- Layered-read JSON responses always set `X-Content-Type-Options: nosniff` and
  never echo path/query/exception text into error bodies (CodeQL XSS / HTML).

### Changed

- `/mcp` human-UX pass: status dashboard (AI on, active links, pending count,
  expiry in hours), Pending/Decided proposal filters with tab badge, compact
  decided cards, plain one-line diff summaries, stale dismiss + large-delete
  typed confirm, Approve & deploy with deploy-type Advanced help, reject dialog,
  access-link TTL presets (1h/4h/24h), Created/Last used link table, audit
  labels without event codes, sticky tab nav, sign-in gate (no silent bounce),
  and sidebar TTL hours + Review deep link to `/mcp#proposals`.

### Added

- Targeted `replace_text` op for string fields (`template`, `func`, …): unique
  `find` or 1-based `occurrence`; errors `400 text_not_found` /
  `409 ambiguous_match` (with `matchCount`). Available via GET propose
  (`node=&field=&find=&replace=`), patch JSON, and REST/MCP `submit_proposal`
  (`payload.nodes` without a full tab). Multiple ops apply in order. AI guide
  recommends it for small edits to long fields and documents a last-resort
  placeholder→paste workflow when content exceeds draft limits.
- Layered reads on GET link, REST, and MCP (same auth/rate limits):
  `GET …/flows/{id}?summary=1` (node id/type/name/wires + bytes, no field
  bodies); `GET …/nodes/{id}` (one full node + flowId);
  `GET …/nodes/{id}/field/{name}?lines=A-B` (optional line range +
  `totalLines`/`bytes`); `GET …/search?q=&flow=` (hits with node/field/lines/
  snippet; capped with `truncated:true`). Recommended loop: summary → search →
  read line range → `replace_text` → propose. MCP tools: `get_flow` (`summary`),
  `get_node`, `get_node_field`, `search_flows`.

### Changed

- `/mcp/api` and `/mcp/a` use dual in-memory rate limits (per IP and per access
  token) with configurable `aiAccess.rateLimitWindowMs` / `rateLimitMaxPerIp` /
  `rateLimitMaxPerToken` (generous defaults: 600/min IP, 300/min token).
  Exceeded limits return **429** `{ code: 'rate_limited', retryAfter }` and a
  `Retry-After` header.
- Proposal `reviewUrl` is now an **absolute** URL from the request Host/protocol
  (`X-Forwarded-*` only when Express `trust proxy` is set). Responses also
  include relative `reviewPath` (`/mcp#proposal=<id>`).
- `displayName` datetime includes an explicit UTC offset and is documented as
  **server local time** (for AI clients). The `/mcp` UI never shows that server
  string: proposal headings and audit labels rebuild the title and format
  `createdAt` / `at` with `Intl.DateTimeFormat` in the **browser** timezone.
  `createdAt` remains ISO-8601.
- `/mcp` is served with `Cache-Control: no-store` so plugin upgrades do not keep
  serving a cached admin client (inline CSS/JS).
- `/mcp` location hash reflects the active tab (`#status`, `#links`,
  `#proposals`, `#audit`) via `history.replaceState`. `#proposal=<id>` is only
  used while focusing a proposal deep link and is replaced with `#proposals`
  after the scroll/highlight is consumed (so reload / returning to Proposals
  does not re-trigger).

### Fixed

- Side-by-side (split) diffs for large field replaces pair remove/add runs so
  the AFTER column is visible instead of a long blank placeholder stack.
- Unknown flow ids return **404** `flow_not_found` (with hint to use ids from
  `GET ./flows`) instead of **502** `upstream_error` on RedAdapter.
- Invalid draft chunk base64url (e.g. `@@@`) returns **400**
  `invalid_chunk_data` and does not store the seq.
- `set.wires` is allowed in patch/propose when targets exist in the resulting
  flow (validated); id/type/z stay protected.
- Added/removed node diffs include `wires` (readable) and `x`/`y`.
- `draft/new` checks live rev immediately (**409** `version_mismatch`); stale
  submit responses set `draftDeleted: false` when the draft was kept.
- REST `Bearer bogus` / short tokens return `access_link_invalid` (with a
  truncated-URL hint when applicable), not `access_link_missing`.
- Proposal diffs default to compact `format=summary` (changed lines + context +
  byte sizes); `format=full` restores complete text.
- Re-submitting a draft returns **409** `draft_already_submitted` with
  `proposalId`; malformed sha256 returns **400** `invalid_sha256`.
- Propose/draft responses warn with `siblingsOnSameRev` when other pending
  proposals share the same flow revision.

### Added

- Human-friendly proposals: optional `title` (≤80 chars) on all submit paths
  (REST, MCP `submit_proposal`, GET `propose`, draft new/submit); responses
  always include `title`, `displayName` (`title ·` server-local datetime), and
  `reviewUrl` (`/mcp#proposal=<id>`). AI guides tell clients to cite
  `displayName` + `reviewUrl` (not the raw id). `/mcp` list headings and audit
  details use `displayName`; deep links open/scroll/highlight the proposal.

### Changed

- Node added/removed diff blocks use a readable summary sentence, show key
  fields (name, wires by node name, code/HTML), and hide the rest under “All
  properties”. HTML templates offer a sandboxed iframe Preview toggle (`sandbox`
  with no `allow-scripts`, `srcdoc`) plus the code view.
- `/mcp` Access Links: Copy link on each active row and on create (brief Copied
  state + clipboard fallback); empty states; relative timestamps with absolute
  on hover; confirm before revoke/approve/reject. List API includes `url` for
  active in-memory links (raw `token` still create-only). Diff lines wrap in
  unified and side-by-side views.

### Fixed

- `/mcp` proposal diffs default to side-by-side on wide screens (unified below
  the narrow breakpoint) and remember the toggle in `localStorage`; short
  single-line fields in Node added/removed blocks stay inline (only long
  multi-line text collapses).
- Proposal diffs compare against the **base flow snapshot** stored at submit
  (`baseFlow`), so later approvals no longer make unrelated nodes look
  “removed”. Pending+stale still warns and may include `vsCurrent`;
  approved/rejected/failed never show the approve-would-fail banner.
- Added/removed nodes in the `/mcp` UI render as single “Node added” / “Node
  removed” blocks (properties collapsed; long text expandable).
- Unknown paths under `/mcp/a/*` return JSON `{ code: not_found }` without
  echoing the access-link token (no HTML `Cannot GET`).
- Draft `append` `totalBytes` counts **decoded** chunk bytes vs `maxBytes` (not
  base64url character length).
- Field-mode `draft/new` validates that `node`/`field` exist on the live flow
  before upload (`mode=json` may add/remove nodes and skips that check).
- Proposal diffs for added/removed nodes include all properties; long text
  fields (`template`, `func`, …) are line-diffed as all-added / all-removed.
- Draft append “no gaps” hint no longer reads like the upload is finished; error
  hints are code-specific (e.g. `chunk_conflict` vs stale rev).
- `/mcp` audit log actor cells expose the full label via `title` when truncated;
  sidebar AI Access TTL/deploy labels stack above their inputs.
- `/mcp` page uses a wide responsive container (`max-width` ~1400px / 95vw);
  proposal diffs default to side-by-side on wide screens with a unified toggle;
  long code/diff blocks scroll horizontally with monospace line numbers.

### Added

- GET patch / `mode=json` drafts support `nodes:[{op:'add'|'remove'|'set',...}]`
  (plus full `replace_flow`); docs cover exact JSON shapes and ~4–5 KB raw chunk
  guidance.
- Self-contained GET access links at `/mcp/a/<token>` for chat AIs that can only
  HTTP GET (markdown docs; scoped status/flows/proposals/propose/drafts; chunked
  drafts for large fields; `Cache-Control: no-store`; per-link rate limit; token
  redaction in paths). Create-link responses include the full `url`; default
  link TTL is **4 hours** (configurable).

### Fixed

- Shared-read REST routes (`/flows`, `/proposals`, …) return
  `access_link_missing` / `access_link_invalid` with Bearer `WWW-Authenticate`
  (not passport `auth_required` / realm=`Users`) when an access-link token is
  missing or invalid.
- `GET /flows/{id}` always includes `flow.type` (defaults to `tab`) so REST
  matches OpenAPI `FlowTab` and MCP `get_flow`.
- Unknown paths under `/mcp/api/v1` return JSON `{ code: not_found }` instead of
  HTML `Cannot GET`.

### Added

- `GET /mcp/api/v1` unauthenticated discovery index (endpoints, auth scheme,
  OpenAPI URL, MCP endpoint).
- `GET /status` accepts access-link Bearer and returns caller label, expiry,
  permissions, and base URLs.
- OpenAPI “Quick start for access-link clients” with example
  `CreateProposalRequest`; `/mcp` **Copy link for AI** includes API base + docs
  hint with the token.

### Removed

- Legacy standalone MCP server (Express/OAuth/SSE entrypoints, Docker images,
  Playwright e2e against `/health`, and related dependencies). The Node-RED
  plugin (`/mcp`, `/mcp/api/v1`, `/mcp/rpc`) is the supported surface.

### Added

- Node-RED plugin scaffold (`ai-access.cjs` / `dist/plugin.cjs`) with `GET /mcp`
  admin page and `GET /mcp/api/v1/status`.
- `aiAccess` settings hook (`allowWithoutAdminAuth` and reserved fields for
  later link TTL, max links, and deployment type).
- Optional `node-red` peerDependency (`>=4.0.0`).
- MCP Streamable HTTP endpoint at `POST /mcp/rpc` (access-link Bearer tools
  mirroring the AI-facing REST API).
- Flow runtime adapter (`RedAdapter` via `RED.runtime`, `HttpAdapter` Admin API
  fallback, factory selection) with rev-checked `updateFlow` (default deployment
  type `nodes`).
- In-memory access-link store and admin routes under `/mcp/api/v1/links`
  (default TTL 24h, max 10 active, token shown once; Bearer middleware for AI
  clients).
- On-disk proposal store and audit log under `<userDir>/.ai-access`, plus REST
  routes for proposals, flows (with rev), and logs. Approve deploys via
  FlowAdapter with rev checks; concurrent approve guarded.
- Trusted write helper for `.ai-access` (call-site file-write suppressions
  removed; sole trust-boundary annotations live in the helper): directory mode
  `0o700`, file mode `0o600`, and size caps on proposal JSON and audit appends
  (`413` when exceeded).
- `/mcp` admin UI for access links (TTL, show-once token, revoke), proposals
  (summary, approve with deploy type, reject, rev-conflict messages), audit log,
  and status. Read-only for `read` users; mutating controls for `*` only.
  Optional `deploymentType` on approve; status exposes link/deploy defaults.
- OpenAPI 3.1 spec for `/mcp/api/v1` (status, links, flows, proposals, logs,
  auth, 413 limits) served at `GET /mcp/api/v1/openapi.yaml`; README install,
  config, `/mcp` usage, and AI quickstart.

[0.2.0-beta.1]:
  https://github.com/com55/node-red-ai-access/compare/v0.1.1...v0.2.0-beta.1
[0.1.1]: https://github.com/com55/node-red-ai-access/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/com55/node-red-ai-access/releases/tag/v0.1.0
