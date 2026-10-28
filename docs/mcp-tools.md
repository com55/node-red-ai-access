# MCP tools reference

Generated from the live `tools/list` schemas on `POST /mcp/rpc`.
Do not edit by hand — run `yarn generate:mcp-tools` after changing MCP tools.

Tools: **16**

## `get_flow`

Get one tab/subflow by id with nested nodes/configs and the current rev. Pass summary=true for a lightweight node list (id/type/name/wires/bytes, no field contents). Prefer summary → search_flows → get_node_field(lines) → replace_text → submit_proposal. Returns { rev, flow } or summary shape. Use rev as expectedRev when submitting.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | yes | string | Flow / tab id |
| `summary` | no | boolean | When true, return node list with sizes only (no field contents) |

## `get_node`

Get one full node by id (includes owning flowId when known). Optional flow scopes the lookup.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `flow` | no | string | Optional tab id to scope the lookup |
| `id` | yes | string | Node id |

## `get_node_field`

Get one string field from a node. Optional lines="A-B" (1-based inclusive) returns a slice; response always includes totalLines and bytes.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `field` | yes | string | Field name (e.g. template, func) |
| `flow` | no | string | Optional tab id to scope the lookup |
| `id` | yes | string | Node id |
| `lines` | no | string | Optional 1-based line range A or A-B |

## `get_node_type`

Get detail for one installed node type: defaults (JSON), inputs/outputs (always set), requiredConfigNodeTypes, help sections (summary/inputs/outputs), category/module/color. Types are case-sensitive. Pass includeHelp=false to omit help. 404 node_type_not_found when unknown (didYouMean on case mismatch; else nearest names).

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `includeHelp` | no | boolean | When false, omit help sections (default true) |
| `type` | yes | string | Node type id (e.g. inject, template) — case-sensitive |

## `get_proposal`

Get any proposal by id (all tokens can read). Response includes mine:true|false and, for open proposals (pending or conflict), conflictingProposals when other open work touches the same flow. baseRev aliases expectedRev; baseRevChanged is informational. rebase.state=clean|merged means mergeable; conflict blocks approval. Lean by default (no payload/baseFlow); pass include_payload=true for full bodies. Cite displayName + reviewUrl when talking to the user.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | yes | string | Proposal id (prop-…) |
| `include_payload` | no | boolean | When true, include payload and baseFlow |

## `get_proposal_diff`

Diff any proposal against its stored baseFlow snapshot (what changed). Optional format=summary|full (default summary). Open proposals include rebase and liveChanges; conflict blocks approval, otherwise vsCurrent shows the merged deployment.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `format` | no | "summary" \| "full" | Diff payload format (default summary) |
| `id` | yes | string | Proposal id (prop-…) |

## `get_status`

Return plugin status (version, AI feature flags, storage path, deploy defaults). For access-link callers, permission is null and caller.kind is "access-link" — that is expected, not an error. Use before other tools to confirm the plugin is enabled.

_No input parameters._

## `list_flows`

List all flows as a flat Admin API v2 array plus the current rev string. Likely secrets are shown as "[REDACTED]" (nodes list redacted paths in _aiRedactions). Returns { rev, flows }. Call this (or get_flow) before submit_proposal so expectedRev matches.

_No input parameters._

## `list_my_proposals`

Alias of list_proposals. Prefer list_proposals. Lists proposals visible to this access link with optional mine/status/flowId filters and limit/offset pagination.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `flowId` | no | string | Filter by flow tab id (payload.flowId) |
| `include_payload` | no | boolean | When true, include payload and baseFlow on each proposal |
| `limit` | no | integer | Page size (1–200). Omit to return all matches. |
| `mine` | no | boolean | true: only proposals created by this access link; false: only other links’ proposals |
| `offset` | no | integer | Skip this many filtered results (default 0) |
| `status` | no | string \| string[] | Filter by proposal status: one value, an array, or a comma-separated string (pending, conflict, approved, rejected, failed, withdrawn, expired, superseded). An empty array or empty string means no status filter. |

## `list_node_types`

List installed Node-RED palette node types (type, module, category, description, …). Optional q filters type/module/category/description (case-insensitive). Results are capped. Call this before proposing nodes with unfamiliar types.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `q` | no | string | Optional case-insensitive filter |

## `list_proposals`

List proposals visible to this access link (all proposals by default). Each item includes mine:true|false for the caller. Filter with mine, status, and/or flowId; paginate with limit/offset (response includes total, offset, hasMore, nextOffset). Invalid filters return invalid_filter. Returns lean { proposals, total, … } with title, displayName, reviewUrl, changeSummary (no payload/baseFlow unless include_payload=true). Prefer displayName + reviewUrl when referring to a proposal with the user (not the raw id).

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `flowId` | no | string | Filter by flow tab id (payload.flowId) |
| `include_payload` | no | boolean | When true, include payload and baseFlow on each proposal |
| `limit` | no | integer | Page size (1–200). Omit to return all matches. |
| `mine` | no | boolean | true: only proposals created by this access link; false: only other links’ proposals |
| `offset` | no | integer | Skip this many filtered results (default 0) |
| `status` | no | string \| string[] | Filter by proposal status: one value, an array, or a comma-separated string (pending, conflict, approved, rejected, failed, withdrawn, expired, superseded). An empty array or empty string means no status filter. |

## `resolve_proposal_conflict`

Resolve your own open proposal. Different node/tab fields auto-merge; only fields changed on both sides conflict (x/y never conflict). Choose one current conflict using nodeId + choice, preserving all non-conflicting fields. Alternatively replace the proposal using expectedRev + payload: nodes ops apply to the flow snapshot at expectedRev, NOT the stored proposal or merged result; include every intended proposal edit. Read get_proposal_diff for conflicts and get_flow for a fresh rev. These two modes cannot be mixed.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `choice` | no | "live" \| "proposed" | For this conflict, keep live or proposed values of overlapping fields only. Disjoint edits survive. Use with nodeId, without expectedRev/title/payload. |
| `expectedRev` | no | string | Revision of the flow snapshot on which replacement payload ops run. Required with payload; normally the current get_flow rev. |
| `id` | yes | string | Your open proposal id (prop-…) |
| `nodeId` | no | string | Conflict nodeId from rebase.conflicts; use the flow id for tab/env conflicts. Required with choice. |
| `payload` | no | object | Replacement body; required with expectedRev, omitted with nodeId + choice |
| `title` | no | string | Optional replacement title (body replacement mode only) |

## `search_flows`

Text search across string fields. Returns hits with node id, field, line numbers, and a short snippet. Results are capped; truncated=true when the cap is hit. Optional flow scopes to one tab.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `flow` | no | string | Optional tab id |
| `q` | yes | string | Substring to find (case-sensitive; non-empty required) |

## `search_palette`

Search the public Node-RED catalogue for modules to recommend. Returns module id, description, version, updated, link, and installed boolean (cross-checked against installed modules). Core node-red types are not in the catalogue — use list_node_types. RECOMMEND ONLY — never installs.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `q` | yes | string | Search string (id / description / keywords; non-empty required) |

## `submit_proposal`

Submit a replace_flow proposal for owner approval (does not deploy). Preferred for small string edits: payload: { flowId, nodes: [{ op:"replace_text", node, field, find, replace, occurrence? }] } — find must be unique unless occurrence (1-based) is set; multiple replace_text ops apply in order; yields a short readable diff. Or send a full tab: payload.flow from get_flow (id, type, label?, nodes[], configs?). Inputs (all top-level, next to each other): type="replace_flow", expectedRev (required string from list_flows/get_flow rev; expected_rev alias accepted), optional title (≤80 chars), and payload: { flowId, flow? } and/or payload.nodes / top-level nodes. Do not nest expectedRev inside payload. Secret values appear as "[REDACTED]" in reads; leave the placeholder unchanged to keep the stored secret (it is restored on submit), or replace it with a new value to change it. Payload size limit is 1500000 bytes (413 if exceeded). Recent known expectedRev snapshots are accepted and auto-rebased; unknown revisions return 409 version_mismatch. Open proposals auto-rebase on revision changes; conflict blocks approval until resolved. Proposals expire after the configured TTL (default 7 days). replace_text errors: 400 text_not_found; 409 ambiguous_match with matchCount. Unknown palette types return 400 unknown_node_type with nearest matches — call list_node_types / search_palette and ask the user to install via Manage palette (never auto-install). Returns a lean proposal (id, status, title, storedTitle, flowLabel, displayName, reviewUrl, changeSummary, …) by default; title may gain " in <flow>"; storedTitle is the title as saved (your title without that suffix, or the auto-generated title, which may already name the flow). Pass include_payload=true to include payload and baseFlow. When telling the user about the proposal, cite displayName and reviewUrl — not the raw id. Humans approve on the /ai-access dashboard (reviewUrl opens/scrolls to it).

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `expectedRev` | no | string | Top-level current flow revision from get_flow/list_flows (required at submit; sit next to type and payload, not inside payload) |
| `expected_rev` | no | string | Alias for expectedRev (snake_case); prefer expectedRev |
| `include_payload` | no | boolean | When true, include payload and baseFlow in the response (default lean) |
| `nodes` | no | object[] | Optional node ops (set/add/remove/replace_text). Same as payload.nodes when flow is omitted. |
| `payload` | yes | object | Replacement flow payload and/or node ops |
| `title` | no | string | Optional short human title (≤80 chars). Auto-generated from changes when omitted. |
| `type` | yes | "replace_flow" | Must be 'replace_flow' |

## `withdraw_proposal`

Withdraw one of YOUR open (pending or conflict) proposals (status becomes withdrawn, not rejected). Optional reason. Only the creating access link can withdraw via MCP; other tokens get 403. If it is lost, a full admin session can recover via POST /proposals/{id}/withdraw. Cite displayName + reviewUrl when telling the user.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | yes | string | Proposal id (prop-…) owned by this access link |
| `reason` | no | string | Optional withdraw reason |
