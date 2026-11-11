# Node-RED AI Access

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/com55/node-red-ai-access/actions/workflows/ci.yml/badge.svg)](https://github.com/com55/node-red-ai-access/actions)

Temporary, owner-approved Node-RED access for AI clients. Ships as a **Node-RED
4.x+ plugin** with:

- an admin dashboard at `/ai-access` (browser `GET /mcp` redirects there)
- a versioned REST API under `/mcp/api/v1`
- an MCP JSON-RPC endpoint at `/mcp/rpc` (Streamable HTTP) over the same
  services

**Git mental model:** a proposal is like a pull request. Human approve = merge;
reject = close; withdraw = the author closes their own PR. Revision changes
auto-rebase open proposals. A pending proposal with `rebase.state=conflict`
blocks approval until resolved. Open proposals expire after a configurable TTL
(default 7 days). Every access link can see all proposals (`mine: true|false`).

Derived from
[ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp).

## Install (Node-RED plugin)

Requirements: **Node-RED 4.x or newer**, Node.js 20.19+ (tested: Node-RED 4.1 on
Node 20/22, Node-RED 5.0 on Node 22/24), and **`adminAuth` enabled**
(recommended). Without `adminAuth`, AI features stay off unless you opt in; see
[Configuration](https://github.com/com55/node-red-ai-access/blob/main/docs/configuration.md).

1. In the Node-RED **Palette Manager**, choose **Menu → Manage palette →
   Install**, then search for `@com55/node-red-ai-access`.
2. Or install with npm in your Node-RED user directory:

   ```bash
   cd ~/.node-red
   npm install @com55/node-red-ai-access
   ```

   Stable releases use npm. From 0.2.0-beta.12 onward, pre-releases are `.tgz`
   files available only as GitHub Release assets, not on npm. Pick a version
   from [GitHub Releases](https://github.com/com55/node-red-ai-access/releases)
   and use its exact install command from the release notes. For example,
   replace `X.Y.Z` with the full version, including its pre-release suffix
   (`/data` is typical for Docker; otherwise use `~/.node-red`):

   ```bash
   cd /data && npm i https://github.com/com55/node-red-ai-access/releases/download/vX.Y.Z/com55-node-red-ai-access-X.Y.Z.tgz
   ```

3. Restart Node-RED.

## Quick start

1. Log in to the editor, then open **`/ai-access`** on the admin root (for
   example `http://localhost:1880/ai-access`, or `{httpAdminRoot}/ai-access`
   when `httpAdminRoot` is set), or click **Open AI Access dashboard** in the
   editor sidebar. Opening `/mcp` in a browser redirects to the dashboard (MCP
   clients keep using `/mcp`).
2. Create an access token on the dashboard's **Access tokens** page (admin `*`
   only). Choose the token kind for your client.
3. Either
   [connect an MCP client](https://github.com/com55/node-red-ai-access/blob/main/docs/mcp-clients.md)
   or give an AI the full GET link. Changes become pending proposals for human
   review and approval.

### Choose a channel

Prefer MCP or REST when your client can send custom headers and JSON bodies. Use
a GET link for chat AIs that can only HTTP GET. Each token works on one surface;
choose `mcp`, `rest`, or `get_link` to match the client.

Copy the token when it is created: it is shown only once. Access links are in
memory and become invalid after a Node-RED restart. The default TTL is 4 hours;
GET links are capped at 24 hours, REST / MCP links at 30 days.

### Review changes

The AI reads flows and submits proposals. Open **Proposals** on the dashboard to
review the readable node/property diff against the live flow, then approve or
reject. Approval deploys the changes; rejection never mutates flows. Review in
Visual View at `#/proposals/<id>`; see the
[dashboard](https://github.com/com55/node-red-ai-access/blob/main/docs/dashboard.md)
and
[REST API](https://github.com/com55/node-red-ai-access/blob/main/docs/rest-api.md)
guides.

Users with `read` (including guest, if configured) have a read-only view.
Creating or revoking access links and approving or rejecting proposals require
`*` permission. The **Audit log** page records activity for review.

See the
[AI quickstart](https://github.com/com55/node-red-ai-access/blob/main/docs/ai-quickstart.md)
for GET links and Bearer REST / MCP examples, and the
[dashboard guide](https://github.com/com55/node-red-ai-access/blob/main/docs/dashboard.md)
for sign-in, navigation, and permissions.

## Docs

| Document                                                                                       | Description                                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Channel index](https://github.com/com55/node-red-ai-access/blob/main/docs/README.md)          | GET link / REST / MCP overview                                                   |
| [Dashboard](https://github.com/com55/node-red-ai-access/blob/main/docs/dashboard.md)           | Sign-in, navigation, and permissions                                             |
| [Configuration](https://github.com/com55/node-red-ai-access/blob/main/docs/configuration.md)   | Settings, proxy URLs, CORS, redaction, and storage                               |
| [MCP OAuth](https://github.com/com55/node-red-ai-access/blob/main/docs/oauth.md)               | Endpoints, consent, token lifetimes, and public exposure                         |
| [REST API](https://github.com/com55/node-red-ai-access/blob/main/docs/rest-api.md)             | Routes, MCP JSON-RPC, proposals, and runtime adapters                            |
| [AI quickstart](https://github.com/com55/node-red-ai-access/blob/main/docs/ai-quickstart.md)   | GET links, Bearer REST / MCP, and examples                                       |
| [MCP client setup](https://github.com/com55/node-red-ai-access/blob/main/docs/mcp-clients.md)  | Claude Desktop, Cursor, VS Code, and CLI                                         |
| [MCP tools reference](https://github.com/com55/node-red-ai-access/blob/main/docs/mcp-tools.md) | Generated from live `tools/list`                                                 |
| [Error codes](https://github.com/com55/node-red-ai-access/blob/main/docs/errors.md)            | Code, HTTP status, meaning, hint, and channels                                   |
| [Development](https://github.com/com55/node-red-ai-access/blob/main/docs/development.md)       | Build, test, quality, and generated references                                   |
| [Releasing](https://github.com/com55/node-red-ai-access/blob/main/docs/releasing.md)           | Versioning, release assets, and npm publishing                                   |
| [OpenAPI 3.1](https://github.com/com55/node-red-ai-access/blob/main/docs/api/openapi.yaml)     | Also served at `GET /mcp/api/v1/openapi.yaml` and `GET /mcp/api/v1/openapi.json` |

## Development

Build and test with yarn; see
[Development](https://github.com/com55/node-red-ai-access/blob/main/docs/development.md)
for commands and generated reference checks.

## License

MIT — see
[LICENSE](https://github.com/com55/node-red-ai-access/blob/main/LICENSE).
