# Node-RED AI Access documentation

Temporary, owner-approved Node-RED access for AI clients over three channels:

| Channel      | Surface            | Token kind | Best for                                             |
| ------------ | ------------------ | ---------- | ---------------------------------------------------- |
| **GET link** | `/mcp/a/<token>/…` | `get_link` | Chat AIs that can only HTTP GET (no custom headers)  |
| **REST**     | `/mcp/api/v1/…`    | `rest`     | Clients that can send `Authorization: Bearer` + JSON |
| **MCP**      | `POST /mcp/rpc`    | `mcp`      | MCP-capable apps (Streamable HTTP)                   |

Prefer **MCP** or **REST** when the client can send custom headers and JSON
bodies. Use a **GET link** only as a fallback for headerless GET-only clients.

## Index

- [MCP client setup](./mcp-clients.md) — Claude Desktop, Cursor, VS Code, Claude
  Code CLI, generic Streamable HTTP
- [MCP tools reference](./mcp-tools.md) — generated from live `tools/list`
  schemas
- [Error codes](./errors.md) — code, HTTP status, meaning, hint, channels
- [Releasing](./releasing.md) — version bump, CHANGELOG, tag, npm trusted
  publishing
- [OpenAPI 3.1](./api/openapi.yaml) — also served at
  `GET /mcp/api/v1/openapi.yaml` (JSON: `GET /mcp/api/v1/openapi.json`)
- Discovery guide — `GET /mcp/api/v1` (unauthenticated JSON index)

Mint tokens on the dashboard at `/ai-access` → **Access tokens** (admin `*`
only). Each token works on **one** surface; wrong kind → `403 wrong_token_kind`.
