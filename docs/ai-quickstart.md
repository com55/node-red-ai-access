# AI quickstart

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

See also: [MCP client setup](./mcp-clients.md), [REST API](./rest-api.md), and
[dashboard](./dashboard.md).
