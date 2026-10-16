# MCP tools reference

Generated from the live `tools/list` schemas on `POST /mcp/rpc`.
Do not edit by hand — run `yarn generate:mcp-tools` after changing MCP tools.

Tools: **15**

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

Get any proposal by id (all tokens can read). Response includes mine:true|false and, for pending proposals, conflictingProposals when other pending work touches the same flow. Lean by default (no payload/baseFlow); pass include_payload=true for full bodies. Cite displayName + reviewUrl when talking to the user.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | yes | string | Proposal id (prop-…) |
| `include_payload` | no | boolean | When true, include payload and baseFlow |

## `get_proposal_diff`

Diff any proposal against its stored baseFlow snapshot (what changed). Optional format=summary|full (default summary). Pending + stale also includes vsCurrent.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `format` | no | "summary" \| "full" | Diff payload format (default summary) |
| `id` | yes | string | Proposal id (prop-…) |

## `get_status`

Return plugin status (version, AI feature flags, storage path, deploy defaults). For access-link callers, permission is null and caller.kind is "access-link" — that is expected, not an error. Use before other tools to confirm the plugin is enabled.

_No input parameters._

## `list_flows`

List all flows as a flat Admin API v2 array plus the current rev string. Returns { rev, flows }. Call this (or get_flow) before submit_proposal so expectedRev matches.

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
| `status` | no | string \| string[] | Filter by proposal status: one value, an array, or a comma-separated string (pending, approved, rejected, failed, withdrawn, expired, superseded). An empty array or empty string means no status filter. |

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
| `status` | no | string \| string[] | Filter by proposal status: one value, an array, or a comma-separated string (pending, approved, rejected, failed, withdrawn, expired, superseded). An empty array or empty string means no status filter. |

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

Submit a replace_flow proposal for owner approval (does not deploy). Preferred for small string edits: payload: { flowId, nodes: [{ op:"replace_text", node, field, find, replace, occurrence? }] } — find must be unique unless occurrence (1-based) is set; multiple replace_text ops apply in order; yields a short readable diff. Or send a full tab: payload.flow from get_flow (id, type, label?, nodes[], configs?). Inputs (all top-level, next to each other): type="replace_flow", expectedRev (required string from list_flows/get_flow rev; expected_rev alias accepted), optional title (≤80 chars), and payload: { flowId, flow? } and/or payload.nodes / top-level nodes. Do not nest expectedRev inside payload. Payload size limit is 1500000 bytes (413 if exceeded). expectedRev is checked against the live rev at submit time (409 if stale). replace_text errors: 400 text_not_found; 409 ambiguous_match with matchCount. Unknown palette types return 400 unknown_node_type with nearest matches — call list_node_types / search_palette and ask the user to install via Manage palette (never auto-install). Returns a lean proposal (id, status, title, storedTitle, flowLabel, displayName, reviewUrl, changeSummary, …) by default; title may gain " in <flow>" while storedTitle is exactly what was stored. Pass include_payload=true to include payload and baseFlow. When telling the user about the proposal, cite displayName and reviewUrl — not the raw id. Humans approve on the /mcp page (reviewUrl opens/scrolls to it).

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

Withdraw one of YOUR pending proposals (status becomes withdrawn, not rejected). Optional reason. Only the creating access link can withdraw; other tokens get 403. Cite displayName + reviewUrl when telling the user.

| Parameter | Required | Type | Description |
| --- | --- | --- | --- |
| `id` | yes | string | Proposal id (prop-…) owned by this access link |
| `reason` | no | string | Optional withdraw reason |
