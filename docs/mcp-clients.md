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

Notes:

- Redirect URIs must use `https://`, or `http://` on a loopback host
  (`localhost`, `127.0.0.1`, `[::1]`). Custom native-app schemes such as
  `myapp://callback` are not supported.
- The consent page uses your Node-RED editor login from the same browser (the
  editor keeps its token in browser storage, not a cookie). Open the editor on
  the same origin as the Public URL and sign in first; the consent page offers a
  Retry button after you sign in.
- Users with read-only Node-RED permission can approve only the `read` scope;
  `propose` requires full (`*`) permission.
- Clients that register but are never approved are removed after one hour and do
  not count toward the client limit.
- Refresh tokens are sliding: each refresh renews the idle lifetime. A token
  chain also has a maximum lifetime of 90 days from approval by default; after
  that the client must sign in again. Change it in the sidebar (0 = unlimited).
  Lowering the maximum applies immediately to existing token chains. Raising it
  or setting 0 does not extend the refresh token a client already holds; the new
  limit takes effect from that chain's next successful refresh (and for new
  chains).

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
