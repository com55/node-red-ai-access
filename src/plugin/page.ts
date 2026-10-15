/**
 * HTML admin UI for GET /mcp — status, links, proposals, audit log.
 * Plain CSS + vanilla JS; calls existing /mcp/api/v1 REST endpoints.
 */

import type { AiAccessStatus } from './types.js';

export interface RenderMcpPageOptions {
  /** Absolute path prefix for `/mcp/api/v1` (respects httpAdminRoot). */
  apiBase: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pageStyles(): string {
  return `
:root {
  color-scheme: light;
  --bg: #eef2f5;
  --ink: #1a2330;
  --muted: #5a6a7a;
  --accent: #0a5c45;
  --accent-soft: #dceee7;
  --warn-bg: #fff7eb;
  --warn-border: #d9a15b;
  --danger: #9b2c2c;
  --card: #ffffff;
  --line: #cfd8e3;
  --ok: #1b6b4a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Source Sans 3", "Segoe UI", sans-serif;
  background:
    radial-gradient(ellipse at 0% 0%, #d4ebe2 0%, transparent 45%),
    linear-gradient(165deg, #e8eef3 0%, var(--bg) 55%, #e4ebe6 100%);
  color: var(--ink);
  min-height: 100vh;
}
main {
  max-width: 52rem;
  margin: 0 auto;
  padding: 2.25rem 1.15rem 3.5rem;
}
h1 {
  font-size: clamp(1.85rem, 3.5vw, 2.45rem);
  letter-spacing: -0.03em;
  margin: 0 0 0.35rem;
}
.lede {
  color: var(--muted);
  font-size: 1.02rem;
  line-height: 1.5;
  margin: 0 0 1.5rem;
}
nav.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 1.1rem;
}
nav.tabs button {
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  padding: 0.4rem 0.85rem;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
}
nav.tabs button[aria-selected="true"] {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
section.panel {
  display: none;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 1.15rem 1.25rem 1.35rem;
}
section.panel.active { display: block; }
section.panel h2 {
  margin: 0 0 0.75rem;
  font-size: 1.15rem;
}
.warning {
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
  border-radius: 10px;
  padding: 0.95rem 1.1rem;
  margin-bottom: 1.15rem;
}
.warning h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.warning p { margin: 0; line-height: 1.45; }
dl.status {
  display: grid;
  grid-template-columns: 11rem 1fr;
  gap: 0.45rem 1rem;
  margin: 0;
}
dt { color: var(--muted); }
dd {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
  word-break: break-all;
}
.badge {
  display: inline-block;
  margin-top: 0.9rem;
  padding: 0.22rem 0.55rem;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 0.82rem;
  font-weight: 650;
}
.muted { color: var(--muted); font-size: 0.92rem; }
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  align-items: end;
  margin-bottom: 0.85rem;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
  color: var(--muted);
}
input, select, textarea, button.action {
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 0.4rem 0.55rem;
  background: #fff;
  color: var(--ink);
}
textarea { min-height: 4rem; width: min(100%, 28rem); }
button.action {
  cursor: pointer;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
button.action.secondary {
  background: #fff;
  color: var(--ink);
  border-color: var(--line);
}
button.action.danger {
  background: var(--danger);
  border-color: var(--danger);
}
button.action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th, td {
  text-align: left;
  padding: 0.45rem 0.35rem;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
th { color: var(--muted); font-weight: 600; }
.token-once {
  background: #f4faf7;
  border: 1px dashed var(--accent);
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  margin: 0.75rem 0;
  word-break: break-all;
}
.token-once strong { display: block; margin-bottom: 0.35rem; }
.flash {
  margin: 0.5rem 0 0.85rem;
  padding: 0.55rem 0.7rem;
  border-radius: 7px;
  font-size: 0.9rem;
}
.flash.error { background: #fdecec; color: var(--danger); }
.flash.ok { background: #e8f6ef; color: var(--ok); }
.proposal-detail {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: #f7fafc;
  border-radius: 8px;
  border: 1px solid var(--line);
}
.proposal-detail pre {
  margin: 0.4rem 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.82rem;
  max-height: 14rem;
  overflow: auto;
}
.readonly-note {
  margin: 0 0 0.85rem;
  color: var(--muted);
  font-size: 0.92rem;
}
@media (max-width: 640px) {
  dl.status { grid-template-columns: 1fr; }
}
`.trim();
}

function pageClientScript(): string {
  return `
(function () {
  var root = document.getElementById('mcp-root');
  if (!root) return;
  var cfg = JSON.parse(root.getAttribute('data-config') || '{}');
  var apiBase = cfg.apiBase || '/mcp/api/v1';
  var canManage = !!cfg.canManageLinks;
  var canApprove = !!cfg.canApprove;
  var aiOn = !!cfg.aiFeaturesEnabled;
  var defaultTtl = cfg.defaultLinkTtlSeconds || 86400;
  var defaultDeploy = cfg.defaultDeploymentType || 'nodes';

  function $(id) { return document.getElementById(id); }
  function showFlash(el, message, ok) {
    if (!el) return;
    el.className = 'flash ' + (ok ? 'ok' : 'error');
    el.textContent = message;
    el.hidden = !message;
  }
  function fmt(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(path, options) {
    var res = await fetch(apiBase + path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
    }, options || {}));
    var body = null;
    var text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = { error: text }; }
    }
    if (!res.ok) {
      var err = new Error((body && body.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  document.querySelectorAll('nav.tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-tab');
      document.querySelectorAll('nav.tabs button').forEach(function (b) {
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      document.querySelectorAll('section.panel').forEach(function (sec) {
        sec.classList.toggle('active', sec.id === 'section-' + target);
      });
      if (target === 'links') loadLinks();
      if (target === 'proposals') loadProposals();
      if (target === 'logs') loadLogs();
    });
  });

  async function loadLinks() {
    if (!aiOn || !canManage) return;
    var list = $('links-list');
    var flash = $('links-flash');
    showFlash(flash, '', true);
    try {
      var data = await api('/links');
      var links = (data && data.links) || [];
      if (!links.length) {
        list.innerHTML = '<p class="muted">No active access links.</p>';
        return;
      }
      list.innerHTML = '<table><thead><tr><th>Id</th><th>Label</th><th>Expires</th><th></th></tr></thead><tbody>' +
        links.map(function (l) {
          return '<tr data-id="' + esc(l.id) + '">' +
            '<td><code>' + esc(l.id) + '</code></td>' +
            '<td>' + esc(l.label || '—') + '</td>' +
            '<td>' + esc(fmt(l.expiresAt)) + '</td>' +
            '<td><button type="button" class="action danger revoke-link" data-id="' + esc(l.id) + '">Revoke</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table>';
      list.querySelectorAll('.revoke-link').forEach(function (btn) {
        btn.addEventListener('click', function () { revokeLink(btn.getAttribute('data-id')); });
      });
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  async function revokeLink(id) {
    var flash = $('links-flash');
    try {
      await api('/links/' + encodeURIComponent(id), { method: 'DELETE' });
      showFlash(flash, 'Link revoked.', true);
      $('token-once').hidden = true;
      loadLinks();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  var createForm = $('create-link-form');
  if (createForm) {
    createForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var flash = $('links-flash');
      var ttlInput = $('link-ttl');
      var labelInput = $('link-label');
      var ttlHours = Number(ttlInput && ttlInput.value);
      var ttlSeconds = Math.max(1, Math.floor((Number.isFinite(ttlHours) ? ttlHours : 24) * 3600));
      var payload = { ttlSeconds: ttlSeconds };
      if (labelInput && labelInput.value.trim()) payload.label = labelInput.value.trim();
      try {
        var created = await api('/links', { method: 'POST', body: JSON.stringify(payload) });
        var box = $('token-once');
        box.hidden = false;
        $('token-value').textContent = created.token;
        showFlash(flash, 'Link created. Copy the token now — it will not be shown again.', true);
        loadLinks();
      } catch (e) {
        showFlash(flash, e.message || String(e), false);
      }
    });
  }

  function proposalSummary(p) {
    var flow = (p.payload && p.payload.flow) || {};
    var nodes = Array.isArray(flow.nodes) ? flow.nodes.length : 0;
    var configs = Array.isArray(flow.configs) ? flow.configs.length : 0;
    return 'flow ' + (p.payload && p.payload.flowId ? p.payload.flowId : '?') +
      ' · label ' + (flow.label || '—') +
      ' · nodes ' + nodes +
      ' · configs ' + configs;
  }

  async function loadProposals() {
    if (!aiOn) return;
    var list = $('proposals-list');
    var flash = $('proposals-flash');
    showFlash(flash, '', true);
    try {
      var data = await api('/proposals');
      var proposals = (data && data.proposals) || [];
      if (!proposals.length) {
        list.innerHTML = '<p class="muted">No proposals yet.</p>';
        return;
      }
      list.innerHTML = proposals.map(function (p) {
        var actions = '';
        if (canApprove && p.status === 'pending') {
          actions =
            '<div class="row">' +
            '<label>Deploy type<select class="deploy-type" data-id="' + esc(p.id) + '">' +
            '<option value="nodes"' + (defaultDeploy === 'nodes' ? ' selected' : '') + '>nodes</option>' +
            '<option value="flows"' + (defaultDeploy === 'flows' ? ' selected' : '') + '>flows</option>' +
            '<option value="full"' + (defaultDeploy === 'full' ? ' selected' : '') + '>full</option>' +
            '</select></label>' +
            '<button type="button" class="action approve-btn" data-id="' + esc(p.id) + '">Approve</button>' +
            '<button type="button" class="action secondary reject-btn" data-id="' + esc(p.id) + '">Reject</button>' +
            '</div>' +
            '<label>Reject reason<input class="reject-reason" data-id="' + esc(p.id) + '" placeholder="Optional reason" /></label>';
        }
        var reason = p.reason ? '<p class="muted">Reason: ' + esc(p.reason) + '</p>' : '';
        return '<article class="proposal-detail" data-id="' + esc(p.id) + '">' +
          '<strong>' + esc(p.id) + '</strong> · <code>' + esc(p.status) + '</code><br/>' +
          '<span class="muted">' + esc(proposalSummary(p)) + '</span><br/>' +
          '<span class="muted">expectedRev ' + esc(p.expectedRev) +
          ' · created ' + esc(fmt(p.createdAt)) +
          (p.createdBy && p.createdBy.linkId ? ' · link ' + esc(p.createdBy.linkId) : '') +
          '</span>' +
          reason +
          '<details><summary>Payload</summary><pre>' + esc(JSON.stringify(p.payload, null, 2)) + '</pre></details>' +
          actions +
          '</article>';
      }).join('');
      list.querySelectorAll('.approve-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { approveProposal(btn.getAttribute('data-id')); });
      });
      list.querySelectorAll('.reject-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { rejectProposal(btn.getAttribute('data-id')); });
      });
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  async function approveProposal(id) {
    var flash = $('proposals-flash');
    var select = document.querySelector('select.deploy-type[data-id="' + id + '"]');
    var deploymentType = select ? select.value : defaultDeploy;
    try {
      var result = await api('/proposals/' + encodeURIComponent(id) + '/approve', {
        method: 'POST',
        body: JSON.stringify({ deploymentType: deploymentType })
      });
      if (result.status === 'rejected') {
        showFlash(flash, result.reason || 'Proposal rejected (revision conflict).', false);
      } else if (result.status === 'failed') {
        showFlash(flash, result.reason || 'Proposal failed.', false);
      } else {
        showFlash(flash, 'Proposal approved (' + (result.resultRev || '') + ').', true);
      }
      loadProposals();
      loadLogs();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  async function rejectProposal(id) {
    var flash = $('proposals-flash');
    var input = document.querySelector('input.reject-reason[data-id="' + id + '"]');
    var reason = input && input.value.trim() ? input.value.trim() : 'Rejected by admin';
    try {
      await api('/proposals/' + encodeURIComponent(id) + '/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: reason })
      });
      showFlash(flash, 'Proposal rejected.', true);
      loadProposals();
      loadLogs();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  async function loadLogs() {
    if (!aiOn) return;
    var list = $('logs-list');
    var flash = $('logs-flash');
    showFlash(flash, '', true);
    try {
      var data = await api('/logs?limit=100');
      var logs = (data && data.logs) || [];
      if (!logs.length) {
        list.innerHTML = '<p class="muted">Audit log is empty.</p>';
        return;
      }
      list.innerHTML = '<table><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead><tbody>' +
        logs.map(function (e) {
          var actor = e.actor || {};
          var actorLabel = actor.kind +
            (actor.username ? ':' + actor.username : '') +
            (actor.linkId ? ':' + actor.linkId : '');
          return '<tr><td>' + esc(fmt(e.at)) + '</td><td><code>' + esc(e.action) +
            '</code></td><td>' + esc(actorLabel) + '</td><td><code>' +
            esc(JSON.stringify(e.details || {})) + '</code></td></tr>';
        }).join('') + '</tbody></table>';
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  var refreshBtn = $('refresh-status');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      try {
        var s = await api('/status');
        $('status-version').textContent = s.version;
        $('status-adminauth').textContent = s.adminAuthEnabled ? 'enabled' : 'disabled';
        $('status-aifeatures').textContent = s.aiFeaturesEnabled ? 'enabled' : 'disabled';
        $('status-permission').textContent = s.permission || 'none';
        $('status-storage').textContent = s.storageDir;
        $('status-ttl').textContent = String(s.defaultLinkTtlSeconds);
        $('status-maxlinks').textContent = String(s.maxActiveLinks);
        $('status-deploy').textContent = s.defaultDeploymentType;
      } catch (e) {
        showFlash($('status-flash'), e.message || String(e), false);
      }
    });
  }

  if (aiOn) {
    if (canManage) loadLinks();
    loadProposals();
    loadLogs();
  }
})();
`.trim();
}

export function renderMcpPage(status: AiAccessStatus, options: RenderMcpPageOptions): string {
  const canManageLinks = status.capabilities.manageLinks;
  const canApprove = status.capabilities.approveProposals;
  const aiOn = status.aiFeaturesEnabled;

  const warning =
    !status.adminAuthEnabled && !status.aiFeaturesEnabled
      ? `<aside class="warning" role="status">
          <h2>Warning</h2>
          <p>
            <code>adminAuth</code> is not enabled, so AI Access features are
            <strong>disabled</strong> by default. Enable Node-RED
            <code>adminAuth</code>, or set
            <code>aiAccess.allowWithoutAdminAuth: true</code> in
            <code>settings.js</code> for local-only use.
          </p>
        </aside>`
      : !status.adminAuthEnabled && status.aiFeaturesEnabled
        ? `<aside class="warning" role="status">
            <h2>Local-only mode</h2>
            <p>
              <code>adminAuth</code> is off and
              <code>aiAccess.allowWithoutAdminAuth</code> is enabled. Full AI
              Access features are available without a login — use only on trusted
              local networks.
            </p>
          </aside>`
        : '';

  const modeLabel =
    status.permission === '*'
      ? 'full access'
      : status.permission === 'read'
        ? 'read-only'
        : 'limited';

  const ttlHoursDefault = Math.max(1, Math.round(status.defaultLinkTtlSeconds / 3600));

  const linksManage = canManageLinks
    ? `<form id="create-link-form" class="row">
        <label>TTL (hours)
          <input id="link-ttl" type="number" min="1" step="1" value="${ttlHoursDefault}" />
        </label>
        <label>Label (optional)
          <input id="link-label" type="text" maxlength="120" placeholder="e.g. Claude session" />
        </label>
        <button type="submit" class="action">Create access link</button>
      </form>
      <div id="token-once" class="token-once" hidden>
        <strong>Token (shown once)</strong>
        <code id="token-value"></code>
      </div>
      <div id="links-list"></div>`
    : `<p class="readonly-note">Link management requires full admin permission (*).</p>
       <div id="links-list"></div>`;

  const proposalsHint = canApprove
    ? `<p class="muted">Approve deploys via FlowAdapter. Default deploy type is <code>${escapeHtml(status.defaultDeploymentType)}</code>; you can override per approval (nodes / flows / full). Revision conflicts are shown as rejected proposals.</p>`
    : `<p class="readonly-note">Approve and reject require full admin permission (*). You can still review proposals.</p>`;

  const disabledNote = !aiOn
    ? `<p class="readonly-note">AI features are disabled — enable adminAuth or allowWithoutAdminAuth to use these views.</p>`
    : '';

  const config = {
    apiBase: options.apiBase,
    canManageLinks,
    canApprove,
    aiFeaturesEnabled: aiOn,
    defaultLinkTtlSeconds: status.defaultLinkTtlSeconds,
    defaultDeploymentType: status.defaultDeploymentType,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Node-RED AI Access</title>
  <style>${pageStyles()}</style>
</head>
<body>
  <main
    id="mcp-root"
    data-ai-features="${aiOn ? 'true' : 'false'}"
    data-can-manage-links="${canManageLinks ? 'true' : 'false'}"
    data-can-approve="${canApprove ? 'true' : 'false'}"
    data-config="${escapeHtml(JSON.stringify(config))}"
  >
    <h1>Node-RED AI Access</h1>
    <p class="lede">
      Temporary, owner-approved access for AI clients. Manage access links,
      review proposals, and inspect the audit log.
    </p>
    ${warning}
    <nav class="tabs" aria-label="Admin views">
      <button type="button" data-tab="status" aria-selected="true">Status</button>
      <button type="button" data-tab="links" aria-selected="false">Access links</button>
      <button type="button" data-tab="proposals" aria-selected="false">Proposals</button>
      <button type="button" data-tab="logs" aria-selected="false">Audit log</button>
    </nav>

    <section class="panel active" id="section-status" aria-label="Status">
      <h2>Status</h2>
      <div id="status-flash" class="flash" hidden></div>
      <dl class="status">
        <dt>Version</dt><dd id="status-version">${escapeHtml(status.version)}</dd>
        <dt>adminAuth</dt><dd id="status-adminauth">${status.adminAuthEnabled ? 'enabled' : 'disabled'}</dd>
        <dt>AI features</dt><dd id="status-aifeatures">${status.aiFeaturesEnabled ? 'enabled' : 'disabled'}</dd>
        <dt>Permission</dt><dd id="status-permission">${escapeHtml(status.permission ?? 'none')}</dd>
        <dt>Storage</dt><dd id="status-storage">${escapeHtml(status.storageDir)}</dd>
        <dt>Default link TTL</dt><dd id="status-ttl">${status.defaultLinkTtlSeconds}s</dd>
        <dt>Max active links</dt><dd id="status-maxlinks">${status.maxActiveLinks}</dd>
        <dt>Default deploy</dt><dd id="status-deploy">${escapeHtml(status.defaultDeploymentType)}</dd>
      </dl>
      <span class="badge">${escapeHtml(modeLabel)}</span>
      <div class="row" style="margin-top:1rem">
        <button type="button" class="action secondary" id="refresh-status">Refresh</button>
      </div>
    </section>

    <section class="panel" id="section-links" aria-label="Access links">
      <h2>Access links</h2>
      ${disabledNote}
      <div id="links-flash" class="flash" hidden></div>
      ${aiOn ? linksManage : ''}
    </section>

    <section class="panel" id="section-proposals" aria-label="Proposals">
      <h2>Proposals</h2>
      ${disabledNote}
      ${aiOn ? proposalsHint : ''}
      <div id="proposals-flash" class="flash" hidden></div>
      <div id="proposals-list">${aiOn ? '<p class="muted">Loading…</p>' : ''}</div>
    </section>

    <section class="panel" id="section-logs" aria-label="Audit log">
      <h2>Audit log</h2>
      ${disabledNote}
      <div id="logs-flash" class="flash" hidden></div>
      <div id="logs-list">${aiOn ? '<p class="muted">Loading…</p>' : ''}</div>
    </section>
  </main>
  <script>${pageClientScript()}</script>
</body>
</html>`;
}
