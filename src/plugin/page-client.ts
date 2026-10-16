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
  var proposalsFilter = 'pending';
  var cachedProposals = [];
  var proposalDiffCache = {};
  var pendingRejectId = null;
  var pendingApproveCtx = null;

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

  function editorLoginUrl() {
    var target = editorRoot;
    if (!target || target === '') target = '/';
    return target;
  }

  function showAuthGate() {
    var gate = $('auth-gate');
    var nav = $('main-nav');
    if (nav) nav.hidden = true;
    ['section-status', 'section-links', 'section-proposals', 'section-logs'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });
    if (gate) {
      gate.hidden = false;
      var ed = $('auth-gate-editor');
      if (ed) ed.setAttribute('href', editorLoginUrl());
      var ret = $('auth-gate-return');
      if (ret) {
        ret.setAttribute('href', (typeof location !== 'undefined' ? location.pathname : '/mcp') +
          (typeof location !== 'undefined' ? location.search : '') +
          (typeof location !== 'undefined' ? location.hash : ''));
      }
    }
    showFlash($('boot-flash'), 'Please sign in to Node-RED first.', false);
  }

  function isStatusPath(path) {
    return path === '/status' || path.indexOf('/status?') === 0;
  }

  function showToast(message, ok) {
    var host = $('toast-host');
    if (!host || !message) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (ok ? 'ok' : 'error');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3200);
  }

  function hoursLabel(seconds) {
    var s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return '—';
    var h = Math.round(s / 3600);
    if (h < 1) {
      var m = Math.max(1, Math.round(s / 60));
      return m + ' min';
    }
    return h === 1 ? '1 hour' : h + ' hours';
  }

  function fieldLabel(key) {
    if (key === 'wires') return 'Connects to';
    return key;
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
    // Auth bootstrap: show a sign-in gate instead of silently bouncing.
    if (res.status === 401 && isStatusPath(path)) {
      showAuthGate();
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

function pageClientScriptPartATimeCopy(): string {
  return `
  // Time helpers — keep in sync with page-time.ts (always browser-local Intl).
  function titleFromDisplayName(displayName) {
    var s = String(displayName || '');
    var idx = s.lastIndexOf(' · ');
    if (idx > 0) return s.slice(0, idx);
    return s;
  }
  function fmtCompact(iso) {
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).format(d);
    } catch (e) {
      return String(iso);
    }
  }
  /** Browser-local short stamp from ISO createdAt/at (never server displayName). */
  function fmtLocalShort(iso) {
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return new Intl.DateTimeFormat(undefined, {
        day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit',
        hour12: false
      }).format(d);
    } catch (e) {
      return String(iso);
    }
  }
  function proposalHeading(p) {
    // Never render API displayName (server TZ). Rebuild from title + createdAt.
    var title = p.title || (p.displayName ? titleFromDisplayName(p.displayName) : '');
    if (title && p.createdAt) {
      return esc(title) + ' · ' + esc(fmtLocalShort(p.createdAt));
    }
    if (title) return esc(title);
    if (p.createdAt) return esc(fmtLocalShort(p.createdAt));
    return tipId(p.id, 12);
  }
  function fmtRelative(iso) {
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      var diffMs = d.getTime() - Date.now();
      var abs = Math.abs(diffMs);
      var mins = Math.round(abs / 60000);
      var hours = Math.round(abs / 3600000);
      var days = Math.round(abs / 86400000);
      var phrase;
      if (mins < 1) phrase = 'just now';
      else if (mins < 60) phrase = mins + 'm';
      else if (hours < 48) phrase = hours + 'h';
      else phrase = days + 'd';
      if (phrase === 'just now') return phrase;
      return diffMs >= 0 ? 'in ' + phrase : phrase + ' ago';
    } catch (e) {
      return String(iso);
    }
  }
  function timeCell(iso) {
    if (!iso) return '—';
    // Exact local time on hover; relative text for scanability.
    return '<time class="time-relative" datetime="' + esc(iso) + '" title="' +
      esc(fmt(iso)) + '">' + esc(fmtRelative(iso)) + '</time>';
  }
  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      }
    });
  }
  function markCopied(btn, flash, okMsg) {
    if (!btn) return;
    var prev = btn.getAttribute('data-label') || btn.textContent || 'Copy';
    btn.setAttribute('data-label', prev);
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    btn.disabled = true;
    if (flash && okMsg) showFlash(flash, okMsg, true);
    setTimeout(function () {
      btn.textContent = btn.getAttribute('data-label') || 'Copy link';
      btn.classList.remove('copied');
      btn.disabled = false;
    }, 1600);
  }
`;
}

function pageClientScriptPartAFormat(): string {
  return `
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
        return 'AI link "' + String(actor.label) + '"' +
          (actor.linkId ? ' (' + String(actor.linkId) + ')' : '');
      }
      return 'AI link ' + String(actor.linkId || '');
    }
    if (actor.kind === 'admin') {
      return actor.username
        ? 'You (admin) — ' + String(actor.username)
        : 'You (admin)';
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
      return 'You (admin)';
    }
    if (actor.kind === 'system') return 'system';
    return esc(actor.kind || 'unknown');
  }
  function actionBadge(action) {
    var labels = {
      'proposal.created': 'Created',
      'proposal.approved': 'Approved',
      'proposal.rejected': 'Rejected',
      'proposal.failed': 'Failed',
      'link.created': 'Link created',
      'link.revoked': 'Link revoked'
    };
    var label = labels[action];
    if (label) {
      var kind = (action.split('.')[1] || 'other');
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
      'proposal.failed': 'Failed',
      'link.created': 'Link created',
      'link.revoked': 'Link revoked'
    };
    return labels[action] || action;
  }
  function friendlyReason(reason) {
    var s = String(reason == null ? '' : reason);
    if (!s) return '';
    if (/forEach/i.test(s) || /Cannot read properties/i.test(s)) {
      return 'Deploy failed — Node-RED received an unexpected flow shape. Ask the AI to resubmit.';
    }
    return s;
  }
`;
}

function pageClientScriptPartAAudit(): string {
  return `
  function lookupCachedProposal(id) {
    if (!id) return null;
    return cachedProposals.filter(function (x) { return x.id === id; })[0] || null;
  }
  function auditProposalLabel(d, atIso) {
    // Never render API displayName (server TZ). Rebuild from title + entry.at.
    // Older audit rows may lack title — resolve from the live proposal cache.
    var p = lookupCachedProposal(d.proposalId);
    var title = d.title ||
      (p && p.title) ||
      (d.displayName ? titleFromDisplayName(d.displayName) : '') ||
      (p && p.displayName ? titleFromDisplayName(p.displayName) : '');
    var linked = '';
    if (title && d.proposalId) {
      linked = '<a class="audit-proposal-link" href="#proposal=' +
        encodeURIComponent(String(d.proposalId)) + '">' + esc(String(title)) + '</a>';
    } else if (title) {
      linked = '<strong class="audit-display-name">' + esc(String(title)) + '</strong>';
    } else if (d.proposalId) {
      linked = '<a class="audit-proposal-link" href="#proposal=' +
        encodeURIComponent(String(d.proposalId)) + '">' + tipId(d.proposalId, 12) + '</a>';
    }
    if (linked && atIso) {
      return linked + ' · ' + esc(fmtLocalShort(atIso));
    }
    if (linked) return linked;
    if (atIso) {
      return '<strong class="audit-display-name">' + esc(fmtLocalShort(atIso)) + '</strong>';
    }
    return '';
  }
  function flowNameFromDetails(d) {
    if (d.flowLabel) return String(d.flowLabel);
    if (d.flowName) return String(d.flowName);
    var p = lookupCachedProposal(d.proposalId);
    if (p) {
      var label = flowLabelOf(p);
      if (label) return label;
    }
    // Never show raw flow ids like tab1 in the audit summary.
    return '';
  }
  function auditSummary(entry) {
    var d = entry.details || {};
    var action = entry.action || '';
    var prop = auditProposalLabel(d, entry.at);
    var flowName = flowNameFromDetails(d);
    var flow = flowName ? esc(flowName) : '';
    if (action === 'proposal.created') {
      return (prop || 'Proposal') + ' created' + (flow ? ' for flow "' + flow + '"' : '');
    }
    if (action === 'proposal.approved') {
      var rev = d.resultRev ? tipId(d.resultRev, 8) : '';
      return 'Approved' + (prop ? ' ' + prop : '') +
        (flow ? ' for flow "' + flow + '"' : '') +
        (rev ? ', deployed (rev ' + rev + ')' : '');
    }
    if (action === 'proposal.rejected') {
      var rejectReason = friendlyReason(d.reason);
      return 'Rejected' + (prop ? ' ' + prop : '') +
        (rejectReason ? ': ' + esc(rejectReason) : '');
    }
    if (action === 'proposal.failed') {
      var failReason = friendlyReason(d.reason);
      return 'Failed' + (prop ? ' ' + prop : '') +
        (failReason ? ': ' + esc(failReason) : '');
    }
    if (action === 'link.created') {
      return 'Access link created' +
        (d.label ? ' "' + esc(String(d.label)) + '"' : '') +
        (d.expiresAt ? ' · expires ' + timeCell(d.expiresAt) : '');
    }
    if (action === 'link.revoked') {
      return 'Access link revoked' +
        (d.label ? ' "' + esc(String(d.label)) + '"' : '') +
        (d.linkId ? ' · ' + tipId(d.linkId, 8) : '');
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
  // Hash helpers — keep in sync with page-hash.ts
  function hashForTab(tab) {
    if (tab === 'logs') return 'audit';
    if (tab === 'status' || tab === 'links' || tab === 'proposals') return tab;
    return 'status';
  }

  function tabFromHash(hash) {
    var raw = String(hash || '').replace(/^#/, '');
    if (!raw || raw.indexOf('proposal=') === 0) return '';
    if (raw === 'audit' || raw === 'logs') return 'logs';
    if (raw === 'status' || raw === 'links' || raw === 'proposals') return raw;
    return '';
  }

  function initialTabFromHash(hash) {
    if (readProposalHashIdFrom(hash)) return 'proposals';
    return tabFromHash(hash) || 'status';
  }

  function readProposalHashIdFrom(hash) {
    try {
      var m = String(hash || '').match(/^#proposal=([^&]+)/);
      if (!m) return '';
      return decodeURIComponent(m[1]);
    } catch (e) {
      return '';
    }
  }

  function replaceLocationHash(hash) {
    var next = '';
    if (hash) {
      next = hash.charAt(0) === '#' ? hash : '#' + hash;
    }
    if (String(location.hash || '') === next) return;
    try {
      history.replaceState(null, '', location.pathname + location.search + next);
    } catch (e) {
      location.hash = next;
    }
  }

  function clearProposalHighlight() {
    document.querySelectorAll('.proposal-detail.proposal-highlight').forEach(function (node) {
      node.classList.remove('proposal-highlight');
    });
  }

  function selectTab(target, options) {
    options = options || {};
    if (!target) return;
    document.querySelectorAll('nav.tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === target ? 'true' : 'false');
    });
    document.querySelectorAll('section.panel').forEach(function (sec) {
      sec.classList.toggle('active', sec.id === 'section-' + target);
    });
    if (target !== 'proposals') {
      clearProposalHighlight();
    }
    if (!options.skipHash) {
      if (options.proposalId && target === 'proposals') {
        replaceLocationHash('#proposal=' + encodeURIComponent(String(options.proposalId)));
      } else {
        replaceLocationHash('#' + hashForTab(target));
      }
    }
  }

  function loadTabData(target) {
    if (target === 'links') loadLinks();
    if (target === 'proposals') loadProposals();
    if (target === 'logs') {
      // Load proposals so older audit rows can resolve titles / flow labels.
      loadProposals();
      loadLogs();
    }
  }

  document.querySelectorAll('nav.tabs button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-tab');
      selectTab(target);
      loadTabData(target);
    });
  });

  function selectedTtlSeconds() {
    var pressed = document.querySelector('#link-ttl-presets button[aria-pressed="true"]');
    var hours = pressed ? Number(pressed.getAttribute('data-hours')) : Math.max(1, Math.round(defaultTtl / 3600));
    if (!Number.isFinite(hours) || hours <= 0) hours = 4;
    return Math.floor(hours * 3600);
  }

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
    var defaultHours = Math.max(1, Math.round(defaultTtl / 3600));
    if ([1, 4, 24].indexOf(defaultHours) < 0) defaultHours = 4;
    host.innerHTML =
      '<form id="create-link-form">' +
      '<div class="row" style="align-items:flex-end">' +
      '<div><span class="muted">Link expires after</span>' +
      '<div class="ttl-presets" id="link-ttl-presets" role="group" aria-label="Link expires after">' +
      '<button type="button" data-hours="1"' + (defaultHours === 1 ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>1 hour</button>' +
      '<button type="button" data-hours="4"' + (defaultHours === 4 ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>4 hours</button>' +
      '<button type="button" data-hours="24"' + (defaultHours === 24 ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>24 hours</button>' +
      '</div></div>' +
      '<label>Label (optional)<input id="link-label" type="text" maxlength="120" placeholder="e.g. Claude session" /></label>' +
      '<button type="submit" class="action">Create access link</button></div></form>' +
      '<div id="token-once" class="token-once" hidden>' +
      '<p id="token-docs-hint" class="muted"></p>' +
      '<button type="button" class="action copy-ai-primary" id="token-copy-btn">Copy link for your AI assistant</button>' +
      '<details class="advanced-block" id="token-dev-details">' +
      '<summary>For developers</summary>' +
      '<p class="muted">Bearer token and API endpoints (reusable while this link is active — also available via Copy link in the table).</p>' +
      '<code id="token-value"></code>' +
      '<pre id="token-copy-block" class="token-copy-block"></pre>' +
      '</details></div>';
    var presets = $('link-ttl-presets');
    if (presets) {
      presets.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          presets.querySelectorAll('button').forEach(function (b) {
            b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
          });
        });
      });
    }
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
    if (!aiOn || !canManage) {
      var dashLinksOff = $('dash-links');
      if (dashLinksOff && !aiOn) dashLinksOff.textContent = '—';
      return;
    }
    var list = $('links-list');
    var flash = $('links-flash');
    showFlash(flash, '', true);
    try {
      var data = await api('/links');
      var links = (data && data.links) || [];
      var dashLinks = $('dash-links');
      if (dashLinks) dashLinks.textContent = String(links.length);
      if (!links.length) {
        list.innerHTML = '<div class="empty-state"><p class="empty-title">No active access links</p>' +
          '<p class="muted">Create a link above to give an AI temporary access to read flows and submit proposals.</p></div>';
        return;
      }
      list.innerHTML = '<table class="links-table"><thead><tr>' +
        '<th>Created</th><th>Last used</th><th>Label</th><th>Expires</th><th></th>' +
        '</tr></thead><tbody>' +
        links.map(function (l) {
          var copyDisabled = l.url ? '' : ' disabled title="URL unavailable"';
          return '<tr data-id="' + esc(l.id) + '">' +
            '<td>' + timeCell(l.createdAt) + '</td>' +
            '<td>' + timeCell(l.lastUsedAt) + '</td>' +
            '<td>' + esc(l.label || '—') + '</td>' +
            '<td>' + timeCell(l.expiresAt) + '</td>' +
            '<td class="row-actions">' +
            '<button type="button" class="action secondary copy-link" data-id="' + esc(l.id) + '"' +
            ' data-url="' + esc(l.url || '') + '"' + copyDisabled + '>Copy link</button> ' +
            '<button type="button" class="action danger revoke-link" data-id="' + esc(l.id) + '">Revoke</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table>';
      list.querySelectorAll('.copy-link').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var url = btn.getAttribute('data-url') || '';
          if (!url) {
            showFlash(flash, 'Clipboard unavailable — create a new link to copy.', false);
            return;
          }
          copyTextToClipboard(url).then(function () {
            markCopied(btn, flash, 'Link copied.');
            showToast('Link copied.', true);
          }).catch(function () {
            showFlash(flash, 'Clipboard unavailable — select the URL from a new create.', false);
          });
        });
      });
      list.querySelectorAll('.revoke-link').forEach(function (btn) {
        btn.addEventListener('click', function () { revokeLink(btn.getAttribute('data-id')); });
      });
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  async function revokeLink(id) {
    var flash = $('links-flash');
    if (!window.confirm('Revoke this access link? The AI will lose access immediately.')) {
      return;
    }
    try {
      await api('/links/' + encodeURIComponent(id), { method: 'DELETE' });
      showFlash(flash, 'Link revoked.', true);
      showToast('Link revoked.', true);
      var once = $('token-once');
      if (once) once.hidden = true;
      loadLinks();
      loadLogs();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
      showToast(e.message || String(e), false);
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
    var labelInput = $('link-label');
    var ttlSeconds = selectedTtlSeconds();
    var payload = { ttlSeconds: ttlSeconds };
    if (labelInput && labelInput.value.trim()) payload.label = labelInput.value.trim();
    try {
      var created = await api('/links', { method: 'POST', body: JSON.stringify(payload) });
      var box = $('token-once');
      box.hidden = false;
      var tokenEl = $('token-value');
      if (tokenEl) tokenEl.textContent = created.token || created.url || '';
      var copyBlock = $('token-copy-block');
      var copyText = accessLinkCopyText(created.token, created.url);
      var getLinkOnly = created.url || '';
      if (copyBlock) {
        copyBlock.textContent = copyText;
      }
      var hint = $('token-docs-hint');
      if (hint) {
        hint.textContent = 'Paste this link in your AI chat. It can read flows and submit proposals — it cannot deploy until you approve. While the link is active you can copy it again from the table below.';
      }
      var copyBtn = $('token-copy-btn');
      if (copyBtn) {
        copyBtn.textContent = 'Copy link for your AI assistant';
        copyBtn.classList.remove('copied');
        copyBtn.disabled = false;
        copyBtn.onclick = function () {
          var toCopy = getLinkOnly || copyText;
          copyTextToClipboard(toCopy).then(function () {
            markCopied(copyBtn, flash, 'Copied link for your AI assistant.');
            showToast('Link copied for your AI assistant.', true);
          }).catch(function () {
            showFlash(flash, 'Clipboard unavailable — expand For developers and copy manually.', false);
          });
        };
      }
      if (labelInput) labelInput.value = '';
      showFlash(flash, 'Link created.', true);
      showToast('Access link created.', true);
      loadLinks();
      loadLogs();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
      showToast(e.message || String(e), false);
    }
  }

  function flowLabelOf(p) {
    if (p && p.flowLabel) return String(p.flowLabel);
    var flow = (p && p.payload && p.payload.flow) || {};
    var base = (p && p.baseFlow) || {};
    if (flow.label) return String(flow.label);
    if (base.label) return String(base.label);
    return '';
  }

  function proposalTechSummary(p) {
    var flow = (p.payload && p.payload.flow) || {};
    var nodes = Array.isArray(flow.nodes) ? flow.nodes.length : 0;
    var configs = Array.isArray(flow.configs) ? flow.configs.length : 0;
    var label = flowLabelOf(p) || flow.label || '—';
    return 'flow id ' + (p.payload && p.payload.flowId ? p.payload.flowId : '?') +
      ' · label ' + label +
      ' · nodes ' + nodes +
      ' · configs ' + configs;
  }

  function plainDiffSentence(diff, flowLabel) {
    if (!diff || !diff.summary) return '';
    var sum = diff.summary;
    var parts = [];
    if (sum.added) parts.push('Adds ' + sum.added + (sum.added === 1 ? ' node' : ' nodes'));
    if (sum.removed) parts.push((parts.length ? 'removes ' : 'Removes ') + sum.removed +
      (sum.removed === 1 ? ' node' : ' nodes'));
    if (sum.modified) parts.push((parts.length ? 'changes ' : 'Changes ') + sum.modified +
      (sum.modified === 1 ? ' node' : ' nodes'));
    if (!parts.length) parts.push('No node changes');
    var sentence = parts.join(', ');
    if (flowLabel) sentence += ' in ' + flowLabel;
    return sentence;
  }

  // Keep in sync with isLargeDelete() in proposal-diff.ts (>50% nodes removed).
  function isLargeDelete(diff) {
    if (!diff || !diff.summary) return false;
    var before = Number(diff.summary.beforeNodeCount) || 0;
    var removed = Number(diff.summary.removed) || 0;
    if (before <= 0 || removed <= 0) return false;
    return removed / before > 0.5;
  }

  function proposalIsStale(p) {
    if (!p || p.status !== 'pending') return false;
    if (p.baseRevStale === true) return true;
    var cached = proposalDiffCache[p.id];
    return !!(cached && cached.baseRevStale);
  }

  function formatPendingBadgeText(live, stale) {
    var parts = [];
    if (live > 0) parts.push(live + ' to review');
    if (stale > 0) parts.push(stale + ' out of date');
    return parts.length ? parts.join(' · ') : '0';
  }

  function countPendingBuckets() {
    var pending = cachedProposals.filter(function (p) { return p.status === 'pending'; });
    var stale = 0;
    pending.forEach(function (p) {
      if (proposalIsStale(p)) stale += 1;
    });
    return {
      pending: pending.length,
      live: pending.length - stale,
      stale: stale,
      decided: cachedProposals.filter(function (p) { return p.status !== 'pending'; }).length
    };
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

  /**
   * Pair remove/add runs so large replaces (many removes then many adds) show
   * BEFORE and AFTER content side-by-side — keep in sync with alignSplitDiffLines.
   */
  function alignSplitDiffLines(lines) {
    var rows = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line) { i += 1; continue; }
      if (line.op === 'equal') {
        rows.push({ left: line, right: line });
        i += 1;
        continue;
      }
      var removes = [];
      while (i < lines.length && lines[i] && lines[i].op === 'remove') {
        removes.push(lines[i]);
        i += 1;
      }
      var adds = [];
      while (i < lines.length && lines[i] && lines[i].op === 'add') {
        adds.push(lines[i]);
        i += 1;
      }
      var n = Math.max(removes.length, adds.length);
      for (var k = 0; k < n; k += 1) {
        rows.push({ left: removes[k] || null, right: adds[k] || null });
      }
    }
    return rows;
  }

  function renderSplitTextDiff(ch) {
    var left = [];
    var right = [];
    var beforeLn = 0;
    var afterLn = 0;
    alignSplitDiffLines(ch.lines || []).forEach(function (row) {
      if (row.left && row.left.op === 'equal' && row.right && row.right.op === 'equal') {
        beforeLn += 1;
        afterLn += 1;
        left.push(renderDiffLine({ cls: 'diff-eq', ln: beforeLn, gutter: ' ', text: row.left.text }));
        right.push(renderDiffLine({ cls: 'diff-eq', ln: afterLn, gutter: ' ', text: row.right.text }));
        return;
      }
      if (row.left && row.left.op === 'remove') {
        beforeLn += 1;
        left.push(renderDiffLine({ cls: 'diff-remove', ln: beforeLn, gutter: '-', text: row.left.text }));
      } else {
        left.push(renderDiffLine({ cls: 'diff-blank', ln: '', gutter: ' ', text: '' }));
      }
      if (row.right && row.right.op === 'add') {
        afterLn += 1;
        right.push(renderDiffLine({ cls: 'diff-add', ln: afterLn, gutter: '+', text: row.right.text }));
      } else {
        right.push(renderDiffLine({ cls: 'diff-blank', ln: '', gutter: ' ', text: '' }));
      }
    });
    return '<div class="diff-split" role="region" aria-label="Side-by-side line diff for ' + esc(ch.key) + '">' +
      '<div class="diff-pane"><div class="pane-head">Before</div>' + left.join('') + '</div>' +
      '<div class="diff-pane"><div class="pane-head">After</div>' + right.join('') + '</div>' +
      '</div>';
  }

`;
}

function pageClientScriptPartBDiffPresence(): string {
  return `
  function isCollapsiblePresenceText(value) {
    var s = String(value == null ? '' : value);
    if (s.indexOf('\\n') >= 0) return true;
    return s.length > PRESENCE_SHORT_TEXT_MAX;
  }

  function renderHtmlPreviewBlock(text) {
    // Sandboxed preview: no allow-scripts (and no other allow-* tokens).
    var srcdoc = String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;');
    return '<div class="presence-preview-host" hidden>' +
      '<iframe class="presence-preview-frame" sandbox="" referrerpolicy="no-referrer" ' +
      'title="HTML preview" srcdoc="' + srcdoc + '"></iframe></div>';
  }

  function renderPresenceProperty(p) {
    var label = fieldLabel(p.key);
    if (p.kind === 'text') {
      var text = String(p.value == null ? '' : p.value);
      var previewToggle = '';
      var previewBlock = '';
      if (p.preview === 'html') {
        previewToggle =
          '<button type="button" class="presence-preview-toggle" aria-pressed="false">' +
          'Preview</button>';
        previewBlock = renderHtmlPreviewBlock(text);
      }
      if (isCollapsiblePresenceText(text)) {
        return '<details class="presence-text"><summary><strong>' + esc(label) + '</strong>' +
          ' <span class="muted">(' + text.split('\\n').length + ' lines)</span></summary>' +
          '<div class="presence-text-toolbar">' + previewToggle + '</div>' +
          previewBlock +
          '<pre class="presence-pre">' + esc(text) + '</pre></details>';
      }
      // Short single-line fields (format, syntax, …) stay inline expanded.
      return '<div class="prop-change"><strong>' + esc(label) + '</strong>: ' +
        '<code class="presence-inline">' + esc(text) + '</code></div>';
    }
    // Wires (and other readable strings) stay as plain text, not JSON-quoted.
    if (typeof p.value === 'string') {
      return '<div class="prop-change"><strong>' + esc(label) + '</strong>: ' +
        '<code class="presence-inline">' + esc(p.value) + '</code></div>';
    }
    return '<div class="prop-change"><strong>' + esc(label) + '</strong>: ' +
      '<code class="presence-inline">' + esc(JSON.stringify(p.value)) + '</code></div>';
  }

  function renderPresenceNode(n, kind) {
    var open = kind === 'added' ? ' open' : '';
    var summaryText = n.summary
      ? esc(n.summary)
      : ((kind === 'added' ? 'Node added' : 'Node removed') +
        (n.name ? ' · ' + esc(n.name) : '') +
        ' · ' + esc(n.type || '?'));
    var keyFields = (n.keyFields || []).map(renderPresenceProperty).join('');
    var allProps = (n.properties || []).map(renderPresenceProperty).join('');
    var body =
      (keyFields ? '<div class="presence-key-fields">' + keyFields + '</div>' : '') +
      '<details class="presence-all-props">' +
      '<summary>All properties</summary>' +
      '<div class="presence-all-body">' +
      (allProps || '<p class="muted">No properties.</p>') +
      '</div></details>';
    return '<details class="node-presence node-' + kind + '"' + open + '>' +
      '<summary><span class="presence-summary-text">' + summaryText + '</span> ' +
      '<span class="muted tip-id" title="' + esc(n.id) + '">' + tipId(n.id, 8) + '</span>' +
      '</summary>' +
      '<div class="presence-body">' + body + '</div></details>';
  }

  function bindPresencePreviewToggles(host) {
    if (!host) return;
    host.querySelectorAll('.presence-preview-toggle').forEach(function (btn) {
      if (btn.getAttribute('data-bound') === '1') return;
      btn.setAttribute('data-bound', '1');
      btn.addEventListener('click', function () {
        var wrap = btn.closest('.presence-text') || btn.parentElement;
        if (!wrap) return;
        var preview = wrap.querySelector('.presence-preview-host');
        var code = wrap.querySelector('.presence-pre');
        if (!preview) return;
        var show = preview.hasAttribute('hidden');
        if (show) {
          preview.removeAttribute('hidden');
          if (code) code.setAttribute('hidden', '');
          btn.setAttribute('aria-pressed', 'true');
          btn.textContent = 'Code';
        } else {
          preview.setAttribute('hidden', '');
          if (code) code.removeAttribute('hidden');
          btn.setAttribute('aria-pressed', 'false');
          btn.textContent = 'Preview';
        }
      });
    });
  }
`;
}

function pageClientScriptPartBDiffView(): string {
  return `
  function textChangeLineCount(ch) {
    return (ch.lines || []).length;
  }

  function isLargeTextChange(ch) {
    if (ch.kind !== 'text') return false;
    var beforeB = typeof ch.beforeBytes === 'number' ? ch.beforeBytes : String(ch.before || '').length;
    var afterB = typeof ch.afterBytes === 'number' ? ch.afterBytes : String(ch.after || '').length;
    var lines = textChangeLineCount(ch);
    return beforeB >= 20000 || afterB >= 20000 || lines >= 80;
  }

  function diffHasTextChanges(sections) {
    var modified = (sections && sections.modified) || [];
    for (var i = 0; i < modified.length; i += 1) {
      var changes = modified[i].changes || [];
      for (var j = 0; j < changes.length; j += 1) {
        if (changes[j].kind === 'text') return true;
      }
    }
    return false;
  }

  function renderPropertyChange(ch, mode) {
    var label = fieldLabel(ch.key);
    if (ch.kind === 'text') {
      var body = mode === 'split' ? renderSplitTextDiff(ch) : renderUnifiedTextDiff(ch);
      var sizeHint = '';
      var lineCount = textChangeLineCount(ch);
      if (typeof ch.beforeBytes === 'number' && typeof ch.afterBytes === 'number') {
        sizeHint = ' <span class="muted">(' + ch.beforeBytes + ' → ' + ch.afterBytes + ' bytes';
        if (lineCount) sizeHint += ', ' + lineCount + ' lines';
        sizeHint += ')</span>';
      } else if (lineCount) {
        sizeHint = ' <span class="muted">(' + lineCount + ' lines)</span>';
      }
      if (ch.truncated) {
        sizeHint += ' <span class="muted">(compact summary)</span>';
      }
      if (isLargeTextChange(ch)) {
        return '<details class="prop-change large-text-diff"><summary><strong>' + esc(label) +
          '</strong>' + sizeHint +
          '<div class="large-diff-summary">Large text change — expand to review the full diff.</div></summary>' +
          body + '</details>';
      }
      return '<div class="prop-change"><strong>' + esc(label) + '</strong>' + sizeHint + body + '</div>';
    }
    if (mode === 'split') {
      return '<div class="prop-change"><strong>' + esc(label) + '</strong>' +
        '<div class="prop-change-scalar split">' +
        '<div class="scalar-side"><span class="side-label">Before</span>' +
        '<code class="diff-before" title="before">' + esc(JSON.stringify(ch.before)) + '</code></div>' +
        '<span class="scalar-arrow" aria-hidden="true">→</span>' +
        '<div class="scalar-side"><span class="side-label">After</span>' +
        '<code class="diff-after" title="after">' + esc(JSON.stringify(ch.after)) + '</code></div>' +
        '</div></div>';
    }
      return '<div class="prop-change"><strong>' + esc(label) + '</strong>: ' +
      '<code class="diff-before" title="before">' + esc(JSON.stringify(ch.before)) + '</code>' +
      ' → <code class="diff-after" title="after">' + esc(JSON.stringify(ch.after)) + '</code></div>';
  }
`;
}

function pageClientScriptPartBDiffView2(): string {
  return `
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
          var heading = m.summary
            ? esc(m.summary)
            : ((m.name ? esc(m.name) + ' · ' : '') + esc(m.type || '?'));
          return '<div class="modified-node">' +
            '<div class="modified-heading">' + heading +
            ' <span class="muted tip-id" title="' + esc(m.id) + '">' + tipId(m.id, 8) + '</span></div>' +
            (m.changes || []).map(function (ch) { return renderPropertyChange(ch, mode); }).join('') +
            '</div>';
        }).join('') + '</div>';
    }
    if (!parts) {
      parts = '<p class="muted">' + esc(emptyMsg) + '</p>';
    }
    return parts;
  }

  function renderHumanDiff(diff, mode) {
    if (!diff) return '<p class="muted">Diff unavailable.</p>';
    mode = mode || getDiffMode();
    var missing = diff.baseSnapshotMissing
      ? '<p class="muted">This older proposal has no saved starting snapshot, so the comparison uses the live flow instead.</p>'
      : '';
    var sum = diff.summary || {};
    var against = diff.compareAgainst === 'base'
      ? 'what the AI started from'
      : 'the live flow';
    var counts = '<p class="diff-summary"><strong>+' + (sum.added || 0) +
      '</strong> added · <strong>-' + (sum.removed || 0) +
      '</strong> removed · <strong>~' + (sum.modified || 0) +
      '</strong> modified' +
      (sum.tabChanges && sum.tabChanges.length
        ? ' · tab: ' + esc(sum.tabChanges.join(', '))
        : '') +
      ' <span class="muted">(vs ' + against + ')</span></p>';
    var showModeToggle = diffHasTextChanges(diff) ||
      (diff.vsCurrent && diffHasTextChanges(diff.vsCurrent));
    var toolbar = '<div class="diff-toolbar">' + counts;
    if (showModeToggle) {
      toolbar +=
        '<div class="diff-mode-toggle" role="group" aria-label="Diff layout" ' +
        'title="Switch how multi-line text changes are shown">' +
        '<button type="button" data-diff-mode="split" title="Show before and after side by side" aria-pressed="' +
        (mode === 'split' ? 'true' : 'false') + '">Side by side</button>' +
        '<button type="button" data-diff-mode="unified" title="Show a single combined line diff" aria-pressed="' +
        (mode === 'unified' ? 'true' : 'false') + '">Unified</button>' +
        '</div>';
    }
    toolbar += '</div>';
    var sections = renderDiffSections(
      diff,
      mode,
      diff.compareAgainst === 'base'
        ? 'No node changes compared with what the AI started from.'
        : 'No node changes compared with the live flow.'
    );
    var vsCurrent = '';
    if (diff.vsCurrent) {
      var vc = diff.vsCurrent.summary || {};
      vsCurrent =
        '<details class="vs-current">' +
        '<summary>Also compare with the live flow (+' + (vc.added || 0) +
        ' / -' + (vc.removed || 0) + ' / ~' + (vc.modified || 0) + ')</summary>' +
        renderDiffSections(diff.vsCurrent, mode, 'No node changes compared with the live flow.') +
        '</details>';
    }
    return missing + toolbar + sections + vsCurrent;
  }

  function renderDiffRevMeta(diff) {
    if (!diff) return '';
    return 'expected rev ' + tipId(diff.expectedRev, 8) +
      ' · current rev ' + tipId(diff.currentRev, 8);
  }

  function renderDiffView(diff, mode) {
    // Full view kept for mode-toggle re-render inside .proposal-changes.
    return renderHumanDiff(diff, mode);
  }
`;
}

function pageClientScriptPartB2(): string {
  return `
  function updatePendingBadges() {
    var counts = countPendingBuckets();
    var badgeText = formatPendingBadgeText(counts.live, counts.stale);
    var badge = $('proposals-pending-badge');
    if (badge) {
      badge.textContent = badgeText;
      badge.hidden = counts.pending <= 0;
      badge.title = badgeText;
    }
    var filterCount = $('filter-pending-count');
    if (filterCount) filterCount.textContent = badgeText;
    var decidedCount = $('filter-decided-count');
    if (decidedCount) decidedCount.textContent = String(counts.decided);
    var dashPending = $('dash-pending');
    if (dashPending) dashPending.textContent = badgeText;
    var toolbar = $('proposals-toolbar');
    if (toolbar) {
      toolbar.hidden = !(proposalsFilter === 'pending' && counts.stale > 0 && canApprove);
    }
  }

  function setProposalsFilter(next) {
    proposalsFilter = next === 'decided' ? 'decided' : 'pending';
    var filters = $('proposals-filters');
    if (filters) {
      filters.querySelectorAll('.filter-chip').forEach(function (chip) {
        var f = chip.getAttribute('data-filter');
        chip.setAttribute('aria-pressed', f === proposalsFilter ? 'true' : 'false');
      });
    }
    renderProposalsList();
  }

  function bindOnce(el, event, handler) {
    if (!el || el.getAttribute('data-bound') === '1') return;
    el.setAttribute('data-bound', '1');
    el.addEventListener(event, handler);
  }

  function bindProposalActions(list) {
    list.querySelectorAll('.approve-btn').forEach(function (btn) {
      bindOnce(btn, 'click', function () {
        if (btn.disabled) return;
        approveProposal(btn.getAttribute('data-id'));
      });
    });
    list.querySelectorAll('.reject-btn').forEach(function (btn) {
      bindOnce(btn, 'click', function () {
        openRejectDialog(btn.getAttribute('data-id'));
      });
    });
    list.querySelectorAll('.dismiss-stale-btn').forEach(function (btn) {
      bindOnce(btn, 'click', function () {
        rejectProposal(btn.getAttribute('data-id'), 'Dismissed — ask the AI to resubmit');
      });
    });
    list.querySelectorAll('.deploy-type').forEach(function (sel) {
      bindOnce(sel, 'change', function () {
        var warn = list.querySelector('.full-deploy-warn[data-id="' + sel.getAttribute('data-id') + '"]');
        if (warn) warn.hidden = sel.value !== 'full';
      });
    });
    list.querySelectorAll('.proposal-card-compact').forEach(function (card) {
      bindOnce(card, 'click', function () {
        var id = card.getAttribute('data-id');
        var full = list.querySelector('.proposal-detail[data-id="' + id + '"]');
        if (!full) return;
        var open = full.hasAttribute('hidden');
        if (open) {
          var p = cachedProposals.filter(function (x) { return x.id === id; })[0];
          if (p) {
            var wrap = document.createElement('div');
            wrap.innerHTML = renderProposalCard(p);
            var next = wrap.firstChild;
            full.parentNode.replaceChild(next, full);
            full = next;
            bindProposalActions(list);
          }
          full.hidden = false;
          card.setAttribute('aria-expanded', 'true');
          loadProposalDiff(id);
        } else {
          full.hidden = true;
          card.setAttribute('aria-expanded', 'false');
        }
      });
    });
  }

  function renderStaleWarning(p) {
    return '<div class="stale-warning-row" role="status">' +
      '<p class="stale-banner">This proposal is out of date — the flow changed since the AI submitted it. Approve is unavailable; ask the AI to resubmit, or dismiss.</p>' +
      '<p class="muted dismiss-vs-reject">Dismiss closes this out-of-date item from your queue (the AI is asked to resubmit). Reject tells the AI the change was refused — use Reject only on proposals that are still current.</p>' +
      (canApprove
        ? '<button type="button" class="action secondary dismiss-stale-btn" data-id="' +
          esc(p.id) + '">Dismiss</button>'
        : '') +
      '</div>';
  }

  function renderPendingActions(p, stale) {
    if (!canApprove || p.status !== 'pending') return '';
    // Stale cards: only the warning + Dismiss row (no Approve/Reject block).
    if (stale) return '';
    return '<p class="muted approve-help">Approve deploys this change to Node-RED. Nothing is live until you approve.</p>' +
      '<div class="row">' +
      '<button type="button" class="action approve-btn" data-id="' + esc(p.id) +
      '">Approve &amp; deploy</button>' +
      '<button type="button" class="action secondary reject-btn" data-id="' + esc(p.id) +
      '">Reject</button>' +
      '</div>' +
      '<details class="advanced-block">' +
      '<summary>Deploy options</summary>' +
      '<label>Deploy type<select class="deploy-type" data-id="' + esc(p.id) + '">' +
      '<option value="nodes"' + (defaultDeploy === 'nodes' ? ' selected' : '') + '>nodes</option>' +
      '<option value="flows"' + (defaultDeploy === 'flows' ? ' selected' : '') + '>flows</option>' +
      '<option value="full"' + (defaultDeploy === 'full' ? ' selected' : '') + '>full</option>' +
      '</select></label>' +
      '<p class="muted">nodes = only changed nodes restart, recommended</p>' +
      '<p class="full-deploy-warn" data-id="' + esc(p.id) + '"' +
      (defaultDeploy === 'full' ? '' : ' hidden') +
      '>Warning: full restarts the entire runtime.</p>' +
      '</details>';
  }
`;
}

function pageClientScriptPartB2Cards(): string {
  return `
  function renderProposalCard(p) {
    var title = p.title || (p.displayName ? titleFromDisplayName(p.displayName) : 'Proposal');
    var flowLabel = flowLabelOf(p);
    var createdBy = '';
    if (p.createdBy) {
      if (p.createdBy.label) {
        createdBy = '<span class="muted">From AI link "' + esc(p.createdBy.label) + '"</span>';
      } else if (p.createdBy.linkId) {
        createdBy = '<span class="muted">From AI link ' + tipId(p.createdBy.linkId, 8) + '</span>';
      }
    }
    var reason = p.reason
      ? '<p class="muted">Reason: ' + esc(friendlyReason(p.reason)) + '</p>'
      : '';
    var cached = proposalDiffCache[p.id];
    var plain = cached ? plainDiffSentence(cached, flowLabel) : '';
    var deleteBanner = '';
    if (cached && isLargeDelete(cached) && !proposalIsStale(p)) {
      var beforeN = cached.summary.beforeNodeCount || 0;
      var removedN = cached.summary.removed || 0;
      deleteBanner = '<div class="delete-banner" role="status">Deletes ' + removedN +
        ' of ' + beforeN + ' nodes</div>';
    }
    var stale = proposalIsStale(p);
    var actions = renderPendingActions(p, stale);
    var changes =
      '<div class="proposal-changes proposal-diff" data-diff-for="' + esc(p.id) +
      '" data-changes-for="' + esc(p.id) + '">' +
      (cached ? renderHumanDiff(cached) : '<p class="muted">Loading changes…</p>') +
      '</div>';
    var tech =
      '<details class="tech-details">' +
      '<summary>Technical details</summary>' +
      '<p class="muted">' + esc(proposalTechSummary(p)) + '</p>' +
      '<p class="muted proposal-rev-meta" data-rev-for="' + esc(p.id) + '">' +
      (cached
        ? renderDiffRevMeta(cached) + ' · id ' + tipId(p.id, 12)
        : 'expectedRev ' + tipId(p.expectedRev, 8) + ' · id ' + tipId(p.id, 12)) +
      '</p>' +
      '<details><summary>Raw payload</summary><pre>' +
      esc(JSON.stringify(p.payload, null, 2)) + '</pre></details>' +
      '</details>';
    return '<article class="proposal-detail" id="proposal-' + esc(p.id) +
      '" data-id="' + esc(p.id) + '" data-status="' + esc(p.status) +
      '"' + (stale ? ' data-stale="1"' : '') + '>' +
      '<header class="proposal-card-head">' +
      '<h3 class="proposal-heading">' + esc(title) + '</h3>' +
      '<span class="status-pill ' + esc(p.status) + '">' + esc(p.status) + '</span> ' +
      '<span class="proposal-meta-line">' +
      (flowLabel ? '<span class="proposal-flow">' + esc(flowLabel) + '</span> · ' : '') +
      timeCell(p.createdAt) +
      '</span>' +
      '</header>' +
      (createdBy ? createdBy + '<br/>' : '') +
      '<p class="proposal-plain-summary" data-plain-for="' + esc(p.id) + '">' +
      (plain ? esc(plain) : '<span class="muted">Loading summary…</span>') + '</p>' +
      deleteBanner +
      reason +
      (stale ? renderStaleWarning(p) : '') +
      changes +
      tech +
      actions +
      '</article>';
  }

  function renderCompactProposal(p) {
    var title = p.title || (p.displayName ? titleFromDisplayName(p.displayName) : 'Proposal');
    var flowLabel = flowLabelOf(p);
    return '<div class="proposal-card-compact" data-id="' + esc(p.id) +
      '" role="button" tabindex="0" aria-expanded="false">' +
      '<strong>' + esc(title) + '</strong>' +
      '<span class="status-pill ' + esc(p.status) + '">' + esc(p.status) + '</span>' +
      '<span class="proposal-meta-line">' +
      (flowLabel ? '<span class="proposal-flow">' + esc(flowLabel) + '</span> · ' : '') +
      timeCell(p.createdAt) +
      '</span>' +
      '</div>' +
      '<div class="proposal-detail" id="proposal-' + esc(p.id) + '" data-id="' + esc(p.id) +
      '" data-status="' + esc(p.status) + '" hidden></div>';
  }

  function renderProposalsList() {
    var list = $('proposals-list');
    if (!list) return;
    var filters = $('proposals-filters');
    var pending = cachedProposals.filter(function (p) { return p.status === 'pending'; });
    var decided = cachedProposals.filter(function (p) { return p.status !== 'pending'; });
    updatePendingBadges();
    if (filters) filters.hidden = cachedProposals.length === 0;
    var shown;
    if (proposalsFilter === 'pending') {
      // Live proposals first; out-of-date last.
      shown = pending.slice().sort(function (a, b) {
        var as = proposalIsStale(a) ? 1 : 0;
        var bs = proposalIsStale(b) ? 1 : 0;
        return as - bs;
      });
    } else {
      shown = decided;
    }
    if (!cachedProposals.length) {
      list.innerHTML = '<div class="empty-state"><p class="empty-title">No proposals yet</p>' +
        '<p class="muted">When an AI submits a change it will appear here for review.</p></div>';
      return;
    }
    if (!shown.length) {
      list.innerHTML = '<div class="empty-state"><p class="empty-title">No ' +
        esc(proposalsFilter) + ' proposals</p>' +
        '<p class="muted">Switch the filter above to see other proposals.</p></div>';
      return;
    }
    if (proposalsFilter === 'pending') {
      list.innerHTML = shown.map(renderProposalCard).join('');
      shown.forEach(function (p) { loadProposalDiff(p.id); });
    } else {
      list.innerHTML = shown.map(renderCompactProposal).join('');
    }
    bindProposalActions(list);
    focusProposalFromHash();
  }
`;
}

function pageClientScriptPartB2Focus(): string {
  return `
  async function loadProposals() {
    if (!aiOn) return;
    var flash = $('proposals-flash');
    showFlash(flash, '', true);
    try {
      var data = await api('/proposals');
      cachedProposals = (data && data.proposals) || [];
      renderProposalsList();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
    }
  }

  function readProposalHashId() {
    return readProposalHashIdFrom(location.hash || '');
  }

  /**
   * Deep-link focus: scroll/highlight once, then replace #proposal=<id> with
   * #proposals so reload / returning to the tab does not re-trigger.
   */
  function focusProposalFromHash() {
    var id = readProposalHashId();
    if (!id) return false;
    selectTab('proposals', { skipHash: true });
    var p = cachedProposals.filter(function (x) { return x.id === id; })[0];
    if (p && p.status !== 'pending' && proposalsFilter === 'pending') {
      proposalsFilter = 'decided';
      var filtersEl = $('proposals-filters');
      if (filtersEl) {
        filtersEl.querySelectorAll('.filter-chip').forEach(function (chip) {
          var f = chip.getAttribute('data-filter');
          chip.setAttribute('aria-pressed', f === 'decided' ? 'true' : 'false');
        });
      }
      renderProposalsList();
    }
    var el = document.getElementById('proposal-' + id) ||
      document.querySelector('.proposal-detail[data-id="' + id + '"]');
    if (!el) return false;
    if (el.hasAttribute('hidden') || !el.querySelector('.proposal-heading')) {
      if (p) {
        var wrap = document.createElement('div');
        wrap.innerHTML = renderProposalCard(p);
        var next = wrap.firstChild;
        el.parentNode.replaceChild(next, el);
        el = next;
        var compact = document.querySelector('.proposal-card-compact[data-id="' + id + '"]');
        if (compact) compact.setAttribute('aria-expanded', 'true');
        bindProposalActions($('proposals-list'));
        loadProposalDiff(id);
      }
    }
    clearProposalHighlight();
    el.classList.add('proposal-highlight');
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      el.scrollIntoView(true);
    }
    // Consume the deep link so it is not sticky across reloads/tab returns.
    replaceLocationHash('#proposals');
    return true;
  }
`;
}

function pageClientScriptPartB2Apply(): string {
  return `
  function bindDiffModeToggle(host, diff) {
    host.querySelectorAll('[data-diff-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mode = btn.getAttribute('data-diff-mode');
        if (mode !== 'split' && mode !== 'unified') return;
        setDiffMode(mode);
        host.innerHTML = renderDiffView(diff, mode);
        bindDiffModeToggle(host, diff);
        bindPresencePreviewToggles(host);
      });
    });
  }

  function applyDiffToProposalCard(id, diff) {
    proposalDiffCache[id] = diff;
    var p = cachedProposals.filter(function (x) { return x.id === id; })[0];
    if (p && typeof diff.baseRevStale === 'boolean') {
      p.baseRevStale = diff.baseRevStale;
    }
    var flowLabel = p ? flowLabelOf(p) : '';
    var plainEl = document.querySelector('.proposal-plain-summary[data-plain-for="' + id + '"]');
    if (plainEl) {
      var sentence = plainDiffSentence(diff, flowLabel);
      plainEl.textContent = sentence || 'No node changes';
    }
    var revEl = document.querySelector('.proposal-rev-meta[data-rev-for="' + id + '"]');
    if (revEl) {
      revEl.innerHTML = renderDiffRevMeta(diff) +
        (p ? ' · id ' + tipId(p.id, 12) : '');
    }
    var article = document.querySelector('.proposal-detail[data-id="' + id + '"]');
    if (!article) {
      updatePendingBadges();
      return;
    }
    var stale = !!(diff.baseRevStale);
    if (stale) article.setAttribute('data-stale', '1');
    else article.removeAttribute('data-stale');

    var existingBanner = article.querySelector('.delete-banner');
    if (isLargeDelete(diff) && !stale) {
      var beforeN = diff.summary.beforeNodeCount || 0;
      var removedN = diff.summary.removed || 0;
      var html = 'Deletes ' + removedN + ' of ' + beforeN + ' nodes';
      if (existingBanner) {
        existingBanner.textContent = html;
      } else {
        var plain = article.querySelector('.proposal-plain-summary');
        var banner = document.createElement('div');
        banner.className = 'delete-banner';
        banner.setAttribute('role', 'status');
        banner.textContent = html;
        if (plain && plain.parentNode) {
          plain.parentNode.insertBefore(banner, plain.nextSibling);
        }
      }
    } else if (existingBanner) {
      existingBanner.parentNode.removeChild(existingBanner);
    }

    // When stale becomes known after load, rebuild the card actions/warning.
    if (p && p.status === 'pending' && stale) {
      var existingWarn = article.querySelector('.stale-warning-row');
      if (!existingWarn) {
        var changesEl = article.querySelector('.proposal-changes');
        var warnWrap = document.createElement('div');
        warnWrap.innerHTML = renderStaleWarning(p);
        var warnNode = warnWrap.firstChild;
        if (changesEl && changesEl.parentNode) {
          changesEl.parentNode.insertBefore(warnNode, changesEl);
        } else {
          article.appendChild(warnNode);
        }
      }
      var help = article.querySelector('.approve-help');
      var row = article.querySelector('.approve-btn') &&
        article.querySelector('.approve-btn').closest('.row');
      var advanced = article.querySelector('.advanced-block');
      if (help && help.parentNode) help.parentNode.removeChild(help);
      if (row && row.parentNode) row.parentNode.removeChild(row);
      if (advanced && advanced.parentNode) advanced.parentNode.removeChild(advanced);
      bindProposalActions($('proposals-list') || article);
    }
    updatePendingBadges();
  }

  async function loadProposalDiff(id) {
    var host = document.querySelector('.proposal-diff[data-diff-for="' + id + '"]');
    if (!host) return;
    try {
      var diff = await api('/proposals/' + encodeURIComponent(id) + '/diff');
      applyDiffToProposalCard(id, diff);
      host.innerHTML = renderHumanDiff(diff);
      bindDiffModeToggle(host, diff);
      bindPresencePreviewToggles(host);
    } catch (e) {
      host.innerHTML = '<p class="muted">Could not load changes: ' +
        esc(e.message || String(e)) + '</p>';
    }
  }`;
}

function pageClientScriptPartC(): string {
  return `

  function openRejectDialog(id) {
    pendingRejectId = id;
    var dialog = $('reject-dialog');
    var input = $('reject-reason-input');
    if (input) input.value = '';
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      var reason = window.prompt('Reject reason (optional; the AI will see it):', '') || '';
      rejectProposal(id, reason.trim() || 'Rejected by admin');
    }
  }

  function openDeleteConfirmDialog(id, deploymentType, diff) {
    pendingApproveCtx = { id: id, deploymentType: deploymentType };
    var dialog = $('delete-confirm-dialog');
    var msg = $('delete-confirm-msg');
    var input = $('delete-confirm-input');
    var btn = $('delete-confirm-btn');
    var beforeN = (diff && diff.summary && diff.summary.beforeNodeCount) || 0;
    var removedN = (diff && diff.summary && diff.summary.removed) || 0;
    if (msg) {
      msg.textContent = 'This proposal deletes ' + removedN + ' of ' + beforeN +
        ' nodes. Type DELETE to confirm approve & deploy.';
    }
    if (input) input.value = '';
    if (btn) btn.disabled = true;
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else if (window.confirm('Delete ' + removedN + ' of ' + beforeN + ' nodes? Continue?')) {
      doApproveProposal(id, deploymentType);
    }
  }

  async function doApproveProposal(id, deploymentType) {
    var flash = $('proposals-flash');
    try {
      var result = await api('/proposals/' + encodeURIComponent(id) + '/approve', {
        method: 'POST',
        body: JSON.stringify({ deploymentType: deploymentType })
      });
      if (result.status === 'rejected') {
        var rejectMsg = friendlyReason(result.reason) || 'Proposal rejected (revision conflict).';
        showFlash(flash, rejectMsg, false);
        showToast(rejectMsg, false);
      } else if (result.status === 'failed') {
        var failMsg = friendlyReason(result.reason) || 'Proposal failed.';
        showFlash(flash, failMsg, false);
        showToast(failMsg, false);
      } else {
        showFlash(flash, 'Proposal approved & deployed' +
          (result.resultRev ? ' (' + result.resultRev + ')' : '') + '.', true);
        showToast('Proposal approved & deployed.', true);
      }
      delete proposalDiffCache[id];
      loadProposals();
      loadLogs();
    } catch (e) {
      var errMsg = friendlyReason(e.message) || String(e);
      showFlash(flash, errMsg, false);
      showToast(errMsg, false);
    }
  }

  async function approveProposal(id) {
    var select = document.querySelector('select.deploy-type[data-id="' + id + '"]');
    var deploymentType = select ? select.value : defaultDeploy;
    var diff = proposalDiffCache[id];
    if (diff && diff.baseRevStale) {
      showToast('This proposal is out of date. Ask the AI to resubmit.', false);
      return;
    }
    if (isLargeDelete(diff)) {
      openDeleteConfirmDialog(id, deploymentType, diff);
      return;
    }
    doApproveProposal(id, deploymentType);
  }

  async function rejectProposal(id, reasonOverride, options) {
    var flash = $('proposals-flash');
    var reason = reasonOverride && String(reasonOverride).trim()
      ? String(reasonOverride).trim()
      : 'Rejected by admin';
    var silent = options && options.silent;
    var dismissed = /^Dismissed/i.test(reason);
    try {
      await api('/proposals/' + encodeURIComponent(id) + '/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: reason })
      });
      delete proposalDiffCache[id];
      if (!silent) {
        var okMsg = dismissed ? 'Proposal dismissed.' : 'Proposal rejected.';
        showFlash(flash, okMsg, true);
        showToast(okMsg, true);
        loadProposals();
        loadLogs();
      }
    } catch (e) {
      if (!silent) {
        showFlash(flash, e.message || String(e), false);
        showToast(e.message || String(e), false);
      }
      throw e;
    }
  }
`;
}

function pageClientScriptPartCLogs(): string {
  return `
  var cachedLogs = [];

  function renderLogsTable(logs) {
    var list = $('logs-list');
    var showRaw = !!( $('logs-debug') && $('logs-debug').checked );
    if (!logs.length) {
      list.innerHTML = '<div class="empty-state"><p class="empty-title">No matching audit entries</p>' +
        '<p class="muted">Try another filter, or wait for proposal activity.</p></div>';
      return;
    }
    list.innerHTML = '<table class="audit-table"><thead><tr>' +
      '<th class="col-when">When</th><th class="col-action">Action</th>' +
      '<th class="col-actor">Actor</th><th class="col-details">Details</th></tr></thead><tbody>' +
      logs.map(function (e) {
        var raw = esc(JSON.stringify(e.details || {}, null, 2));
        return '<tr>' +
          '<td class="col-when">' + timeCell(e.at) + '</td>' +
          '<td class="col-action">' + actionBadge(e.action) + '</td>' +
          '<td class="col-actor" title="' + esc(actorPlain(e.actor)) + '">' + actorLabel(e.actor) + '</td>' +
          '<td class="col-details"><div class="audit-summary">' + auditSummary(e) + '</div>' +
          (showRaw
            ? '<details class="audit-raw"><summary>raw</summary><pre>' + raw + '</pre></details>'
            : '') +
          '</td></tr>';
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
        filter.innerHTML = '<option value="">All activity</option>' +
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

    var dashAi = $('dash-ai');
    if (dashAi) dashAi.textContent = s.aiFeaturesEnabled ? 'On' : 'Off';
    var dashTtl = $('dash-ttl');
    if (dashTtl) dashTtl.textContent = hoursLabel(s.defaultLinkTtlSeconds || defaultTtl);

    $('status-version').textContent = s.version;
    $('status-adminauth').textContent = s.adminAuthEnabled ? 'enabled' : 'disabled';
    $('status-aifeatures').textContent = s.aiFeaturesEnabled ? 'enabled' : 'disabled';
    $('status-permission').textContent = s.permission || 'none (access-link or anonymous)';
    $('status-caller').textContent = s.caller
      ? (s.caller.kind + (s.caller.linkId ? ':' + s.caller.linkId : '') + (s.caller.permission ? ':' + s.caller.permission : ''))
      : '—';
    $('status-storage').textContent = s.storageDir;
    $('status-ttl').textContent = hoursLabel(s.defaultLinkTtlSeconds || defaultTtl);
    $('status-maxlinks').textContent = String(s.maxActiveLinks);
    $('status-deploy').textContent = s.defaultDeploymentType;
    var modeLabel = s.permission === '*' ? 'full access' : s.permission === 'read' ? 'read-only' : 'limited';
    $('status-badge').textContent = modeLabel;

    var blurb = $('permissions-blurb');
    if (blurb) {
      if (!s.aiFeaturesEnabled) {
        blurb.textContent = 'AI Access is turned off. Enable it in the editor sidebar to create links and review proposals.';
      } else if (canManage && canApprove) {
        blurb.textContent = "You're an admin: you can create access links and approve or reject proposals.";
      } else if (canManage) {
        blurb.textContent = "You're an admin for links: you can manage access links. Approving proposals needs full admin permission (*).";
      } else {
        blurb.textContent = "You're viewing read-only. Full admin permission (*) is required to manage links or approve proposals.";
      }
    }

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
      ? 'Review changes from your AI assistant. Approve & deploy makes them live; reject leaves the flow unchanged.'
      : 'Approve and reject require full admin permission (*). You can still review proposals.';

    renderLinksManage();
  }

  function setupStickyNav() {
    var nav = $('main-nav');
    if (!nav) return;
    function updateStuck() {
      var top = nav.getBoundingClientRect().top;
      nav.classList.toggle('is-stuck', top <= 0);
    }
    window.addEventListener('scroll', updateStuck, { passive: true });
    updateStuck();
  }

  function setupDialogs() {
    var rejectForm = $('reject-form');
    if (rejectForm) {
      rejectForm.addEventListener('submit', function (ev) {
        var submitter = ev.submitter || document.activeElement;
        var value = submitter && submitter.value ? submitter.value : '';
        if (value === 'reject' && pendingRejectId) {
          var input = $('reject-reason-input');
          var reason = input && input.value.trim() ? input.value.trim() : 'Rejected by admin';
          rejectProposal(pendingRejectId, reason);
        }
        pendingRejectId = null;
      });
    }
    var deleteForm = $('delete-confirm-form');
    var deleteInput = $('delete-confirm-input');
    var deleteBtn = $('delete-confirm-btn');
    if (deleteInput && deleteBtn) {
      deleteInput.addEventListener('input', function () {
        deleteBtn.disabled = deleteInput.value !== 'DELETE';
      });
    }
    if (deleteForm) {
      deleteForm.addEventListener('submit', function (ev) {
        var submitter = ev.submitter || document.activeElement;
        var value = submitter && submitter.value ? submitter.value : '';
        if (value === 'confirm' && pendingApproveCtx && deleteInput && deleteInput.value === 'DELETE') {
          doApproveProposal(pendingApproveCtx.id, pendingApproveCtx.deploymentType);
        }
        pendingApproveCtx = null;
      });
    }
  }
`;
}

function pageClientScriptPartDBoot(): string {
  return `
  async function boot() {
    accessToken = readEditorToken();
    if (!accessToken) {
      showAuthGate();
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
      setupStickyNav();
      // Restore tab from hash (or default #status); keep #proposal=<id> until focus consumes it.
      var initialTab = initialTabFromHash(location.hash || '');
      selectTab(initialTab, { skipHash: !!readProposalHashId() });
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
        if (aiOn) {
          if (canManage) loadLinks();
          loadProposals();
        }
      } catch (e) {
        showFlash($('status-flash'), e.message || String(e), false);
      }
    });
  }

  var logsFilter = $('logs-filter');
  if (logsFilter) {
    logsFilter.addEventListener('change', applyLogFilter);
  }
  var logsDebug = $('logs-debug');
  if (logsDebug) {
    logsDebug.addEventListener('change', applyLogFilter);
  }

  var filters = $('proposals-filters');
  if (filters) {
    filters.querySelectorAll('.filter-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        setProposalsFilter(chip.getAttribute('data-filter'));
      });
    });
  }

  var dismissAllBtn = $('dismiss-all-stale');
  if (dismissAllBtn) {
    dismissAllBtn.addEventListener('click', async function () {
      var staleIds = cachedProposals
        .filter(function (p) { return p.status === 'pending' && proposalIsStale(p); })
        .map(function (p) { return p.id; });
      if (!staleIds.length) return;
      if (!window.confirm('Dismiss ' + staleIds.length +
        ' out-of-date proposal' + (staleIds.length === 1 ? '' : 's') + '?')) {
        return;
      }
      var flash = $('proposals-flash');
      var failed = 0;
      for (var i = 0; i < staleIds.length; i += 1) {
        try {
          await rejectProposal(staleIds[i], 'Dismissed — ask the AI to resubmit', { silent: true });
        } catch (e) {
          failed += 1;
        }
      }
      if (failed) {
        showFlash(flash, 'Dismissed with ' + failed + ' error(s).', false);
      } else {
        showFlash(flash, 'Dismissed ' + staleIds.length + ' out-of-date proposal' +
          (staleIds.length === 1 ? '' : 's') + '.', true);
        showToast('Out-of-date proposals dismissed.', true);
      }
      loadProposals();
      loadLogs();
    });
  }

  var dashPendingCard = $('dash-pending-card');
  if (dashPendingCard) {
    function goPending() {
      setProposalsFilter('pending');
      selectTab('proposals');
      loadTabData('proposals');
    }
    dashPendingCard.addEventListener('click', goPending);
    dashPendingCard.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        goPending();
      }
    });
  }

  setupDialogs();

  window.addEventListener('hashchange', function () {
    var proposalId = readProposalHashId();
    if (proposalId) {
      selectTab('proposals', { skipHash: true });
      loadTabData('proposals');
      return;
    }
    var tab = tabFromHash(location.hash) || 'status';
    selectTab(tab, { skipHash: true });
    loadTabData(tab);
  });

  boot();
})();
`;
}

export function pageClientScript(): string {
  return (
    pageClientScriptPartA() +
    pageClientScriptPartATimeCopy() +
    pageClientScriptPartAFormat() +
    pageClientScriptPartAAudit() +
    pageClientScriptPartATabs() +
    pageClientScriptPartA2() +
    pageClientScriptPartB() +
    pageClientScriptPartBDiff() +
    pageClientScriptPartBDiffPresence() +
    pageClientScriptPartBDiffView() +
    pageClientScriptPartBDiffView2() +
    pageClientScriptPartB2() +
    pageClientScriptPartB2Cards() +
    pageClientScriptPartB2Focus() +
    pageClientScriptPartB2Apply() +
    pageClientScriptPartC() +
    pageClientScriptPartCLogs() +
    pageClientScriptPartD() +
    pageClientScriptPartDBoot()
  ).trim();
}
