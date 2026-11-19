# MCP OAuth

OAuth is disabled by default. Set `aiAccess.publicBaseUrl` to the public HTTPS
origin before enabling it; localhost and loopback HTTP are supported for local
development. Node-RED serves authorization, token, dynamic client registration,
and revocation under `/mcp/oauth/*`. It publishes authorization server metadata
at `/.well-known/oauth-authorization-server` and protected resource metadata at
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource`. The issuer is `publicBaseUrl` and the
resource indicator is `{publicBaseUrl}/mcp`. When `httpNodeRoot` is false,
metadata is available under the admin `/mcp` path instead; the dashboard MCP
OAuth page displays this fallback. Route collisions disable the affected OAuth
endpoints and appear in the sidebar and on the MCP OAuth page.

Clients use authorization code with PKCE S256 and can request `read` or
`propose`. Consent uses the Node-RED editor login. Access tokens last one hour
by default; refresh tokens expire after 30 days of inactivity and rotate on each
use. Reusing a rotated refresh token revokes its token family. Tokens are stored
as SHA-256 hashes in `<userDir>/.ai-access/oauth.json`. Access-link `aia_`
bearer tokens continue to work. See [MCP client setup](./mcp-clients.md).

Add `{publicBaseUrl}/mcp` as the server URL in ChatGPT, Claude and other MCP
clients; `/mcp` and `/mcp/rpc` serve the same MCP endpoint (browsers opening
`/mcp` are redirected to `/ai-access`). At most `oauth.dcrMaxClients`
(default 5) approved clients are kept: lowering the limit removes none, but new
registrations are refused with `400` until clients are revoked.

When you are signed out and Node-RED uses `credentials` login, the consent page
shows its own sign-in form. It calls Node-RED's `/auth/token` endpoint and
stores the resulting editor token in `localStorage` under the editor's key, so
this also signs you in to the Node-RED editor in that browser.

> **Exposing Node-RED publicly:** Node-RED's own `/auth/token` login endpoint is
> not rate limited (neither by Node-RED nor by this plugin). Before exposing
> Node-RED to the internet for OAuth, put it behind a reverse proxy or other
> limiter that throttles `POST {httpAdminRoot}/auth/token` (and preferably the
> whole admin path), and use strong passwords.

See also: [Configuration](./configuration.md) (including Public URL **Check**
and settings controls), [MCP client setup](./mcp-clients.md), and
[dashboard](./dashboard.md).
