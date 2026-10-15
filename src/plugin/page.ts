/**
 * HTML admin UI for GET /mcp — status, links, proposals, audit log.
 *
 * Served without adminAuth so the browser can read the editor's localStorage
 * Bearer token (Node-RED does not use cookies). APIs remain protected.
 */

import { pageClientScript } from './page-client.js';
import { pageStyles } from './page-styles.js';

export interface RenderMcpPageOptions {
  /** Absolute path prefix for `/mcp/api/v1` (respects httpAdminRoot). */
  apiBase: string;
  /** Absolute path for `/mcp/rpc` (respects httpAdminRoot). */
  mcpRpc?: string;
  /** Editor root for login redirect (httpAdminRoot). */
  editorRoot: string;
  /** localStorage key matching the Node-RED editor auth token. */
  authTokenKey: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Boot shell: no server-side session required. Client authenticates via the
 * editor token in localStorage and loads status/actions over the REST API.
 */
export function renderMcpPage(options: RenderMcpPageOptions): string {
  const config = {
    apiBase: options.apiBase,
    mcpRpc: options.mcpRpc ?? '/mcp/rpc',
    editorRoot: options.editorRoot,
    authTokenKey: options.authTokenKey,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate" />
  <meta http-equiv="Pragma" content="no-cache" />
  <title>Node-RED AI Access</title>
  <style>${pageStyles()}</style>
</head>
<body>
  <main
    id="mcp-root"
    data-config="${escapeHtml(JSON.stringify(config))}"
  >
    <h1>Node-RED AI Access</h1>
    <p class="lede">
      Temporary, owner-approved access for AI clients. Manage access links,
      review proposals, and inspect the audit log.
    </p>
    <div id="boot-flash" class="flash" hidden></div>
    <nav class="tabs" aria-label="Admin views" hidden id="main-nav">
      <button type="button" data-tab="status" aria-selected="true">Status</button>
      <button type="button" data-tab="links" aria-selected="false">Access links</button>
      <button type="button" data-tab="proposals" aria-selected="false">Proposals</button>
      <button type="button" data-tab="logs" aria-selected="false">Audit log</button>
    </nav>

    <section class="panel active" id="section-status" aria-label="Status" hidden>
      <h2>Status</h2>
      <div id="status-flash" class="flash" hidden></div>
      <aside id="status-warning" class="warning" role="status" hidden></aside>
      <dl class="status">
        <dt>Version</dt><dd id="status-version">—</dd>
        <dt>adminAuth</dt><dd id="status-adminauth">—</dd>
        <dt>AI features</dt><dd id="status-aifeatures">—</dd>
        <dt>Permission</dt><dd id="status-permission">—</dd>
        <dt>Caller</dt><dd id="status-caller">—</dd>
        <dt>Storage</dt><dd id="status-storage">—</dd>
        <dt>Default link TTL</dt><dd id="status-ttl">—</dd>
        <dt>Max active links</dt><dd id="status-maxlinks">—</dd>
        <dt>Default deploy</dt><dd id="status-deploy">—</dd>
      </dl>
      <span class="badge" id="status-badge">loading</span>
      <div class="row" style="margin-top:1rem">
        <button type="button" class="action secondary" id="refresh-status">Refresh</button>
      </div>
    </section>

    <section class="panel" id="section-links" aria-label="Access links" hidden>
      <h2>Access links</h2>
      <div id="links-flash" class="flash" hidden></div>
      <div id="links-manage"></div>
      <div id="links-list"></div>
    </section>

    <section class="panel" id="section-proposals" aria-label="Proposals" hidden>
      <h2>Proposals</h2>
      <p id="proposals-hint" class="muted"></p>
      <div id="proposals-flash" class="flash" hidden></div>
      <div id="proposals-list"><p class="muted">Loading…</p></div>
    </section>

    <section class="panel" id="section-logs" aria-label="Audit log" hidden>
      <h2>Audit log</h2>
      <div id="logs-flash" class="flash" hidden></div>
      <div class="row logs-toolbar">
        <label>Action filter
          <select id="logs-filter" aria-label="Filter audit log by action">
            <option value="">All actions</option>
          </select>
        </label>
      </div>
      <div id="logs-list"><p class="muted">Loading…</p></div>
    </section>
  </main>
  <script>${pageClientScript()}</script>
</body>
</html>`;
}
