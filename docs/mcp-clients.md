# MCP client setup

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
