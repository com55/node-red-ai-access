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

function renderMcpPageHeader(): string {
  return `
    <header class="page-header">
      <h1>Node-RED AI Access</h1>
      <p class="lede">
        Let an AI assistant suggest changes to your flows — nothing changes until you approve.
      </p>
      <ol class="how-it-works" id="how-it-works" aria-label="How it works">
        <li><strong>Create a link</strong> — temporary access for your AI assistant.</li>
        <li><strong>Give it to your AI</strong> — paste the link in the chat.</li>
        <li><strong>Review proposals</strong> — approve to deploy, or reject.</li>
      </ol>
    </header>
    <div id="boot-flash" class="flash" hidden></div>
    <div id="auth-gate" class="auth-gate" hidden>
      <h2>Please sign in to Node-RED first</h2>
      <p>Open the editor, sign in, then return here to manage AI Access.</p>
      <p class="row">
        <a class="action" id="auth-gate-editor" href="/">Open Node-RED editor</a>
        <a class="action secondary" id="auth-gate-return" href="/mcp">Return to AI Access</a>
      </p>
    </div>
    <div id="toast-host" class="toast-host" aria-live="polite"></div>
    <nav class="tabs" aria-label="Admin views" hidden id="main-nav">
      <button type="button" data-tab="status" aria-selected="true">Status</button>
      <button type="button" data-tab="links" aria-selected="false">Access links</button>
      <button type="button" data-tab="proposals" aria-selected="false">
        Proposals <span class="tab-badge" id="proposals-pending-badge" hidden>0</span>
      </button>
      <button type="button" data-tab="logs" aria-selected="false">Audit log</button>
    </nav>`;
}

function renderMcpPageStatusSection(): string {
  return `
    <section class="panel active" id="section-status" aria-label="Status" hidden>
      <h2>Status</h2>
      <div id="status-flash" class="flash" hidden></div>
      <aside id="status-warning" class="warning" role="status" hidden></aside>
      <div class="dash-grid" id="status-dashboard">
        <div class="dash-card">
          <div class="dash-label">AI access</div>
          <div class="dash-value" id="dash-ai">—</div>
        </div>
        <div class="dash-card">
          <div class="dash-label">Active links</div>
          <div class="dash-value" id="dash-links">—</div>
        </div>
        <div class="dash-card dash-card-clickable" id="dash-pending-card" role="button" tabindex="0">
          <div class="dash-label">Proposals waiting</div>
          <div class="dash-value" id="dash-pending">—</div>
        </div>
        <div class="dash-card">
          <div class="dash-label">Default link expiry</div>
          <div class="dash-value" id="dash-ttl">—</div>
        </div>
      </div>
      <p class="muted permissions-blurb" id="permissions-blurb"></p>
      <details class="tech-details" id="status-diagnostics">
        <summary>Diagnostics <span class="muted">(for troubleshooting)</span></summary>
        <dl class="status">
          <dt>Version</dt><dd id="status-version">—</dd>
          <dt>adminAuth</dt><dd id="status-adminauth">—</dd>
          <dt>AI features</dt><dd id="status-aifeatures">—</dd>
          <dt>Permission</dt><dd id="status-permission">—</dd>
          <dt>Caller</dt><dd id="status-caller">—</dd>
          <dt>Storage</dt><dd id="status-storage">—</dd>
          <dt>Default link expiry</dt><dd id="status-ttl">—</dd>
          <dt>Max active links</dt><dd id="status-maxlinks">—</dd>
          <dt>Default deploy</dt><dd id="status-deploy">—</dd>
        </dl>
        <span class="badge" id="status-badge">loading</span>
      </details>
      <div class="row" style="margin-top:1rem">
        <button type="button" class="action secondary" id="refresh-status">Refresh</button>
      </div>
    </section>`;
}

function renderMcpPageLinksSection(): string {
  return `
    <section class="panel" id="section-links" aria-label="Access links" hidden>
      <h2>Access links</h2>
      <p class="muted" id="links-intro">
        An access link lets an AI assistant read your flows and submit change proposals.
        It cannot deploy anything — you always approve first.
      </p>
      <div id="links-flash" class="flash" hidden></div>
      <div id="links-manage"></div>
      <div id="links-list"></div>
    </section>`;
}

function renderMcpPageProposalsSection(): string {
  return `
    <section class="panel" id="section-proposals" aria-label="Proposals" hidden>
      <h2>Proposals</h2>
      <p id="proposals-hint" class="muted"></p>
      <div class="filter-row" id="proposals-filters" hidden>
        <button type="button" class="filter-chip" data-filter="pending" aria-pressed="true">
          Pending <span id="filter-pending-count">0</span>
        </button>
        <button type="button" class="filter-chip" data-filter="decided" aria-pressed="false">
          Decided <span id="filter-decided-count">0</span>
        </button>
      </div>
      <div id="proposals-flash" class="flash" hidden></div>
      <div id="proposals-list"><p class="muted">Loading…</p></div>
    </section>`;
}

function renderMcpPageLogsSection(): string {
  return `
    <section class="panel" id="section-logs" aria-label="Audit log" hidden>
      <h2>Audit log</h2>
      <div id="logs-flash" class="flash" hidden></div>
      <div class="row logs-toolbar">
        <label>Show
          <select id="logs-filter" aria-label="Filter audit log">
            <option value="">All activity</option>
          </select>
        </label>
        <label class="debug-toggle">
          <input type="checkbox" id="logs-debug" />
          Show raw details
        </label>
      </div>
      <div id="logs-list"><p class="muted">Loading…</p></div>
    </section>`;
}

function renderMcpPageDialogs(): string {
  return `
    <dialog id="reject-dialog">
      <form method="dialog" id="reject-form">
        <h3>Reject proposal</h3>
        <p class="muted">The AI assistant that submitted this proposal will see your reason.</p>
        <label>Reason (optional)
          <textarea id="reject-reason-input" rows="3" maxlength="500" placeholder="Optional note for the AI"></textarea>
        </label>
        <div class="row dialog-actions">
          <button type="submit" value="cancel" class="action secondary">Cancel</button>
          <button type="submit" value="reject" class="action danger">Reject</button>
        </div>
      </form>
    </dialog>

    <dialog id="delete-confirm-dialog">
      <form method="dialog" id="delete-confirm-form">
        <h3>Confirm large deletion</h3>
        <p id="delete-confirm-msg" class="danger-text"></p>
        <label>Type <strong id="delete-confirm-phrase">DELETE</strong> to confirm
          <input id="delete-confirm-input" type="text" autocomplete="off" />
        </label>
        <div class="row dialog-actions">
          <button type="submit" value="cancel" class="action secondary">Cancel</button>
          <button type="submit" value="confirm" class="action danger" id="delete-confirm-btn" disabled>Approve &amp; deploy</button>
        </div>
      </form>
    </dialog>`;
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
  >${renderMcpPageHeader()}
${renderMcpPageStatusSection()}
${renderMcpPageLinksSection()}
${renderMcpPageProposalsSection()}
${renderMcpPageLogsSection()}
${renderMcpPageDialogs()}
  </main>
  <script>${pageClientScript()}</script>
</body>
</html>`;
}
