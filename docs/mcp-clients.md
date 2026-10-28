# MCP client setup

## OAuth (for clients with OAuth discovery)

Enable MCP OAuth in the AI Access editor sidebar and set a public HTTPS origin
in **Public URL**. Give the client the MCP endpoint
`https://YOUR-NODE-RED/mcp/rpc`. It can discover the authorization server from
the protected resource metadata, register itself, and request `read` or
`propose` scope. Sign in to Node-RED and approve the client on the consent page.
The sidebar lists registered clients and lets an admin revoke them and their
tokens. Localhost HTTP is supported for development. If `httpNodeRoot` is
disabled, see the sidebar warning for the metadata fallback path.

## Access-link bearer tokens

Use an **mcp** access-link token from `/mcp` → Access links (kind = MCP token).
Endpoint: `POST https://YOUR-NODE-RED/mcp/rpc` with
`Authorization: Bearer <mcp-token>`.

If your AI app cannot add MCP servers, create a **REST** or **GET link** token
instead.

Replace placeholders — never commit real hosts or tokens to shared repos.

## Claude Desktop

`claude_desktop_config.json` → `mcpServers`:

```json
{
  "mcpServers": {
    "node-red-ai-access": {
      "url": "https://YOUR-NODE-RED/mcp/rpc",
      "headers": {
        "Authorization": "Bearer aia_…"
      }
    }
  }
}
```

## Cursor

`.cursor/mcp.json` (or project `mcp.json`):

```json
{
  "mcpServers": {
    "node-red-ai-access": {
      "url": "https://YOUR-NODE-RED/mcp/rpc",
      "headers": {
        "Authorization": "Bearer aia_…"
      }
    }
  }
}
```

## VS Code

MCP servers config (HTTP type):

```json
{
  "servers": {
    "node-red-ai-access": {
      "type": "http",
      "url": "https://YOUR-NODE-RED/mcp/rpc",
      "headers": {
        "Authorization": "Bearer aia_…"
      }
    }
  }
}
```

## Claude Code CLI

```bash
claude mcp add --transport http node-red-ai-access https://YOUR-NODE-RED/mcp/rpc \
  --header "Authorization: Bearer aia_…"
```

## Generic Streamable HTTP

- **URL:** `https://YOUR-NODE-RED/mcp/rpc`
- **Header:** `Authorization: Bearer aia_…`
- **Method:** `POST` with `Accept: application/json, text/event-stream`
- **Body:** JSON-RPC 2.0 (`tools/list`, `tools/call`, …)

See [MCP tools reference](./mcp-tools.md) for the tool list.
