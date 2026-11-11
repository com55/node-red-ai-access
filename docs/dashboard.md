# Dashboard

Log in to the editor, then open **`/ai-access`** on the admin root (for example
`http://localhost:1880/ai-access`, or `{httpAdminRoot}/ai-access` when
`httpAdminRoot` is set), or click **Open AI Access dashboard** in the editor
sidebar. Opening `/mcp` in a browser redirects to the dashboard (MCP clients
keep using `/mcp`).

The `/ai-access` HTML shell is served without adminAuth so the page can read the
editor token from browser `localStorage` (Node-RED does not use cookies) and
call APIs with `Authorization: Bearer`. If no valid token is present, the page
shows a sign-in card. With credentials login, it posts to
`<httpAdminRoot>/auth/token` as client `node-red-editor` using the password
grant. The token is shared with the editor, stored under the editor's
`localStorage` key (`auth-tokens` at `/`, or e.g. `auth-tokens-admin` at
`/admin`). Other login strategies open the editor to sign in. All data and
actions stay behind permission checks.

The dashboard uses a sticky header with **Overview** (status and diagnostics),
**Access tokens**, **MCP OAuth**, and **Proposals** as text navigation. The sliders
and document icon buttons on the right open **Settings** and **Audit log**. On
mobile, a menu button opens a navigation drawer. **Settings** and **MCP OAuth**
are pages; see [Configuration](./configuration.md) for their controls.

Review happens on a persistent proposal detail page with **Visual View**: real
flow nodes, related-node expansion, editor positions, change diffs against the
live flow, and approval with a choice of deploy type. The proposal list filters
by **Pending**, **Conflict**, **Resolved**, or **All** and shares numeric change
counts with the detail page. The canonical detail hash is `#/proposals/<id>`;
legacy `#proposal=<id>` links still open the detail page. The list accepts
`#proposals` and `#/proposals`.

You can create access tokens, approve or reject proposals, and read a
human-readable audit log. Users with `read` (including guest, if configured) get
a read-only view; only users with `*` can create/revoke links and approve/reject
proposals.

See also: [Configuration](./configuration.md) for the editor sidebar and
Settings / MCP OAuth controls, [AI quickstart](./ai-quickstart.md), and
[MCP OAuth](./oauth.md).
