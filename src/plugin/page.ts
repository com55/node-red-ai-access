/**
 * HTML admin UI for GET /mcp — status, links, proposals, audit log.
 * Plain CSS + vanilla JS; calls existing /mcp/api/v1 REST endpoints.
 */

import { pageClientScript } from './page-client.js';
import { pageStyles } from './page-styles.js';
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
