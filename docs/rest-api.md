# REST API

OpenAPI: **`GET /mcp/api/v1/openapi.yaml`** or
**`GET /mcp/api/v1/openapi.json`** (also in
[`api/openapi.yaml`](./api/openapi.yaml)).

| Path                                     | Purpose                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| `GET /ai-access`                         | Admin dashboard (overview, settings, tokens, MCP OAuth, …) |
| `GET /mcp` (browser)                     | `302` redirect to `/ai-access`                             |
| `GET /mcp/a/<token>`                     | Self-contained GET link (markdown docs)                    |
| `GET /mcp/a/<token>/…`                   | Token-scoped GET status/flows/propose/drafts               |
| `POST /mcp/rpc`                          | MCP Streamable HTTP (access-link Bearer; tools)            |
| `POST /mcp`                              | Same MCP endpoint (OAuth resource URL for ChatGPT/Claude)  |
| `GET /mcp/api/v1`                        | Discovery index (no auth; endpoints + auth hint)           |
| `GET /mcp/api/v1/openapi.yaml`           | OpenAPI 3.1 specification (YAML)                           |
| `GET /mcp/api/v1/openapi.json`           | OpenAPI 3.1 specification (JSON)                           |
| `GET /mcp/api/v1/status`                 | Plugin status JSON (admin or access link)                  |
| `GET /mcp/api/v1/settings`               | Effective AI Access settings (admin `read`)                |
| `PUT /mcp/api/v1/settings`               | Update settings (`*`; persists to disk, hot)               |
| `GET /mcp/api/v1/links`                  | List active access links (`*` only)                        |
| `POST /mcp/api/v1/links`                 | Create access link (`*` only; token once)                  |
| `DELETE /mcp/api/v1/links/:id`           | Revoke access link (`*` only)                              |
| `GET /mcp/api/v1/flows`                  | List flows + rev (admin `read` or access link)             |
| `GET /mcp/api/v1/flows/:id`              | Get one flow + rev (admin `read` or access link)           |
| `POST /mcp/api/v1/proposals`             | Create proposal (access-link Bearer only)                  |
| `GET /mcp/api/v1/proposals`              | List proposals (admin: all; link: own)                     |
| `GET /mcp/api/v1/proposals/:id`          | Get proposal (admin: any; link: own)                       |
| `GET /mcp/api/v1/proposals/:id/diff`     | Diff proposal vs current flow (admin `read`/own)           |
| `POST /mcp/api/v1/proposals/:id/approve` | Approve + deploy (`*`; optional deploymentType)            |
| `POST /mcp/api/v1/proposals/:id/reject`  | Reject with reason (`*`; no flow mutate)                   |
| `GET /mcp/api/v1/logs`                   | Append-only audit log (admin `read`)                       |

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
`reviewPath` (relative `/ai-access#/proposals/<id>`). `createdAt` remains
ISO-8601. Review links open a persistent proposal detail page; legacy
`#proposal=<id>` links still work. The list accepts `#proposals` and
`#/proposals`. The `/ai-access` dashboard renders times in the browser's local
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
`secondsRemaining`. See [error codes](./errors.md) (generated from
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
the proposal pending with a persisted `deployPending` reason shown in the API
and dashboard, and holds the approval queue until the runtime settles or the 5
minute hard cap is reached. Before the cap, a late success marks the proposal
approved with its `resultRev`; a late failure clears `deployPending` and keeps
it pending for retry. At the cap the queue and proposal lock are released,
`deployPending.queueReleased` becomes true, and the card asks reviewers to check
the live flow before approving again. Approvals remain blocked until settlement
or a matching confirm-live-checked action, unless explicitly overridden with an
audit entry. Late settlement clears the matching unknown-outcome record. A late
deploy that changes other tabs writes a warning and a `late_deploy_overwrite`
audit entry, even when only editor changes were overwritten. Closed proposals
are alerted only if their decision changed after the cap snapshot. A withdrawn
proposal keeps its decision and shows “Landed after withdraw” if its deploy
lands. Every subsequent approval re-reads live flows before rebasing and
deploying, recognizing already-applied results. Queued approvals time out after
60 seconds with **504** `approve_queue_timeout` without deploying. Queued
proposals can still be rejected or withdrawn; their approvals then return
`proposal_not_pending` when dequeued. These three deadlines are configurable in
`settings.js` under `aiAccess` (positive milliseconds; invalid values use the
defaults shown above). When choosing **proposed** during conflict resolution,
unchanged secret spans keep their live editor values. If spans cannot be aligned
safely, proposed values are retained with a `secret_may_revert` warning on the
dashboard card. Deliberately deleted secret spans do not raise this warning.
Deleting one of several identical secret lines while their live values changed
keeps the proposal in conflict; resolve that field against the live flow or
choose **live**. Changed env arrays with duplicate names show
`duplicate_env_keys`, since pairing by name is ambiguous when entries are
reordered.

Open proposals merge changes per node and tab field. Different fields on the
same node merge automatically; changes to the same field conflict even when both
values are identical. Position (`x`/`y`) edits never conflict; a proposed
position edit wins a tie. Env entries merge by unique name and then entry field;
credentials merge by key (including nested keys). Duplicate env names use an
atomic array comparison and retain the existing ambiguity warning. Deletion
versus modification, id collisions, dangling references, and unsafe redacted
placeholders still block approval.

Proposal responses and diffs expose `baseRev` (an alias of `expectedRev`).
`baseRevChanged` replaces `baseRevStale`: it only reports that the base revision
differs from live for an open proposal. It is informational, including after a
successful rebase. `rebase.rev` is the checked live revision and `rebase.state`
is `clean` (proposal applies unchanged), `merged` (live edits incorporated), or
`conflict` (approval blocked). A merged proposal still requires review of its
current `mergedHash` before approval.

MCP `resolve_proposal_conflict` and REST `POST /proposals/:id/resolve` accept
`nodeId` + `choice: "live" | "proposed"` for one current conflict. Choices
affect only overlapping fields; independent edits from both sides survive.
Existing secret preservation and ambiguity warnings also apply. Alternatively
send `expectedRev` + `payload` to replace the proposal body: node operations
apply to the **flow snapshot at expectedRev**, not to the stored proposal or
merged result, so include every intended edit. These modes cannot be mixed. Both
require the submitting token; tab conflicts use the flow id as `nodeId`.

If the submitting token is lost, a full (`*`) admin can withdraw an open
proposal through `POST /mcp/api/v1/proposals/:id/withdraw` using the dashboard's
authenticated admin session (optional JSON `reason`). Other access tokens,
including replacement tokens, cannot withdraw it. Recovery records
`proposal.withdrawn` with the admin identity, original owner id,
`withdrawalAuthority: "admin-recovery"`, proposal id, and reason. Owner-token
withdrawal records `withdrawalAuthority: "owner-token"`. Withdrawal never
deploys flows and cannot interrupt an in-flight approval.

Open proposals auto-rebase on editor changes. A `conflict` blocks approval until
resolved using REST `POST /proposals/:id/resolve`, admin
`POST /proposals/:id/resolve-conflict`, or MCP `resolve_proposal_conflict`. The
dashboard confirms conflict choices and shows the chosen side. Admins can undo
the latest choice with `POST /proposals/:id/resolve-conflict` and
`{ "nodeId": "...", "choice": "undo" }` until the next proposal edit or choice;
undo restores the proposal and rechecks current live flows without deploying.
Diffs include `conflictValues` (base/live/proposed per field, including flow
env; redacted for AI callers), `rebase`, `liveChanges` and (without conflicts)
`vsCurrent`, the merged deployment. Approval requires the reviewed `mergedHash`
when editor changes are merged. Proposals expire after `proposalTtlDays`
(integer 1–365, default 7), editable through the settings API. Approve may send
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

See also: [AI quickstart](./ai-quickstart.md), [MCP tools](./mcp-tools.md), and
[configuration](./configuration.md).
