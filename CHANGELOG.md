# Changelog

All notable changes to Node-RED AI Access will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.1.0] - 2026-10-15

### Added

- Initial independent release of **Node-RED AI Access**
  (`@com55/node-red-ai-access`), derived from
  [ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp).
- Package metadata, Docker image names, documentation, and CI retargeted to
  `com55/node-red-ai-access`.
- GitHub Actions CI runs on `ubuntu-latest` for all events.

[0.1.0]: https://github.com/com55/node-red-ai-access/releases/tag/v0.1.0
