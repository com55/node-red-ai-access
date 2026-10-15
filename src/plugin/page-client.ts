/** Inline client script for the /mcp admin page (editor localStorage Bearer). */

import { DIFF_SPLIT_MIN_PX, PRESENCE_SHORT_TEXT_MAX } from './diff-ui.js';

function pageClientScriptPartA(): string {
  return `
(function () {
  var root = document.getElementById('mcp-root');
  if (!root) return;
  var cfg = JSON.parse(root.getAttribute('data-config') || '{}');
  var apiBase = cfg.apiBase || '/mcp/api/v1';
  var mcpRpc = cfg.mcpRpc || '/mcp/rpc';
  var editorRoot = cfg.editorRoot || '/';
  var authTokenKey = cfg.authTokenKey || 'auth-tokens';
  var canManage = false;
  var canApprove = false;
  var aiOn = false;
  var defaultTtl = 14400; // 4h default access-link TTL
  var defaultDeploy = 'nodes';
  var accessToken = null;

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

  function readEditorToken() {
    try {
      var raw = localStorage.getItem(authTokenKey);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.access_token ? String(parsed.access_token) : null;
    } catch (e) {
      return null;
    }
  }

  function redirectToEditorLogin() {
    var target = editorRoot;
    if (!target || target === '') target = '/';
    window.location.replace(target);
  }

  function isStatusPath(path) {
    return path === '/status' || path.indexOf('/status?') === 0;
  }

  async function api(path, options) {
    var headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
    if (accessToken) {
      headers['Authorization'] = 'Bearer ' + accessToken;
    }
    var res = await fetch(apiBase + path, Object.assign({
      credentials: 'same-origin',
      headers: headers
    }, options || {}));
    var body = null;
    var text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = { error: text }; }
    }
    // Only the auth bootstrap (/status) redirects on 401. Other endpoints
    // (e.g. /proposals) show an inline error so a single failing route cannot
    // bounce the admin back to the editor.
    if (res.status === 401 && isStatusPath(path)) {
      redirectToEditorLogin();
      throw new Error((body && body.error) || 'Authentication required');
    }
    if (!res.ok) {
      var err = new Error((body && body.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }
`;
}

function pageClientScriptPartAFormat(): string {
  return `
  function fmtCompact(iso) {
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      var ss = String(d.getSeconds()).padStart(2, '0');
      return y + '-' + m + '-' + day + ' ' + hh + ':' + mm + ':' + ss;
    } catch (e) {
      return String(iso);
    }
  }
  function shortId(value, keep) {
    var s = String(value == null ? '' : value);
    var n = keep || 8;
    if (s.length <= n + 1) return s;
    return s.slice(0, n) + '\u2026';
  }
  function tipId(value, keep) {
    var s = String(value == null ? '' : value);
    if (!s) return '';
    return '<code class="id-short" title="' + esc(s) + '">' + esc(shortId(s, keep)) + '</code>';
  }
  function actorPlain(actor) {
    actor = actor || {};
    if (actor.kind === 'access-link') {
      if (actor.label) {
        return 'AI link "' + String(actor.label) + '"';
      }
      return 'AI link ' + String(actor.linkId || '');
    }
    if (actor.kind === 'admin') {
      return actor.username ? 'user ' + String(actor.username) : 'user';
    }
    if (actor.kind === 'system') return 'system';
    return String(actor.kind || 'unknown');
  }
  function actorLabel(actor) {
    actor = actor || {};
    if (actor.kind === 'access-link') {
      if (actor.label) {
        return 'AI link "' + esc(actor.label) + '"';
      }
      return 'AI link ' + tipId(actor.linkId || '', 8);
    }
    if (actor.kind === 'admin') {
      return actor.username ? 'user ' + esc(actor.username) : 'user';
    }
    if (actor.kind === 'system') return 'system';
    return esc(actor.kind || 'unknown');
  }
  function actionBadge(action) {
    var labels = {
      'proposal.created': 'Created',
      'proposal.approved': 'Approved',
      'proposal.rejected': 'Rejected',
      'proposal.failed': 'Failed'
    };
    var label = labels[action];
    if (label) {
      var kind = action.split('.')[1] || 'other';
      return '<span class="action-badge action-' + esc(kind) + '" title="' + esc(action) + '">' +
        esc(label) + '</span>';
    }
    return '<span class="action-badge" title="' + esc(action) + '">' + esc(action) + '</span>';
  }
  function actionFilterLabel(action) {
    var labels = {
      'proposal.created': 'Created',
      'proposal.approved': 'Approved',
      'proposal.rejected': 'Rejected',
      'proposal.failed': 'Failed'
    };
    return labels[action] ? labels[action] + ' (' + action + ')' : action;
  }
  function auditSummary(entry) {
    var d = entry.details || {};
    var action = entry.action || '';
    var prop = d.proposalId ? tipId(d.proposalId, 12) : '';
    var flow = d.flowId != null ? esc(String(d.flowId)) : '';
    if (action === 'proposal.created') {
      return 'Proposal ' + prop + ' created for flow "' + flow + '"';
    }
    if (action === 'proposal.approved') {
      var rev = d.resultRev ? tipId(d.resultRev, 8) : '';
      return 'Approved' + (d.flowId ? ' for flow "' + flow + '"' : '') +
        (rev ? ', deployed (rev ' + rev + ')' : '');
    }
    if (action === 'proposal.rejected') {
      return 'Rejected' + (prop ? ' ' + prop : '') +
        (d.reason ? ': ' + esc(String(d.reason)) : '');
    }
    if (action === 'proposal.failed') {
      return 'Failed' + (prop ? ' ' + prop : '') +
        (d.reason ? ': ' + esc(String(d.reason)) : '');
    }
    var keys = Object.keys(d);
    if (!keys.length) return '<span class="muted">—</span>';
    return esc(keys.slice(0, 3).map(function (k) {
      var v = d[k];
      if (typeof v === 'string' && v.length > 24) return k + '=' + shortId(v, 8);
      return k + '=' + String(v);
    }).join(', '));
  }
`;
}

function pageClientScriptPartATabs(): string {
  return `
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

  function renderLinksManage() {
    var host = $('links-manage');
    if (!host) return;
    if (!aiOn) {
      host.innerHTML = '<p class="readonly-note">AI features are disabled — enable adminAuth or allowWithoutAdminAuth.</p>';
      return;
    }
    if (!canManage) {
      host.innerHTML = '<p class="readonly-note">Link management requires full admin permission (*).</p>';
      return;
    }
    var ttlHoursDefault = Math.max(1, Math.round(defaultTtl / 3600));
    host.innerHTML =
      '<form id="create-link-form" class="row">' +
      '<label>TTL (hours)<input id="link-ttl" type="number" min="1" step="1" value="' + ttlHoursDefault + '" /></label>' +
      '<label>Label (optional)<input id="link-label" type="text" maxlength="120" placeholder="e.g. Claude session" /></label>' +
      '<button type="submit" class="action">Create access link</button></form>' +
      '<div id="token-once" class="token-once" hidden>' +
      '<strong>Token (shown once)</strong><code id="token-value"></code>' +
      '<pre id="token-copy-block" class="token-copy-block" hidden></pre>' +
      '<button type="button" class="action" id="token-copy-btn">Copy link for AI</button>' +
      '<p class="muted" id="token-docs-hint"></p>' +
      '</div>';
    var createForm = $('create-link-form');
    if (createForm) {
      createForm.addEventListener('submit', onCreateLink);
    }
  }

`;
}

function pageClientScriptPartA2(): string {
  return `
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
      var once = $('token-once');
      if (once) once.hidden = true;
      loadLinks();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }
`;
}

function pageClientScriptPartB(): string {
  return `

  function accessLinkCopyText(token, url) {
    var origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    var base = origin + apiBase;
    var getLink = url || (origin + (apiBase.replace(/\\/mcp\\/api\\/v1\\/?$/, '/mcp/a/') + token));
    return [
      'Self-contained GET link (preferred for chat AIs that can only HTTP GET):',
      getLink,
      '',
      'Open that URL for markdown docs + token-scoped GET routes (status, flows, propose, drafts).',
      '',
      'Also (if your client can send headers):',
      'Authorization: Bearer ' + token,
      'REST API base: ' + base,
      'OpenAPI: GET ' + base + '/openapi.yaml',
      'MCP (optional): POST ' + origin + mcpRpc,
      '',
      'If you get 401 access_link_missing or access_link_invalid, ask the user for a new link.'
    ].join('\\n');
  }

  async function onCreateLink(ev) {
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
      $('token-value').textContent = created.url || created.token;
      var copyBlock = $('token-copy-block');
      var copyText = accessLinkCopyText(created.token, created.url);
      if (copyBlock) {
        copyBlock.hidden = false;
        copyBlock.textContent = copyText;
      }
      var hint = $('token-docs-hint');
      if (hint) {
        hint.textContent = 'Copy the self-contained GET link for chat AIs (docs + scoped routes). Token TTL default is 4 hours.';
      }
      var copyBtn = $('token-copy-btn');
      if (copyBtn) {
        copyBtn.onclick = function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(copyText).then(function () {
              showFlash(flash, 'Copied token + API base + docs hint.', true);
            }).catch(function () {
              showFlash(flash, 'Copy failed — select the text below manually.', false);
            });
          } else {
            showFlash(flash, 'Clipboard unavailable — select the text below manually.', false);
          }
        };
      }
      showFlash(flash, 'Link created. Copy the token now — it will not be shown again.', true);
      loadLinks();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
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
`;
}

function pageClientScriptPartBDiff(): string {
  return `
  var DIFF_MODE_KEY = 'ai-access-diff-mode';
  var DIFF_SPLIT_MIN_PX = ${DIFF_SPLIT_MIN_PX};
  var PRESENCE_SHORT_TEXT_MAX = ${PRESENCE_SHORT_TEXT_MAX};
  function defaultDiffModeFromViewport() {
    // Side-by-side on wide screens; unified only below the narrow breakpoint.
    if (typeof window === 'undefined' || !window.matchMedia) return 'unified';
    return window.matchMedia('(min-width: ' + DIFF_SPLIT_MIN_PX + 'px)').matches
      ? 'split' : 'unified';
  }
  function getDiffMode() {
    try {
      var v = localStorage.getItem(DIFF_MODE_KEY);
      if (v === 'unified' || v === 'split') return v;
    } catch (e) { /* ignore */ }
    return defaultDiffModeFromViewport();
  }
  function setDiffMode(mode) {
    try { localStorage.setItem(DIFF_MODE_KEY, mode); } catch (e) { /* ignore */ }
  }

  function renderDiffLine(opts) {
    var cls = opts.cls || 'diff-eq';
    var ln = opts.ln == null ? '' : String(opts.ln);
    var gutter = opts.gutter == null ? ' ' : opts.gutter;
    var text = opts.text == null ? '' : opts.text;
    return '<div class="diff-line ' + cls + '">' +
      '<span class="ln">' + esc(ln) + '</span>' +
      '<span class="gutter">' + esc(gutter) + '</span>' +
      '<span class="code">' + esc(text) + '</span></div>';
  }

  function renderUnifiedTextDiff(ch) {
    var beforeLn = 0;
    var afterLn = 0;
    var lines = (ch.lines || []).map(function (line) {
      if (line.op === 'add') {
        afterLn += 1;
        return renderDiffLine({ cls: 'diff-add', ln: afterLn, gutter: '+', text: line.text });
      }
      if (line.op === 'remove') {
        beforeLn += 1;
        return renderDiffLine({ cls: 'diff-remove', ln: beforeLn, gutter: '-', text: line.text });
      }
      beforeLn += 1;
      afterLn += 1;
      return renderDiffLine({ cls: 'diff-eq', ln: afterLn, gutter: ' ', text: line.text });
    }).join('');
    return '<div class="diff-block" role="region" aria-label="Unified line diff for ' + esc(ch.key) + '">' +
      lines + '</div>';
  }

  function renderSplitTextDiff(ch) {
    var left = [];
    var right = [];
    var beforeLn = 0;
    var afterLn = 0;
    (ch.lines || []).forEach(function (line) {
      if (line.op === 'equal') {
        beforeLn += 1;
        afterLn += 1;
        left.push(renderDiffLine({ cls: 'diff-eq', ln: beforeLn, gutter: ' ', text: line.text }));
        right.push(renderDiffLine({ cls: 'diff-eq', ln: afterLn, gutter: ' ', text: line.text }));
        return;
      }
      if (line.op === 'remove') {
        beforeLn += 1;
        left.push(renderDiffLine({ cls: 'diff-remove', ln: beforeLn, gutter: '-', text: line.text }));
        right.push(renderDiffLine({ cls: 'diff-blank', ln: '', gutter: ' ', text: '' }));
        return;
      }
      if (line.op === 'add') {
        afterLn += 1;
        left.push(renderDiffLine({ cls: 'diff-blank', ln: '', gutter: ' ', text: '' }));
        right.push(renderDiffLine({ cls: 'diff-add', ln: afterLn, gutter: '+', text: line.text }));
      }
    });
    return '<div class="diff-split" role="region" aria-label="Side-by-side line diff for ' + esc(ch.key) + '">' +
      '<div class="diff-pane"><div class="pane-head">Before</div>' + left.join('') + '</div>' +
      '<div class="diff-pane"><div class="pane-head">After</div>' + right.join('') + '</div>' +
      '</div>';
  }

`;
}

function pageClientScriptPartBDiffView(): string {
  return `
  function presenceLabel(n) {
    return (n.name ? esc(n.name) + ' · ' : '') + esc(n.type || '?');
  }

  function isCollapsiblePresenceText(value) {
    var s = String(value == null ? '' : value);
    if (s.indexOf('\\n') >= 0) return true;
    return s.length > PRESENCE_SHORT_TEXT_MAX;
  }

  function renderPresenceProperty(p) {
    if (p.kind === 'text') {
      var text = String(p.value == null ? '' : p.value);
      if (isCollapsiblePresenceText(text)) {
        return '<details class="presence-text"><summary><strong>' + esc(p.key) + '</strong>' +
          ' <span class="muted">(' + text.split('\\n').length + ' lines)</span></summary>' +
          '<pre class="presence-pre">' + esc(text) + '</pre></details>';
      }
      // Short single-line fields (format, syntax, …) stay inline expanded.
      return '<div class="prop-change"><strong>' + esc(p.key) + '</strong>: ' +
        '<code class="presence-inline">' + esc(text) + '</code></div>';
    }
    return '<div class="prop-change"><strong>' + esc(p.key) + '</strong>: ' +
      '<code class="presence-inline">' + esc(JSON.stringify(p.value)) + '</code></div>';
  }

  function renderPresenceNode(n, kind) {
    var title = kind === 'added' ? 'Node added' : 'Node removed';
    var open = kind === 'added' ? ' open' : '';
    var props = (n.properties || []).map(renderPresenceProperty).join('');
    return '<details class="node-presence node-' + kind + '"' + open + '>' +
      '<summary><strong>' + title + '</strong> · ' +
      '<code title="' + esc(n.id) + '">' + tipId(n.id, 8) + '</code> ' +
      presenceLabel(n) + '</summary>' +
      '<div class="presence-body">' + (props || '<p class="muted">No properties.</p>') +
      '</div></details>';
  }

  function renderPropertyChange(ch, mode) {
    if (ch.kind === 'text') {
      var body = mode === 'split' ? renderSplitTextDiff(ch) : renderUnifiedTextDiff(ch);
      return '<div class="prop-change"><strong>' + esc(ch.key) + '</strong>' + body + '</div>';
    }
    if (mode === 'split') {
      return '<div class="prop-change"><strong>' + esc(ch.key) + '</strong>' +
        '<div class="prop-change-scalar split">' +
        '<div class="scalar-side"><span class="side-label">Before</span>' +
        '<code class="diff-before" title="before">' + esc(JSON.stringify(ch.before)) + '</code></div>' +
        '<span class="scalar-arrow" aria-hidden="true">→</span>' +
        '<div class="scalar-side"><span class="side-label">After</span>' +
        '<code class="diff-after" title="after">' + esc(JSON.stringify(ch.after)) + '</code></div>' +
        '</div></div>';
    }
    return '<div class="prop-change"><strong>' + esc(ch.key) + '</strong>: ' +
      '<code class="diff-before" title="before">' + esc(JSON.stringify(ch.before)) + '</code>' +
      ' → <code class="diff-after" title="after">' + esc(JSON.stringify(ch.after)) + '</code></div>';
  }

  function renderDiffSections(sections, mode, emptyMsg) {
    var parts = '';
    if (sections.added && sections.added.length) {
      parts += '<div class="diff-section"><h4>Added nodes</h4>' +
        sections.added.map(function (n) { return renderPresenceNode(n, 'added'); }).join('') +
        '</div>';
    }
    if (sections.removed && sections.removed.length) {
      parts += '<div class="diff-section"><h4>Removed nodes</h4>' +
        sections.removed.map(function (n) { return renderPresenceNode(n, 'removed'); }).join('') +
        '</div>';
    }
    if (sections.modified && sections.modified.length) {
      parts += '<div class="diff-section"><h4>Modified nodes</h4>' +
        sections.modified.map(function (m) {
          return '<div class="modified-node">' +
            '<div><code title="' + esc(m.id) + '">' + tipId(m.id, 8) + '</code> ' +
            (m.name ? esc(m.name) + ' · ' : '') + esc(m.type || '?') + '</div>' +
            (m.changes || []).map(function (ch) { return renderPropertyChange(ch, mode); }).join('') +
            '</div>';
        }).join('') + '</div>';
    }
    if (!parts) {
      parts = '<p class="muted">' + esc(emptyMsg) + '</p>';
    }
    return parts;
  }

  function renderDiffView(diff, mode) {
    if (!diff) return '<p class="muted">Diff unavailable.</p>';
    mode = mode || getDiffMode();
    var stale = diff.baseRevStale
      ? '<p class="stale-banner" role="status">Base revision is stale — approve would fail. Ask the AI to re-read flows and resubmit. Primary diff below is still vs the stored base snapshot (what the AI changed).</p>'
      : '';
    var missing = diff.baseSnapshotMissing
      ? '<p class="muted">This legacy proposal has no stored base snapshot; comparing against the live flow.</p>'
      : '';
    var sum = diff.summary || {};
    var against = diff.compareAgainst === 'base' ? 'base snapshot' : 'current flow';
    var counts = '<p class="diff-summary"><strong>+' + (sum.added || 0) +
      '</strong> added · <strong>-' + (sum.removed || 0) +
      '</strong> removed · <strong>~' + (sum.modified || 0) +
      '</strong> modified' +
      (sum.tabChanges && sum.tabChanges.length
        ? ' · tab: ' + esc(sum.tabChanges.join(', '))
        : '') +
      ' <span class="muted">(vs ' + against + ')</span></p>';
    var meta = '<p class="muted">expectedRev ' + tipId(diff.expectedRev, 8) +
      ' · currentRev ' + tipId(diff.currentRev, 8) + '</p>';
    var toolbar =
      '<div class="diff-toolbar">' + counts +
      '<div class="diff-mode-toggle" role="group" aria-label="Diff layout">' +
      '<button type="button" data-diff-mode="split" aria-pressed="' + (mode === 'split' ? 'true' : 'false') + '">Side by side</button>' +
      '<button type="button" data-diff-mode="unified" aria-pressed="' + (mode === 'unified' ? 'true' : 'false') + '">Unified</button>' +
      '</div></div>';
    var sections = renderDiffSections(
      diff,
      mode,
      diff.compareAgainst === 'base'
        ? 'No node changes vs the base snapshot.'
        : 'No node changes vs the current flow.'
    );
    var vsCurrent = '';
    if (diff.vsCurrent) {
      var vc = diff.vsCurrent.summary || {};
      vsCurrent =
        '<details class="vs-current">' +
        '<summary>Also show changes vs current flow (+' + (vc.added || 0) +
        ' / -' + (vc.removed || 0) + ' / ~' + (vc.modified || 0) + ')</summary>' +
        renderDiffSections(diff.vsCurrent, mode, 'No node changes vs the current flow.') +
        '</details>';
    }
    return stale + missing + toolbar + meta + sections + vsCurrent;
  }
`;
}

function pageClientScriptPartB2(): string {
  return `
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
        var createdBy = '';
        if (p.createdBy) {
          if (p.createdBy.label) {
            createdBy = ' · AI link "' + esc(p.createdBy.label) + '"';
          } else if (p.createdBy.linkId) {
            createdBy = ' · AI link ' + tipId(p.createdBy.linkId, 8);
          }
        }
        return '<article class="proposal-detail" data-id="' + esc(p.id) + '">' +
          '<strong title="' + esc(p.id) + '">' + tipId(p.id, 12) + '</strong> · <code>' + esc(p.status) + '</code><br/>' +
          '<span class="muted">' + esc(proposalSummary(p)) + '</span><br/>' +
          '<span class="muted">expectedRev ' + tipId(p.expectedRev, 8) +
          ' · created ' + esc(fmtCompact(p.createdAt)) +
          createdBy +
          '</span>' +
          reason +
          '<div class="proposal-diff" data-diff-for="' + esc(p.id) + '"><p class="muted">Loading diff…</p></div>' +
          '<details><summary>Raw payload</summary><pre>' + esc(JSON.stringify(p.payload, null, 2)) + '</pre></details>' +
          actions +
          '</article>';
      }).join('');
      list.querySelectorAll('.approve-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { approveProposal(btn.getAttribute('data-id')); });
      });
      list.querySelectorAll('.reject-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { rejectProposal(btn.getAttribute('data-id')); });
      });
      proposals.forEach(function (p) { loadProposalDiff(p.id); });
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  function bindDiffModeToggle(host, diff) {
    host.querySelectorAll('[data-diff-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-diff-mode');
        if (mode !== 'split' && mode !== 'unified') return;
        setDiffMode(mode);
        host.innerHTML = renderDiffView(diff, mode);
        bindDiffModeToggle(host, diff);
      });
    });
  }

  async function loadProposalDiff(id) {
    var host = document.querySelector('.proposal-diff[data-diff-for="' + id + '"]');
    if (!host) return;
    try {
      var diff = await api('/proposals/' + encodeURIComponent(id) + '/diff');
      host.innerHTML = renderDiffView(diff);
      bindDiffModeToggle(host, diff);
    } catch (e) {
      host.innerHTML = '<p class="muted">Could not load diff: ' + esc(e.message || String(e)) + '</p>';
    }
  }`;
}

function pageClientScriptPartC(): string {
  return `

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

  var cachedLogs = [];

  function renderLogsTable(logs) {
    var list = $('logs-list');
    if (!logs.length) {
      list.innerHTML = '<p class="muted">No matching audit entries.</p>';
      return;
    }
    list.innerHTML = '<table class="audit-table"><thead><tr>' +
      '<th class="col-when">When</th><th class="col-action">Action</th>' +
      '<th class="col-actor">Actor</th><th class="col-details">Details</th></tr></thead><tbody>' +
      logs.map(function (e) {
        var raw = esc(JSON.stringify(e.details || {}, null, 2));
        return '<tr>' +
          '<td class="col-when" title="' + esc(e.at) + '">' + esc(fmtCompact(e.at)) + '</td>' +
          '<td class="col-action">' + actionBadge(e.action) + '</td>' +
          '<td class="col-actor" title="' + esc(actorPlain(e.actor)) + '">' + actorLabel(e.actor) + '</td>' +
          '<td class="col-details"><div class="audit-summary">' + auditSummary(e) + '</div>' +
          '<details class="audit-raw"><summary>raw</summary><pre>' + raw + '</pre></details></td>' +
          '</tr>';
      }).join('') + '</tbody></table>';
  }

  function applyLogFilter() {
    var filter = $('logs-filter');
    var action = filter && filter.value ? filter.value : '';
    var filtered = !action
      ? cachedLogs
      : cachedLogs.filter(function (e) { return e.action === action; });
    renderLogsTable(filtered);
  }

  async function loadLogs() {
    if (!aiOn) return;
    var flash = $('logs-flash');
    showFlash(flash, '', true);
    try {
      var data = await api('/logs?limit=100');
      cachedLogs = (data && data.logs) || [];
      var filter = $('logs-filter');
      if (filter) {
        var actions = [];
        cachedLogs.forEach(function (e) {
          if (e.action && actions.indexOf(e.action) === -1) actions.push(e.action);
        });
        actions.sort();
        var current = filter.value || '';
        filter.innerHTML = '<option value="">All actions</option>' +
          actions.map(function (a) {
            return '<option value="' + esc(a) + '"' +
              (a === current ? ' selected' : '') + '>' + esc(actionFilterLabel(a)) + '</option>';
          }).join('');
      }
      applyLogFilter();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

`;
}

function pageClientScriptPartD(): string {
  return `
  function applyStatus(s) {
    aiOn = !!s.aiFeaturesEnabled;
    canManage = !!(s.capabilities && s.capabilities.manageLinks);
    canApprove = !!(s.capabilities && s.capabilities.approveProposals);
    defaultTtl = s.defaultLinkTtlSeconds || 14400;
    defaultDeploy = s.defaultDeploymentType || 'nodes';

    $('status-version').textContent = s.version;
    $('status-adminauth').textContent = s.adminAuthEnabled ? 'enabled' : 'disabled';
    $('status-aifeatures').textContent = s.aiFeaturesEnabled ? 'enabled' : 'disabled';
    $('status-permission').textContent = s.permission || 'none (access-link or anonymous)';
    $('status-caller').textContent = s.caller
      ? (s.caller.kind + (s.caller.linkId ? ':' + s.caller.linkId : '') + (s.caller.permission ? ':' + s.caller.permission : ''))
      : '—';
    $('status-storage').textContent = s.storageDir;
    $('status-ttl').textContent = String(s.defaultLinkTtlSeconds) + 's';
    $('status-maxlinks').textContent = String(s.maxActiveLinks);
    $('status-deploy').textContent = s.defaultDeploymentType;
    var modeLabel = s.permission === '*' ? 'full access' : s.permission === 'read' ? 'read-only' : 'limited';
    $('status-badge').textContent = modeLabel;

    var warning = $('status-warning');
    if (!s.adminAuthEnabled && !s.aiFeaturesEnabled) {
      warning.hidden = false;
      warning.innerHTML = '<h2>Warning</h2><p><code>adminAuth</code> is not enabled, so AI Access features are <strong>disabled</strong> by default.</p>';
    } else if (!s.adminAuthEnabled && s.aiFeaturesEnabled) {
      warning.hidden = false;
      warning.innerHTML = '<h2>Local-only mode</h2><p><code>adminAuth</code> is off and <code>allowWithoutAdminAuth</code> is enabled.</p>';
    } else {
      warning.hidden = true;
      warning.innerHTML = '';
    }

    $('proposals-hint').textContent = canApprove
      ? 'Approve deploys via FlowAdapter. Revision conflicts are shown as rejected proposals.'
      : 'Approve and reject require full admin permission (*). You can still review proposals.';

    renderLinksManage();
  }

  async function boot() {
    accessToken = readEditorToken();
    if (!accessToken) {
      showFlash($('boot-flash'), 'Not signed in to the Node-RED editor. Redirecting to login…', false);
      redirectToEditorLogin();
      return;
    }
    try {
      var s = await api('/status');
      applyStatus(s);
      $('main-nav').hidden = false;
      $('section-status').hidden = false;
      $('section-links').hidden = false;
      $('section-proposals').hidden = false;
      $('section-logs').hidden = false;
      if (aiOn) {
        if (canManage) loadLinks();
        loadProposals();
        loadLogs();
      }
    } catch (e) {
      showFlash($('boot-flash'), e.message || String(e), false);
    }
  }

  var refreshBtn = $('refresh-status');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      try {
        var s = await api('/status');
        applyStatus(s);
      } catch (e) {
        showFlash($('status-flash'), e.message || String(e), false);
      }
    });
  }

  var logsFilter = $('logs-filter');
  if (logsFilter) {
    logsFilter.addEventListener('change', applyLogFilter);
  }

  boot();
})();
`;
}

export function pageClientScript(): string {
  return (
    pageClientScriptPartA() +
    pageClientScriptPartAFormat() +
    pageClientScriptPartATabs() +
    pageClientScriptPartA2() +
    pageClientScriptPartB() +
    pageClientScriptPartBDiff() +
    pageClientScriptPartBDiffView() +
    pageClientScriptPartB2() +
    pageClientScriptPartC() +
    pageClientScriptPartD()
  ).trim();
}
