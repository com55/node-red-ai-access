<!-- Generated from src/plugin/error-registry.ts — run `yarn generate:errors`. Do not edit by hand. -->

# Error codes

JSON error bodies use `{ error, code, hint? }` (some also include
channel-specific fields). Channels: **GET** = `/mcp/a/<token>`, **REST** =
`/mcp/api/v1`, **MCP** = `/mcp/rpc` (tool results with `isError: true` carry
the same JSON plus `statusCode`), **admin** = owner-only `/mcp/api/v1` routes.

GET-link `401` responses include a `WWW-Authenticate: Bearer …` header.

## Errors

| Code | HTTP | Meaning | Hint / next step | Channels |
| --- | --- | --- | --- | --- |
| `deploy_timeout` | 504 | Deployment exceeded the 60 second deadline; deployPending records an unknown outcome and approvals wait for the runtime to settle | A late success marks the proposal approved with resultRev; a late failure clears deployPending and keeps it pending for retry | admin |
| `proposal_conflict` | 409 | Editor and proposal changes conflict (conflicts contains field names only) | Read the current flow and resolve the proposal before approval | GET, REST, MCP, admin |
| `rebase_ack_required` | 409 | The merged result needs review (mergedHash included) | Review the diff and approve with its mergedHash | admin |
| `rebase_race` | 409 | Flows kept changing during approval | Recheck the proposal and retry approval | admin |
| `conflict_not_found` | 409 | The requested conflict no longer exists | Reload the proposal and its conflicts | admin |
| `invalid_choice` | 400 | Invalid manual conflict choice | Use an available live or proposed choice | admin |
| `flow_id_mismatch` | 400 | Resolution tried to change the proposal flow id | Keep the same flowId or submit a new proposal | REST, MCP |
| `access_link_missing` | 401 | No Bearer / path token | Ask the user for a new access link of the right kind | GET, REST, MCP |
| `bearer_scheme_required` | 401 | Auth used Basic (or non-Bearer) | Send `Authorization: Bearer <token>` | REST, MCP |
| `token_expired` | 401 | Known token past `expiresAt` (body includes `expiredAt` and `accessLinksUrl`) | Ask the user to create a new link on the `/ai-access` dashboard → Access tokens (`accessLinksUrl`) | GET, REST, MCP |
| `access_link_invalid` | 401 | Unknown, revoked, or cleared after restart | Ask the user for a new access link | GET, REST, MCP |
| `wrong_token_kind` | 403 | Token kind does not match this surface | Mint the matching kind on `/ai-access` → Access tokens; show `tellUser` to the human | GET, REST, MCP |
| `ai_features_disabled` | 403 | Plugin AI features off | Owner enables AI Access / `adminAuth` | GET, REST, MCP |
| `auth_required` | 401 | Admin session required | Sign in to the Node-RED editor | admin |
| `insufficient_permissions` | 403 | Admin lacks required scope | Need `*` for link mint / approve | admin |
| `invalid_link_kind` | 400 | Unknown `kind` on create | Use `get_link`, `rest`, or `mcp` | admin |
| `invalid_ttl` | 400 | `ttlSeconds` is zero, negative, not a number, or over the cap for the kind | ttlSeconds must be a positive number of seconds within the cap for the token kind: get_link ≤ 86400 (24h); rest and mcp ≤ 2592000 (30 days). | admin |
| `access_link_limit` | 409 | Too many active links | Revoke an existing link first | admin |
| `access_link_not_found` | 404 | Unknown link id on revoke | List links and use an existing id | admin |
| `link_create_not_supported` | 403 | Attempted mint under a GET link | Admin mints via `POST /mcp/api/v1/links` only | GET |
| `rate_limited` | 429 | Per-IP or per-token limit | Wait `retryAfter` / `Retry-After` | GET, REST, MCP |
| `payload_too_large` | 413 | Body / proposal over ~1.5MB | Shrink content | GET, REST, MCP |
| `invalid_json` | 400 | Malformed JSON body | Fix Content-Type / body | REST, MCP |
| `unsupported_media_type` | 415 | POST body is not `application/json` | Send `Content-Type: application/json` | REST, MCP |
| `url_too_long` | 414 | GET URL over soft cap (~8KB) | Use chunked drafts or REST/MCP | GET |
| `not_found` | 404 | Unknown path or resource | Re-read docs / discovery | GET, REST, MCP |
| `missing_query` | 400 | Required search `q` missing | Pass `?q=` | GET, REST |
| `invalid_filter` | 400 | Invalid list filter (`status`, `limit`, `offset`, `mine`); body names `parameter` and `allowed` | Use an allowed value: status one of the proposal statuses; limit integer 1–200; offset integer ≥ 0; mine true\|false | GET, REST, MCP |
| `invalid_arguments` | 400 | MCP tool arguments failed schema validation; body names `parameter` | Fix the named argument to match the tool input schema (see tools/list) | MCP |
| `invalid_diff_format` | 400 | Unknown `format` on proposal diff | Use `format=summary` (default) or `format=full` | GET, REST, MCP |
| `confirm_required` | 400 | GET withdraw without `confirm=1` | Repeat the request with `confirm=1` | GET |
| `missing_expected_rev` | 400 | Proposal submitted without `expectedRev` / `rev` | Read the flow and pass its `rev` | GET, REST, MCP |
| `version_mismatch` | 409 | Unknown or unavailable `rev` / `expectedRev` snapshot | Re-read flows and resubmit | GET, REST, MCP |
| `proposal_not_found` | 404 | Unknown proposal id | List proposals and use an existing id | GET, REST, MCP |
| `proposal_not_pending` | 409 | Action needs an open proposal | Only pending or conflict proposals can withdraw / decide | GET, REST, MCP |
| `proposal_not_owned` | 403 | Withdraw of another token’s proposal | Only the creating token can withdraw | GET, REST, MCP |
| `validation_failed` | 400 | Several validation errors at once (message `N validation errors`) | Fix every entry in errors[] and resubmit. | GET, REST, MCP |
| `duplicate_node_id` | 400 | The same node id appears more than once in a full tab or batch | Give every node a unique id | GET, REST, MCP |
| `missing_node_id` | 400 | Node / op without an id | Include a non-empty string id | GET, REST, MCP |
| `missing_node_type` | 400 | Node without a `type` | Set `type` to an installed palette type name | GET, REST, MCP |
| `invalid_node_type` | 400 | `type` is not a string | Use the palette type name exactly | GET, REST, MCP |
| `invalid_nodes` | 400 | `flow.nodes` / `flow.configs` not an array | Send arrays (use `[]` to clear) | GET, REST, MCP |
| `invalid_node` | 400 | Node entry is not an object | Send `{ id, type, … }` objects | GET, REST, MCP |
| `invalid_wires` | 400 | Bad wires shape, missing target, or more ports than outputs | Wire only to existing node ids / ports | GET, REST, MCP |
| `z_mismatch` | 400 | Node `z` differs from the flow id | Set `z` to the tab id or omit it | GET, REST, MCP |
| `node_already_exists` | 400 | `add` op for an id already in the flow | Use `set` or a new id | GET, REST, MCP |
| `protected_property` | 400 | Tried to change id / type / z | Omit id, type, and z from edits | GET, REST, MCP |
| `node_not_found` | 404 | Unknown node (single error only; several errors → `validation_failed`) | Re-read the flow | GET, REST, MCP |
| `field_not_found` | 404 | Unknown field on a node | Re-read the node | GET, REST, MCP |
| `text_not_found` | 400 | `replace_text` find had no match | Re-read field; find is exact | GET, REST, MCP |
| `ambiguous_match` | 409 | `replace_text` matched more than once | Pass `occurrence` (1-based) or unique find | GET, REST, MCP |
| `unknown_node_type` | 400 | Proposal uses a type that is not installed | List node-types / palette search; ask user to install | GET, REST, MCP |
| `node_type_not_found` | 404 | Unknown type on node-types detail | List types or search palette | GET, REST, MCP |
| `chunk_conflict` | 409 | Same draft seq re-sent with different data | Re-send identical data or start a new draft | GET |
| `missing_chunks` | 400 | Draft submit with gaps in seq | Upload every seq from 0 through max | GET |
| `draft_hash_mismatch` | 400 | Draft sha256 does not match assembled bytes | Send the hex sha256 of the assembled UTF-8 | GET |
| `redacted_placeholder_mismatch` | 400 | A `[REDACTED]` placeholder was added, duplicated, moved, or its env/header name changed | Keep placeholders exactly where they were shown (same line, same name) or supply a real value | GET, REST, MCP |
| `upstream_error` | 502 | Node-RED runtime/flows error | Retry; check Node-RED logs | GET, REST, MCP |
| `internal_error` | 500 | Unexpected server error | Retry; check Node-RED logs | GET, REST, MCP |

## Warnings

Returned in `warnings[]` on a successful propose/submit; they never block.

| Code | HTTP | Meaning | Hint / next step | Channels |
| --- | --- | --- | --- | --- |
| `duplicate_env_keys` | 200 | Changed env arrays contain duplicate names; pairing by name is ambiguous when entries are reordered | Review the env values before approval | GET, REST, MCP, admin |
| `secret_may_revert` | 200 | Secret spans could not be aligned during proposed conflict resolution; proposed values were kept | Review the warned field against live flows before approval; an editor secret change may be reverted | GET, REST, MCP, admin |
| `missing_config_node` | 201 | Warning: node has no (or an unresolved) config node yet | Configure before deploy if needed; see `candidates` | GET, REST, MCP |
| `unwired_node` | 201 | Warning: node has outputs but no wires | Wire it, or ignore while scaffolding | GET, REST, MCP |
| `incomplete_wires` | 201 | Warning: fewer wire ports than outputs | Add ports if outputs should connect | GET, REST, MCP |
| `secret_destination_changed` | 201 | Warning: a node holding a restored secret changed where it sends data (url/host/method/headers/…) | Reviewer must verify the new destination before approving | GET, REST, MCP |
| `secret_node_code_changed` | 201 | Warning: a node holding a restored secret had its code changed | Reviewer must check the code does not send the secret elsewhere | GET, REST, MCP |
| `secret_wires_changed` | 201 | Warning: a node holding a restored secret had its output wires changed | Reviewer must check where its messages now go | GET, REST, MCP |
| `secret_scope_changed` | 201 | Warning: tab/group env or a config node scoping a secret-holding node changed | Reviewer must check env-resolved hosts/URLs (e.g. `${API_HOST}`) | GET, REST, MCP |
| `outbound_node_changed` | 201 | Warning: proposal adds/changes an outbound-capable node (http request/response, mqtt, tcp, udp, email, websocket, link out/call, function, exec, file, or any node with url/host fields) | Reviewer must check it cannot send secret data elsewhere | GET, REST, MCP |
| `secret_tab_changed` | 201 | Warning: proposal with restored secrets also changes other nodes in the tab | Review every change before approving | GET, REST, MCP |
| `secret_reference_added` | 201 | Warning: an added/changed node now reads a secret-named env/global/flow value (env.get, $env, ${…}, typed input) | Reviewer must check the value is not sent anywhere unexpected | GET, REST, MCP |

## Proposal statuses

| Code | HTTP | Meaning | Hint / next step | Channels |
| --- | --- | --- | --- | --- |
| `conflict` | 200 | Status: open proposal has conflicting editor changes; approval blocked | Read the current flow and resolve the proposal | GET, REST, MCP |
| `expired` | 200 | Status: open proposal expired after the configured TTL (default 7 days) | Re-read the flow and submit a new proposal | GET, REST, MCP |
| `superseded` | 200 | Legacy closed status; new approvals rebase other open proposals | Re-read the flow and submit a new proposal if still needed | GET, REST, MCP |
