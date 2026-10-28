/**
 * HTML dashboard for GET /ai-access — overview, settings, access tokens, OAuth,
 * proposals, audit log. (Browser GETs of /mcp redirect here.)
 *
 * Served without adminAuth so the browser can read the editor's localStorage
 * Bearer token (Node-RED does not use cookies). APIs remain protected.
 */

import { LOGO } from './oauth-consent-page.js';
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
  /** Absolute dashboard path (`/ai-access`, respects httpAdminRoot). */
  dashboardPath?: string;
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
      <main class="sg-card" role="dialog" aria-modal="true" aria-labelledby="auth-gate-title">
        <div class="sg-head">${LOGO}<div class="sg-brand"><b>Node-RED AI Access</b><span>Dashboard</span></div></div>
        <div class="sg-body">
          <h1 id="auth-gate-title">Sign in to Node-RED</h1>
          <p class="sg-sub">AI Access uses your Node-RED editor account. Signing in here also signs in the editor in this browser.</p>
          <p id="auth-gate-status" class="sg-status" role="status" aria-live="polite">Checking how Node-RED signs you in…</p>
          <form id="auth-gate-login" class="sg-login" hidden autocomplete="on">
            <label>Username<input id="auth-gate-username" name="username" autocomplete="username" required></label>
            <label>Password<input id="auth-gate-password" name="password" type="password" autocomplete="current-password" required></label>
            <div class="sg-actions"><button id="auth-gate-submit" class="sg-primary" type="submit">Sign in</button></div>
          </form>
          <div class="sg-actions">
            <button id="auth-gate-editor" class="sg-primary" type="button" hidden>Sign in with the Node-RED editor</button>
            <button id="auth-gate-retry" class="sg-secondary" type="button" hidden>Retry</button>
          </div>
        </div>
        <div class="sg-foot">You only need to sign in once — the dashboard continues automatically.</div>
      </main>
    </div>
    <div id="toast-host" class="toast-host" aria-live="polite"></div>
    <nav class="tabs" aria-label="Admin views" hidden id="main-nav">
      <button type="button" data-tab="status" aria-selected="true">Overview</button>
      <button type="button" data-tab="settings" aria-selected="false">Settings</button>
      <button type="button" data-tab="links" aria-selected="false">Access tokens</button>
      <button type="button" data-tab="oauth" aria-selected="false">OAuth</button>
      <button type="button" data-tab="proposals" aria-selected="false">
        Proposals <span class="tab-badge" id="proposals-pending-badge" hidden>0</span>
      </button>
      <button type="button" data-tab="logs" aria-selected="false">Audit log</button>
    </nav>`;
}

function renderMcpPageStatusSection(): string {
  return `
    <section class="panel active" id="section-status" aria-label="Overview" hidden>
      <h2>Overview</h2>
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
          <dt>Your role</dt>
          <dd id="status-role"
            title="This is your Node-RED permission. AI access links can only read flows and propose changes — they cannot deploy.">—</dd>
          <dt>Permission</dt><dd id="status-permission">—</dd>
          <dt>Caller</dt><dd id="status-caller">—</dd>
          <dt>Storage</dt><dd id="status-storage">—</dd>
          <dt>Default link expiry</dt><dd id="status-ttl">—</dd>
          <dt>Max active links</dt><dd id="status-maxlinks">—</dd>
          <dt>Default deploy</dt><dd id="status-deploy">—</dd>
        </dl>
      </details>
      <div class="row" style="margin-top:1rem">
        <button type="button" class="action secondary" id="refresh-status">Refresh</button>
      </div>
    </section>`;
}

function renderMcpPageLinksSection(): string {
  return `
    <section class="panel" id="section-links" aria-label="Access tokens" hidden>
      <h2>Access tokens</h2>
      <p class="muted" id="links-intro">
        Create a token for the channel your AI uses: a GET link to paste in chat,
        a REST Bearer, or an MCP token. It can read flows and submit proposals —
        it cannot deploy anything until you approve.
      </p>
      <div id="links-flash" class="flash" hidden></div>
      <div id="links-manage"></div>
      <div id="links-list"></div>
    </section>`;
}

function lockBadge(field: string): string {
  return `<span class="lock-badge" id="lock-${field}" hidden>Locked by settings.js</span>`;
}

function renderMcpPageSettingsSection(): string {
  return `
    <section class="panel" id="section-settings" aria-label="Settings" hidden>
      <h2>Settings</h2>
      <p class="muted">Changes save automatically and apply immediately (no restart).</p>
      <div id="settings-flash" class="flash" hidden></div>
      <p id="settings-readonly" class="notice" hidden>Read-only: full admin permission (*) is required to change these settings.</p>
      <div class="settings-grid">
        <div class="card settings-card">
          <h3>General</h3>
          <div class="form-row toggle-row" id="row-enabled">
            <label class="switch-label"><input type="checkbox" id="set-enabled" />
              <span><strong>Enable AI Access features</strong>
              <span class="hint">When off, access tokens, proposals, and AI tools are disabled.</span></span></label>
            ${lockBadge('enabled')}
          </div>
          <div class="form-row toggle-row" id="row-allow-without" hidden>
            <label class="switch-label"><input type="checkbox" id="set-allow-without" />
              <span><strong>Allow AI Access without adminAuth (local-only)</strong>
              <span class="hint danger-text">Not for production. Anyone who can reach the editor admin port can use AI features.</span></span></label>
            ${lockBadge('allow-without')}
          </div>
          <div class="form-row">
            <label for="set-deploy">Default deploy type</label>
            <div class="field-line">
              <select id="set-deploy">
                <option value="nodes">Only changed nodes (recommended)</option>
                <option value="flows">Changed flows</option>
                <option value="full">Full redeploy</option>
              </select>
              ${lockBadge('deploy')}
            </div>
            <p class="hint danger-text" id="set-deploy-full-warn" hidden>Full redeploy restarts the entire runtime.</p>
          </div>
          <div class="form-row">
            <label for="set-ttl">Default access token expiry</label>
            <div class="field-line">
              <input type="number" id="set-ttl" min="1" step="1" class="num" />
              <span class="unit">hours</span>
              ${lockBadge('ttl')}
            </div>
          </div>
          <div class="form-row">
            <label for="set-max-links">Maximum active tokens</label>
            <div class="field-line">
              <input type="number" id="set-max-links" min="1" step="1" class="num" />
              <span class="unit">tokens</span>
              ${lockBadge('max-links')}
            </div>
          </div>
        </div>

        <div class="card settings-card">
          <h3>Public URL</h3>
          <p class="hint">The HTTPS origin AI clients use to reach Node-RED (used in links and OAuth metadata).</p>
          <div class="form-row">
            <label for="set-public-url">Public URL</label>
            <div class="field-line">
              <input type="url" id="set-public-url" placeholder="https://nodered.example.com" class="grow" />
              <button type="button" class="action secondary" id="set-check-public-url">Check</button>
              ${lockBadge('public-url')}
            </div>
            <div id="set-public-url-warning" class="hint warn-text" role="status" hidden></div>
            <div id="set-check-result" class="check-result" aria-live="polite" hidden></div>
          </div>
          <details class="tech-details">
            <summary>About the check</summary>
            <p class="hint">Loopback checks use Node-RED's listening port; behind a reverse proxy, use the internal port. Unix-socket listeners are not supported. HTTPS checks fail with self-signed certificates.</p>
            <p class="hint" id="set-trust-proxy"></p>
          </details>
        </div>

        <div class="card settings-card">
          <h3>CORS</h3>
          <div class="form-row">
            <label for="set-cors">Allowed origins <span class="hint">(comma separated)</span></label>
            <div class="field-line">
              <input type="text" id="set-cors" class="grow" placeholder="https://app.example.com" />
              ${lockBadge('cors')}
            </div>
          </div>
        </div>

        <div class="card settings-card" id="secret-redaction-card">
          <h3>Secret redaction</h3>
          <p class="hint">Values whose names match these words are shown to AI clients as <code>[REDACTED]</code>: env variables (flow, group, subflow, node) and secret-named node settings. Known token formats (GitHub, AWS, Slack, OpenAI, Google, JWT, private keys, Bearer headers, URL passwords) are always redacted. Matching is case-insensitive on whole words, so <code>KEY</code> matches <code>API_KEY</code> but not <code>KEYBOARD</code>. The dashboard always shows real values, and proposals keep secrets the AI left as <code>[REDACTED]</code>.</p>
          <div class="form-row">
            <span class="label" id="secret-patterns-label">Secret name patterns <span class="hint" id="secret-patterns-source"></span></span>
            <ul class="chip-list" id="secret-patterns" aria-labelledby="secret-patterns-label"></ul>
            <div class="field-line">
              <input type="text" id="set-secret-new" class="grow" maxlength="40" placeholder="e.g. PIN or SIGNING_KEY" aria-label="New secret name pattern" data-no-autosave="1" />
              <button type="button" class="action secondary" id="set-secret-add">Add</button>
              <button type="button" class="action secondary" id="set-secret-reset">Reset to defaults</button>
              ${lockBadge('secret-patterns')}
            </div>
            <p class="hint">Letters, digits, <code>_</code> or <code>-</code> (2–40 characters). An empty list turns off name-based redaction; token formats are still redacted.</p>
          </div>
        </div>

        <div class="card settings-card">
          <h3>Rate limits</h3>
          <div class="form-row">
            <label for="set-rate-window">Window</label>
            <div class="field-line">
              <input type="number" id="set-rate-window" min="1" step="1" class="num" />
              <span class="unit">ms</span>
              ${lockBadge('rate-window')}
            </div>
          </div>
          <div class="form-row">
            <label for="set-rate-ip">Per IP</label>
            <div class="field-line">
              <input type="number" id="set-rate-ip" min="1" step="1" class="num" />
              <span class="unit">requests / window</span>
              ${lockBadge('rate-ip')}
            </div>
          </div>
          <div class="form-row">
            <label for="set-rate-token">Per token</label>
            <div class="field-line">
              <input type="number" id="set-rate-token" min="1" step="1" class="num" />
              <span class="unit">requests / window</span>
              ${lockBadge('rate-token')}
            </div>
          </div>
          <p class="hint" id="set-trust-proxy-inline"></p>
        </div>
      </div>
    </section>`;
}

function renderMcpPageOAuthSection(): string {
  return `
    <section class="panel" id="section-oauth" aria-label="OAuth" hidden>
      <h2>MCP OAuth</h2>
      <p class="muted">MCP clients (ChatGPT, Claude, …) can request read or propose access through OAuth.</p>
      <div id="oauth-flash" class="flash" hidden></div>
      <div id="oauth-route-warning" class="warning" role="status" hidden></div>
      <div class="settings-grid">
        <div class="card settings-card">
          <h3>Status</h3>
          <div class="form-row toggle-row">
            <label class="switch-label"><input type="checkbox" id="oauth-enabled" />
              <span><strong>Enable MCP OAuth</strong>
              <span class="hint">Also available in the editor sidebar (AI Access tab).</span></span></label>
            ${lockBadge('oauth')}
          </div>
          <div class="form-row">
            <span class="label">Server URL for MCP clients</span>
            <div class="field-line"><code id="oauth-server-url" class="grow">—</code>
              <button type="button" class="action secondary" id="oauth-copy-url">Copy</button></div>
          </div>
          <details class="tech-details" open>
            <summary>How to connect with OAuth</summary>
            <ol class="hint steps">
              <li>Set the Public URL on the Settings tab to the HTTPS address clients use, then click Check.</li>
              <li>Enable MCP OAuth (above, or in the editor sidebar AI Access tab).</li>
              <li>In your MCP client add the server URL <code>&lt;Public URL&gt;/mcp</code> (shown above).</li>
              <li>The client registers itself automatically (Dynamic Client Registration).</li>
              <li>You are sent to the Node-RED login and consent page; approve read or propose access.</li>
            </ol>
            <p class="hint">Opening <code>/mcp</code> in a browser redirects to this dashboard; MCP clients use the same URL.</p>
          </details>
        </div>
        <div class="card settings-card">
          <h3>Token lifetimes</h3>
          <div class="form-row">
            <label for="oauth-access-ttl">Access token lifetime</label>
            <div class="field-line">
              <input type="number" id="oauth-access-ttl" min="1" step="1" class="num" />
              <select id="oauth-access-ttl-unit" aria-label="Access token lifetime unit">
                <option value="minutes">minutes</option><option value="hours">hours</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <label for="oauth-refresh-ttl">Refresh token idle lifetime</label>
            <div class="field-line">
              <input type="number" id="oauth-refresh-ttl" min="1" step="1" class="num" />
              <select id="oauth-refresh-ttl-unit" aria-label="Refresh token idle lifetime unit">
                <option value="hours">hours</option><option value="days">days</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <label for="oauth-refresh-max">Refresh token max lifetime</label>
            <div class="field-line">
              <input type="number" id="oauth-refresh-max" min="0" step="1" class="num" />
              <span class="unit">days</span>
            </div>
            <p class="hint">Default 90 days; 0 = unlimited.</p>
          </div>
          <div class="form-row">
            <label for="oauth-dcr-cap">Maximum registered clients</label>
            <div class="field-line">
              <input type="number" id="oauth-dcr-cap" min="1" step="1" class="num" />
              <span class="unit">clients</span>
            </div>
            <p class="hint">Applies to new registrations: existing clients keep working, but new apps are refused while the number of clients is at or above this limit.</p>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Registered OAuth clients</h3>
          <button type="button" class="action secondary" id="oauth-refresh">Refresh</button></div>
        <div id="oauth-clients" aria-live="polite"><p class="muted">Loading…</p></div>
      </div>
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
        <input type="search" id="proposals-search" class="proposals-search"
          placeholder="Search title or id (e.g. efd159aa)…"
          aria-label="Search proposals by title or short id (first 8 hex after prop-)"
          autocomplete="off" />
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
        <p id="reject-dialog-title" class="dialog-proposal-title"></p>
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
        <h3 id="delete-confirm-heading">Confirm approve &amp; deploy</h3>
        <p id="delete-confirm-proposal-title" class="dialog-proposal-title"></p>
        <p id="delete-confirm-msg" class="danger-text"></p>
        <p id="delete-confirm-summary" class="muted"></p>
        <div id="delete-confirm-warnings" hidden></div>
        <label id="delete-confirm-type-label">Type <strong id="delete-confirm-phrase">DELETE</strong> to confirm
          <input id="delete-confirm-input" type="text" autocomplete="off" />
        </label>
        <div class="row dialog-actions">
          <button type="submit" value="cancel" class="action secondary">Cancel</button>
          <button type="submit" value="confirm" class="action danger" id="delete-confirm-btn" disabled>Approve &amp; deploy</button>
        </div>
      </form>
    </dialog>

    <dialog id="confirm-dialog">
      <form method="dialog" id="confirm-form">
        <h3 id="confirm-title">Confirm</h3>
        <p id="confirm-message" class="muted"></p>
        <div class="row dialog-actions">
          <button type="submit" value="cancel" class="action secondary">Cancel</button>
          <button type="submit" value="confirm" class="action danger" id="confirm-action-btn">Confirm</button>
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
    dashboardPath: options.dashboardPath ?? '/ai-access',
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
${renderMcpPageSettingsSection()}
${renderMcpPageLinksSection()}
${renderMcpPageOAuthSection()}
${renderMcpPageProposalsSection()}
${renderMcpPageLogsSection()}
${renderMcpPageDialogs()}
  </main>
  <script>${pageClientScript()}</script>
</body>
</html>`;
}
