# Error codes

JSON error bodies use `{ error, code, hint? }` (some also include
channel-specific fields). Channels: **GET** = `/mcp/a/<token>`, **REST** =
`/mcp/api/v1`, **MCP** = `/mcp/rpc`.

| Code                                 | HTTP | Meaning                                    | Hint / next step                                                              | Channels                  |
| ------------------------------------ | ---- | ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------- |
| `access_link_missing`                | 401  | No Bearer / path token                     | Ask the user for a new access link of the right kind                          | GET, REST, MCP            |
| `bearer_scheme_required`             | 401  | Auth used Basic (or non-Bearer)            | Send `Authorization: Bearer <token>`                                          | REST, MCP                 |
| `token_expired`                      | 401  | Known token past `expiresAt`               | Ask the user for a new access link                                            | GET, REST, MCP            |
| `access_link_invalid`                | 401  | Unknown, revoked, or cleared after restart | Ask the user for a new access link                                            | GET, REST, MCP            |
| `wrong_token_kind`                   | 403  | Token kind does not match this surface     | Mint the matching kind on `/mcp` → Access links; show `tellUser` to the human | GET, REST, MCP            |
| `ai_features_disabled`               | 403  | Plugin AI features off                     | Owner enables AI Access / `adminAuth`                                         | GET, REST, MCP            |
| `auth_required`                      | 401  | Admin session required                     | Sign in to Node-RED editor                                                    | REST (admin), `/mcp` APIs |
| `insufficient_permissions`           | 403  | Admin lacks required scope                 | Need `*` for link mint / approve                                              | REST (admin)              |
| `invalid_link_kind`                  | 400  | Unknown `kind` on create                   | Use `get_link`, `rest`, or `mcp`                                              | REST (admin)              |
| `link_create_not_supported`          | 405  | Attempted mint under GET link              | Admin mints via `POST /mcp/api/v1/links` only                                 | GET                       |
| `rate_limited`                       | 429  | Per-IP or per-token limit                  | Wait `retryAfter` / `Retry-After`                                             | GET, REST, MCP            |
| `payload_too_large`                  | 413  | Body / proposal over ~1.5MB                | Shrink content                                                                | GET, REST, MCP            |
| `invalid_json`                       | 400  | Malformed JSON body                        | Fix Content-Type / body                                                       | REST, MCP                 |
| `version_mismatch`                   | 409  | Stale `rev` / `expectedRev`                | Re-read flows and resubmit                                                    | GET, REST, MCP            |
| `proposal_not_pending`               | 409  | Action needs pending proposal              | Only pending can withdraw / decide                                            | GET, REST, MCP            |
| `proposal_not_owned`                 | 403  | Withdraw of another token's proposal       | Only the creating token can withdraw                                          | GET, REST, MCP            |
| `url_too_long`                       | 414  | GET URL over soft cap (~8KB)               | Use chunked drafts or REST/MCP                                                | GET                       |
| `not_found`                          | 404  | Unknown path or resource                   | Re-read docs / discovery                                                      | GET, REST, MCP            |
| `missing_query`                      | 400  | Required search `q` missing                | Pass `?q=`                                                                    | GET, REST                 |
| `text_not_found`                     | 400  | `replace_text` find had no match           | Re-read field; find is exact                                                  | GET, REST, MCP            |
| `ambiguous_match`                    | 409  | `replace_text` matched more than once      | Pass `occurrence` (1-based) or unique find                                    | GET, REST, MCP            |
| `node_not_found` / `field_not_found` | 404  | Unknown node or field                      | Re-read the flow                                                              | GET, REST, MCP            |
| `unknown_node_type`                  | 400  | Proposal uses type not installed           | List node-types / palette search; ask user to install                         | GET, REST, MCP            |
| `node_type_not_found`                | 404  | Unknown type on node-types detail          | List types or search palette                                                  | GET, REST, MCP            |
| `upstream_error`                     | 502  | Node-RED runtime/flows error               | Retry; check Node-RED logs                                                    | GET, REST, MCP            |
| `internal_error`                     | 500  | Unexpected server error                    | Retry; check Node-RED logs                                                    | GET, REST, MCP            |

Validation codes such as `invalid_nodes`, `unwired_node`, `invalid_wires`, and
`missing_config_node` are returned on propose/submit when the payload fails flow
validation — see OpenAPI and channel docs for full lists.
