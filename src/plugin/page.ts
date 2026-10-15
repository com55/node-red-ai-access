/**
 * Placeholder HTML for GET /mcp.
 */

import type { AiAccessStatus } from './types.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderMcpPage(status: AiAccessStatus): string {
  const warning =
    !status.adminAuthEnabled && !status.aiFeaturesEnabled
      ? `<section class="warning" role="status">
          <h2>Warning</h2>
          <p>
            <code>adminAuth</code> is not enabled, so AI Access features are
            <strong>disabled</strong> by default. Enable Node-RED
            <code>adminAuth</code>, or set
            <code>aiAccess.allowWithoutAdminAuth: true</code> in
            <code>settings.js</code> for local-only use.
          </p>
        </section>`
      : '';

  const modeLabel =
    status.permission === '*'
      ? 'full access'
      : status.permission === 'read'
        ? 'read-only'
        : 'limited';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Node-RED AI Access</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f6f8;
      --ink: #1c2430;
      --muted: #5b6b7c;
      --accent: #0b6e4f;
      --warn-bg: #fff6e8;
      --warn-border: #e0a24a;
      --card: #ffffff;
      --line: #d5dee7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Source Sans 3", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, #d9efe6 0%, transparent 40%),
        linear-gradient(180deg, #eef3f7 0%, var(--bg) 100%);
      color: var(--ink);
      min-height: 100vh;
    }
    main {
      max-width: 42rem;
      margin: 0 auto;
      padding: 3rem 1.25rem 4rem;
    }
    h1 {
      font-size: clamp(2rem, 4vw, 2.75rem);
      letter-spacing: -0.03em;
      margin: 0 0 0.5rem;
    }
    .lede {
      color: var(--muted);
      font-size: 1.05rem;
      line-height: 1.5;
      margin: 0 0 1.75rem;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1.25rem 1.35rem;
    }
    .warning {
      background: var(--warn-bg);
      border: 1px solid var(--warn-border);
      border-radius: 12px;
      padding: 1rem 1.15rem;
      margin-bottom: 1.25rem;
    }
    .warning h2 {
      margin: 0 0 0.4rem;
      font-size: 1.05rem;
    }
    .warning p { margin: 0; line-height: 1.45; }
    dl {
      display: grid;
      grid-template-columns: 10rem 1fr;
      gap: 0.55rem 1rem;
      margin: 0;
    }
    dt { color: var(--muted); }
    dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92rem; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.92em;
    }
    .badge {
      display: inline-block;
      margin-top: 1rem;
      padding: 0.25rem 0.6rem;
      border-radius: 999px;
      background: #e7f5ef;
      color: var(--accent);
      font-size: 0.85rem;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <main>
    <h1>Node-RED AI Access</h1>
    <p class="lede">
      Temporary, owner-approved access for AI clients. This page is a scaffold;
      link management and proposal review land in later releases.
    </p>
    ${warning}
    <section class="panel" aria-label="Status">
      <dl>
        <dt>Version</dt><dd>${escapeHtml(status.version)}</dd>
        <dt>adminAuth</dt><dd>${status.adminAuthEnabled ? 'enabled' : 'disabled'}</dd>
        <dt>AI features</dt><dd>${status.aiFeaturesEnabled ? 'enabled' : 'disabled'}</dd>
        <dt>Permission</dt><dd>${escapeHtml(status.permission ?? 'none')}</dd>
        <dt>Storage</dt><dd>${escapeHtml(status.storageDir)}</dd>
      </dl>
      <span class="badge">${escapeHtml(modeLabel)}</span>
    </section>
  </main>
</body>
</html>`;
}
