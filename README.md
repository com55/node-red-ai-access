# Node-RED AI Access

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue.svg)](https://www.typescriptlang.org/)
[![CI](https://github.com/com55/node-red-ai-access/actions/workflows/ci.yml/badge.svg)](https://github.com/com55/node-red-ai-access/actions)

Temporary, owner-approved Node-RED access for AI clients. Ships as a **Node-RED
4.x+ plugin** with:

- an admin page at `/mcp`
- a versioned REST API under `/mcp/api/v1`
- an MCP JSON-RPC endpoint at `/mcp/rpc` (Streamable HTTP) over the same
  services

Derived from
[ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp).

## Install (Node-RED plugin)

Requirements: **Node-RED 4.x or newer**, Node.js 22+, and **`adminAuth`
enabled** (recommended). Without `adminAuth`, AI features stay off unless you
opt in (see Configuration).

1. Install into your Node-RED user directory (or via the palette):

   ```bash
   cd ~/.node-red
   npm install @com55/node-red-ai-access
   ```

2. Restart Node-RED.
3. Log in to the editor, then open **`/mcp`** on the admin root (for example
   `http://localhost:1880/mcp`, or `{httpAdminRoot}/mcp` when `httpAdminRoot` is
   set).

On `/mcp` you can create access links, review proposals, approve or reject
changes, and read the audit log. Users with `read` (including guest, if
configured) get a read-only view; only users with `*` can create/revoke links
and approve/reject proposals. Unauthenticated visits redirect to the editor
login.

## Configuration

In `settings.js`:

```js
module.exports = {
  // adminAuth: { ... }, // required for AI features in normal setups
  aiAccess: {
    // Local-only opt-in when adminAuth is disabled (default: false)
    allowWithoutAdminAuth: false,
    // Access-link default TTL in seconds (default: 86400 = 24h)
    defaultLinkTtlSeconds: 86400,
    // Max concurrent active access links (default: 10)
    maxActiveLinks: 10,
    // Deploy type used on approve (default: "nodes"; also "flows" | "full")
    defaultDeploymentType: 'nodes',
  },
};
```

Storage lives under **`<userDir>/.ai-access`** (`proposals/*.json` and
append-only `logs/audit.jsonl`). Directories use mode `0700`, files `0600`.
Oversized proposal JSON or audit lines return HTTP **413**.

## REST API

OpenAPI: **`GET /mcp/api/v1/openapi.yaml`** (also in
[`docs/api/openapi.yaml`](docs/api/openapi.yaml)).

| Path                                     | Purpose                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `GET /mcp`                               | Admin UI (status, links, proposals, audit log)   |
| `POST /mcp/rpc`                          | MCP Streamable HTTP (access-link Bearer; tools)  |
| `GET /mcp/api/v1/openapi.yaml`           | OpenAPI 3.1 specification (YAML)                 |
| `GET /mcp/api/v1/status`                 | Plugin status JSON                               |
| `GET /mcp/api/v1/links`                  | List active access links (`*` only)              |
| `POST /mcp/api/v1/links`                 | Create access link (`*` only; token once)        |
| `DELETE /mcp/api/v1/links/:id`           | Revoke access link (`*` only)                    |
| `GET /mcp/api/v1/flows`                  | List flows + rev (admin `read` or access link)   |
| `GET /mcp/api/v1/flows/:id`              | Get one flow + rev (admin `read` or access link) |
| `POST /mcp/api/v1/proposals`             | Create proposal (access-link Bearer only)        |
| `GET /mcp/api/v1/proposals`              | List proposals (admin: all; link: own)           |
| `GET /mcp/api/v1/proposals/:id`          | Get proposal (admin: any; link: own)             |
| `POST /mcp/api/v1/proposals/:id/approve` | Approve + deploy (`*`; optional deploymentType)  |
| `POST /mcp/api/v1/proposals/:id/reject`  | Reject with reason (`*`; no flow mutate)         |
| `GET /mcp/api/v1/logs`                   | Append-only audit log (admin `read`)             |

### MCP JSON-RPC (`POST /mcp/rpc`)

AI clients can use the official MCP Streamable HTTP transport against
`{httpAdminRoot}/mcp/rpc` with the same access-link Bearer token as the REST
API. Tools mirror the AI-facing REST surface only:

`get_status`, `list_flows`, `get_flow`, `submit_proposal` (including
`replace_flow` with `expected_rev` / `expectedRev`), `list_my_proposals`,
`get_proposal`.

Approve, reject, and access-link management stay human-only on the `/mcp` admin
page (and the corresponding REST routes). Rate limits, payload size limits, and
audit logging match REST. Invalid or expired tokens return **401** telling the
AI to ask the user for a new access link.

Access links are **in memory** (default TTL 24h, max 10). The raw token is
returned once at creation; after a restart every old token is invalid.

Approve may send `deploymentType`: `nodes` (default), `flows`, or `full`. A
stale `expectedRev` marks the proposal **rejected** with a resubmit message;
other deploy errors mark it **failed**. Reject never mutates flows.

### Flow runtime adapter

- **RedAdapter** — in-process `RED.runtime.flows`
- **HttpAdapter** — localhost Admin API v2 fallback
- **`updateFlow`** — requires `expectedRev`; default deployment type `nodes`

## AI quickstart

1. An owner with `*` opens `/mcp` → **Access links** → create a link (copy the
   token once).
2. The AI client sends `Authorization: Bearer <token>` to REST and/or MCP:

   - REST: `GET /mcp/api/v1/flows`, `GET /mcp/api/v1/flows/{id}`,
     `POST /mcp/api/v1/proposals`, `GET /mcp/api/v1/proposals`
   - MCP: `POST /mcp/rpc` tools `list_flows`, `get_flow`, `submit_proposal`,
     `list_my_proposals` (same access-link auth and limits)

3. The owner reviews the proposal on `/mcp` and approves or rejects it.
4. If the token is invalid, expired, revoked, or cleared by a restart, the API
   returns **401** telling the AI to **ask the user for a new access link**.

Example create body:

```json
{
  "type": "replace_flow",
  "expectedRev": "abc123",
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

## Development

```bash
yarn install
yarn build
yarn test
yarn quality
```

## License

MIT — see [LICENSE](LICENSE).
