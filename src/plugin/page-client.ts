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
  var proposalsSearchQuery = '';
  var cachedProposals = [];
  var proposalDiffCache = {};
  var cachedLinksById = {};
  var cachedFlowLabels = {};
  var pendingRejectId = null;
  var pendingApproveCtx = null;
  var pendingConfirmAction = null;

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

  /**
   * Toast with optional proposal name + deep-link.
   * opts: { title?, href?, linkLabel?, durationMs? }
   */
  function showToast(message, ok, opts) {
    var host = $('toast-host');
    if (!host || (!message && !(opts && opts.title))) return;
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'toast ' + (ok ? 'ok' : 'error');
    if (opts.title) {
      var titleEl = document.createElement('span');
      titleEl.className = 'toast-title';
      titleEl.textContent = String(opts.title);
      el.appendChild(titleEl);
    }
    var body = document.createElement('span');
    body.className = 'toast-body';
    body.textContent = message || '';
    if (opts.href) {
      var link = document.createElement('a');
      link.className = 'toast-link';
      link.href = opts.href;
      link.textContent = opts.linkLabel || 'View';
      link.addEventListener('click', function (ev) {
        // Stay in-app: set hash so focusProposalFromHash can run.
        if (opts.href.indexOf('#proposal=') >= 0) {
          ev.preventDefault();
          location.hash = opts.href.replace(/^[^#]*/, '');
          focusProposalFromHash();
        }
      });
      body.appendChild(document.createTextNode(' '));
      body.appendChild(link);
    }
    el.appendChild(body);
    host.appendChild(el);
    var ms = opts.durationMs || 4800;
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, ms);
  }

  function proposalToastTitle(p) {
    if (!p) return '';
    return titleForProposalCard(p) || p.title || 'Proposal';
  }

  function proposalViewHref(id) {
    return '#proposal=' + encodeURIComponent(String(id || ''));
  }

  /** Notify the editor AI Access sidebar (if open) to refresh pending counts. */
  function notifySidebarPendingRefresh() {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        var ch = new BroadcastChannel('ai-access-pending');
        ch.postMessage({ type: 'refresh-pending' });
        ch.close();
      }
    } catch (e) { /* ignore */ }
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
    var labels = {
      wires: 'Connects to',
      func: 'Function code',
      template: 'HTML template',
      name: 'Name',
      topic: 'Topic',
      payload: 'Payload',
      complete: 'Complete',
      info: 'Info',
      format: 'Format',
      syntax: 'Syntax',
      outputs: 'Outputs',
      x: 'X',
      y: 'Y'
    };
    return labels[key] || key;
  }

  function fieldLabelHtml(key) {
    var friendly = fieldLabel(key);
    return '<strong title="' + esc(key) + '">' + esc(friendly) + '</strong>';
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
  /**
   * Visible proposal short id: first 8 hex chars after the prop- prefix
   * (e.g. prop-efd159aa… → efd159aa) so it matches the real id by eye.
   */
  function proposalShortId(value, keep) {
    var s = String(value == null ? '' : value);
    var n = keep || 8;
    if (!s) return '';
    var body = s.indexOf('prop-') === 0 ? s.slice(5) : s;
    var m = /^([0-9a-fA-F]+)/.exec(body);
    var hex = m ? m[1] : body;
    if (hex.length <= n) return hex;
    return hex.slice(0, n);
  }
  /** Copy-on-click chip; shows proposalShortId, copies the full id. */
  function proposalIdChip(id) {
    var s = String(id == null ? '' : id);
    if (!s) return '';
    return '<button type="button" class="id-copy" data-copy-id="' + esc(s) +
      '" title="' + esc(s) + ' — click to copy">' +
      '<code class="id-short">' + esc(proposalShortId(s, 8)) + '</code></button>';
  }
  function actorPlain(actor) {
    actor = actor || {};
    if (actor.kind === 'access-link') {
      // Full hover text; short cell text is actorLabel ("AI (label)").
      if (actor.label) {
        return 'AI (' + String(actor.label) + ')' +
          (actor.linkId ? ' · link ' + String(actor.linkId) : '');
      }
      return actor.linkId ? 'AI · link ' + String(actor.linkId) : 'AI';
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
      // Short cell text; full wording stays on the title/hover via actorPlain.
      if (actor.label) {
        return 'AI (' + esc(actor.label) + ')';
      }
      return 'AI';
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
      'proposal.withdrawn': 'Withdrawn',
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
      'proposal.withdrawn': 'Withdrawn',
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
    if (/expectedRev is stale|Flow revision conflict|revision conflict.*stale|rev is stale/i.test(s)) {
      return 'Out of date — the flow changed since this was submitted. Ask the AI to resubmit.';
    }
    return s;
  }

  function formatTtlLabel(seconds) {
    var s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0) return '';
    if (s < 3600) {
      var mins = Math.max(1, Math.round(s / 60));
      return mins === 1 ? '1 minute' : mins + ' minutes';
    }
    var hours = Math.round(s / 3600);
    if (hours < 48) return hours === 1 ? '1 hour' : hours + ' hours';
    var days = Math.round(hours / 24);
    return days === 1 ? '1 day' : days + ' days';
  }

  function linkTtlFromDetails(d) {
    if (d.ttlSeconds != null) return formatTtlLabel(d.ttlSeconds);
    if (d.expiresAt && d.createdAt) {
      var ms = new Date(d.expiresAt).getTime() - new Date(d.createdAt).getTime();
      if (Number.isFinite(ms) && ms > 0) return formatTtlLabel(ms / 1000);
    }
    return '';
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
    // Same render-time title as the Proposals page when the proposal is cached.
    var p = lookupCachedProposal(d.proposalId);
    var title = '';
    if (p) {
      title = displayTitleForProposal(p, proposalDiffCache[p.id]);
    }
    if (!title) {
      title = d.title ||
        (d.displayName ? titleFromDisplayName(d.displayName) : '') ||
        (p && p.displayName ? titleFromDisplayName(p.displayName) : '') ||
        (p && p.title) ||
        '';
    }
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
    if (d.flowId && cachedFlowLabels[d.flowId]) {
      return String(cachedFlowLabels[d.flowId]);
    }
    // Never show raw flow ids like tab1 in the audit summary.
    return '';
  }
  function resolveLinkDetails(d) {
    var out = {
      label: d.label,
      expiresAt: d.expiresAt,
      createdAt: d.createdAt,
      ttlSeconds: d.ttlSeconds,
      linkId: d.linkId
    };
    if ((!out.label || !out.expiresAt) && out.linkId && cachedLinksById[out.linkId]) {
      var link = cachedLinksById[out.linkId];
      if (!out.label && link.label) out.label = link.label;
      if (!out.expiresAt && link.expiresAt) out.expiresAt = link.expiresAt;
      if (!out.createdAt && link.createdAt) out.createdAt = link.createdAt;
    }
    return out;
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
      // Deploy rev stays in raw details only — keep the summary human.
      return 'Approved' + (prop ? ' ' + prop : '') +
        (flow ? ' for flow "' + flow + '"' : '');
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
    if (action === 'proposal.withdrawn') {
      var withdrawReason = friendlyReason(d.reason);
      return 'Withdrawn' + (prop ? ' ' + prop : '') +
        (withdrawReason ? ': ' + esc(withdrawReason) : '');
    }
    if (action === 'link.created') {
      var created = resolveLinkDetails(d);
      var createdTtl = linkTtlFromDetails(created);
      return 'Access link created' +
        (created.label ? ' "' + esc(String(created.label)) + '"' : '') +
        (createdTtl ? ' · TTL ' + esc(createdTtl) : '') +
        (created.expiresAt ? ' · expires ' + timeCell(created.expiresAt) : '');
    }
    if (action === 'link.revoked') {
      var revoked = resolveLinkDetails(d);
      var revokedTtl = linkTtlFromDetails(revoked);
      return 'Access link revoked' +
        (revoked.label ? ' "' + esc(String(revoked.label)) + '"' : '') +
        (revokedTtl ? ' · TTL ' + esc(revokedTtl) : '') +
        (revoked.expiresAt ? ' · was set to expire ' + timeCell(revoked.expiresAt) : '');
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

  var TTL_PRESET_15M = 15 * 60;
  var TTL_PRESET_1H = 60 * 60;
  var TTL_PRESET_4H = 4 * 60 * 60;
  var TTL_PRESET_24H = 24 * 60 * 60;
  var TTL_PRESET_7D = 7 * 24 * 60 * 60;
  var TTL_MAX_GET_LINK = TTL_PRESET_24H;
  var TTL_MAX_REST_MCP = 30 * 24 * 60 * 60;
  var TTL_WARN_SECONDS = TTL_PRESET_24H;

  function linkKindSelected() {
    var kindSelect = $('link-kind');
    return normalizeLinkKind(kindSelect && kindSelect.value);
  }

  function maxTtlForKind(kind) {
    return kind === 'get_link' ? TTL_MAX_GET_LINK : TTL_MAX_REST_MCP;
  }

  function customTtlSecondsFromInputs() {
    var amountEl = $('link-ttl-custom-amount');
    var unitEl = $('link-ttl-custom-unit');
    var amount = amountEl ? Number(amountEl.value) : NaN;
    var unit = unitEl ? String(unitEl.value || 'hours') : 'hours';
    if (!Number.isFinite(amount) || amount <= 0) return null;
    var mult = unit === 'days' ? 86400 : (unit === 'minutes' ? 60 : 3600);
    return Math.floor(amount * mult);
  }

  function selectedTtlSeconds() {
    var sel = $('link-ttl-preset');
    var value = sel ? String(sel.value || '') : '3600';
    if (value === 'custom') {
      var custom = customTtlSecondsFromInputs();
      if (custom === null) return TTL_PRESET_1H;
      return custom;
    }
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return TTL_PRESET_1H;
    return Math.floor(n);
  }

  function applyTtlPresetValue(seconds) {
    var sel = $('link-ttl-preset');
    if (!sel) return;
    var asStr = String(seconds);
    var opt = sel.querySelector('option[value="' + asStr + '"]');
    if (opt && !opt.disabled && !opt.hidden) {
      sel.value = asStr;
      return;
    }
    sel.value = 'custom';
    var amountEl = $('link-ttl-custom-amount');
    var unitEl = $('link-ttl-custom-unit');
    if (seconds % 86400 === 0) {
      if (amountEl) amountEl.value = String(seconds / 86400);
      if (unitEl) unitEl.value = 'days';
    } else if (seconds % 3600 === 0) {
      if (amountEl) amountEl.value = String(seconds / 3600);
      if (unitEl) unitEl.value = 'hours';
    } else {
      if (amountEl) amountEl.value = String(Math.max(1, Math.round(seconds / 60)));
      if (unitEl) unitEl.value = 'minutes';
    }
  }

  function updateTtlUiState(opts) {
    opts = opts || {};
    var kind = linkKindSelected();
    var maxTtl = maxTtlForKind(kind);
    var sel = $('link-ttl-preset');
    var customRow = $('link-ttl-custom-row');
    var warn = $('link-ttl-warn');
    var resetNote = $('link-ttl-reset-note');
    var sevenDay = sel && sel.querySelector('option[value="' + TTL_PRESET_7D + '"]');
    if (sevenDay) {
      sevenDay.hidden = kind === 'get_link';
      sevenDay.disabled = kind === 'get_link';
    }
    // If 7d was selected then kind switched to get_link, move off the hidden option.
    if (kind === 'get_link' && sel && sel.value === String(TTL_PRESET_7D)) {
      applyTtlPresetValue(TTL_PRESET_1H);
      if (resetNote) {
        resetNote.hidden = false;
        resetNote.textContent = 'Expiry reset to 1 hour (GET links are capped at 24 hours).';
      }
      opts.keepResetNote = true;
    }
    if (customRow) {
      customRow.hidden = !(sel && sel.value === 'custom');
    }
    var seconds = selectedTtlSeconds();
    if (kind === 'get_link' && seconds > TTL_MAX_GET_LINK) {
      applyTtlPresetValue(TTL_PRESET_1H);
      seconds = TTL_PRESET_1H;
      if (customRow) customRow.hidden = true;
      if (resetNote) {
        resetNote.hidden = false;
        resetNote.textContent = 'Expiry reset to 1 hour (GET links are capped at 24 hours).';
      }
      opts.keepResetNote = true;
    } else if (resetNote && !opts.keepResetNote) {
      resetNote.hidden = true;
      resetNote.textContent = '';
    }
    if (seconds > maxTtl) {
      applyTtlPresetValue(maxTtl);
      seconds = maxTtl;
      if (customRow) customRow.hidden = !(sel && sel.value === 'custom');
    }
    if (warn) {
      var showWarn = kind !== 'get_link' && seconds > TTL_WARN_SECONDS;
      warn.hidden = !showWarn;
    }
  }

  function wireTtlControls() {
    var sel = $('link-ttl-preset');
    var kindSelect = $('link-kind');
    var amountEl = $('link-ttl-custom-amount');
    var unitEl = $('link-ttl-custom-unit');
    if (sel) sel.addEventListener('change', function () { updateTtlUiState(); });
    if (amountEl) amountEl.addEventListener('input', function () { updateTtlUiState({ keepResetNote: true }); });
    if (unitEl) unitEl.addEventListener('change', function () { updateTtlUiState({ keepResetNote: true }); });
    if (kindSelect) {
      kindSelect.addEventListener('change', function () {
        updateTtlUiState();
      });
    }
    updateTtlUiState();
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
    host.innerHTML =
      '<form id="create-link-form">' +
      '<div class="row" style="align-items:flex-end">' +
      '<label>Channel<select id="link-kind" aria-label="Token channel">' +
      '<option value="get_link" selected>GET link (chat paste)</option>' +
      '<option value="rest">REST Bearer</option>' +
      '<option value="mcp">MCP token</option>' +
      '</select></label>' +
      '<label>Expires after<select id="link-ttl-preset" aria-label="Expires after">' +
      '<option value="' + TTL_PRESET_15M + '">15 minutes</option>' +
      '<option value="' + TTL_PRESET_1H + '" selected>1 hour</option>' +
      '<option value="' + TTL_PRESET_4H + '">4 hours</option>' +
      '<option value="' + TTL_PRESET_24H + '">24 hours</option>' +
      '<option value="' + TTL_PRESET_7D + '">7 days</option>' +
      '<option value="custom">Custom</option>' +
      '</select></label>' +
      '<div id="link-ttl-custom-row" class="ttl-custom-row" hidden>' +
      '<label>Custom<input id="link-ttl-custom-amount" type="number" min="1" step="1" value="1" aria-label="Custom duration amount" /></label>' +
      '<label><span class="visually-hidden">Unit</span><select id="link-ttl-custom-unit" aria-label="Custom duration unit">' +
      '<option value="minutes">minutes</option>' +
      '<option value="hours" selected>hours</option>' +
      '<option value="days">days</option>' +
      '</select></label></div>' +
      '<label>Label (optional)<input id="link-label" type="text" maxlength="120" placeholder="e.g. Claude session" /></label>' +
      '<button type="submit" class="action">Create access token</button></div>' +
      '<p id="link-ttl-reset-note" class="ttl-reset-note" hidden></p>' +
      '<p id="link-ttl-warn" class="ttl-long-warn" hidden role="alert">' +
      'Long-lived tokens stay usable longer if they leak. Prefer the shortest expiry that works.' +
      '</p></form>' +
      '<div id="token-once" class="token-once" hidden>' +
      '<p id="token-kind-label" class="token-kind-label" hidden></p>' +
      '<p id="token-docs-hint" class="muted"></p>' +
      '<button type="button" class="action copy-ai-primary" id="token-copy-btn">Copy GET link for AI chat</button>' +
      '<div id="mcp-setup-panel" class="mcp-setup-panel" hidden>' +
      '<p class="muted mcp-setup-fallback">If your AI app cannot add MCP servers, create a REST or GET link instead.</p>' +
      '<div class="mcp-setup-tabs" role="tablist" aria-label="MCP client setup" id="mcp-setup-tabs"></div>' +
      '<div id="mcp-setup-body" class="mcp-setup-body"></div>' +
      '</div>' +
      '<details class="advanced-block" id="token-dev-details">' +
      '<summary>For developers</summary>' +
      '<p id="token-dev-blurb" class="muted">Details reusable while this token is active — also available via Copy in the table.</p>' +
      '<code id="token-value"></code>' +
      '<pre id="token-copy-block" class="token-copy-block"></pre>' +
      '</details></div>';
    wireTtlControls();
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
      links.forEach(function (l) {
        if (l && l.id) cachedLinksById[l.id] = l;
      });
      var dashLinks = $('dash-links');
      if (dashLinks) dashLinks.textContent = String(links.length);
      if (!links.length) {
        list.innerHTML = '<div class="empty-state"><p class="empty-title">No active access links</p>' +
          '<p class="muted">Create a link above to give an AI temporary access to read flows and submit proposals.</p></div>';
        return;
      }
      list.innerHTML = '<table class="links-table"><thead><tr>' +
        '<th>Created</th><th>Kind</th><th>Last used</th><th>Label</th><th>Expires</th><th></th>' +
        '</tr></thead><tbody>' +
        links.map(function (l) {
          var kind = normalizeLinkKind(l.kind);
          var material = linkCopyMaterial(kind, l.token || '', l.url || '');
          var hasCopy = !!(material && material.primary);
          var copyDisabled = hasCopy ? '' : ' disabled title="Copy unavailable — create a new token"';
          var copyLabel = kind === 'get_link'
            ? 'Copy GET link'
            : (kind === 'rest' ? 'Copy REST prompt' : 'Copy MCP Bearer');
          return '<tr data-id="' + esc(l.id) + '" data-kind="' + esc(kind) + '">' +
            '<td>' + timeCell(l.createdAt) + '</td>' +
            '<td>' + kindBadgeHtml(kind) + '</td>' +
            '<td>' + timeCell(l.lastUsedAt) + '</td>' +
            '<td>' + esc(l.label || '—') + '</td>' +
            '<td>' + timeCell(l.expiresAt) + '</td>' +
            '<td class="row-actions">' +
            '<button type="button" class="action secondary copy-link" data-id="' + esc(l.id) + '"' +
            ' data-kind="' + esc(kind) + '"' +
            ' data-token="' + esc(l.token || '') + '"' +
            ' data-url="' + esc(l.url || '') + '"' +
            ' data-label="' + esc(copyLabel) + '"' +
            copyDisabled + '>' + esc(copyLabel) + '</button> ' +
            '<button type="button" class="action danger revoke-link" data-id="' + esc(l.id) + '">Revoke</button>' +
            '</td></tr>';
        }).join('') + '</tbody></table>';
      list.querySelectorAll('.copy-link').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var kind = normalizeLinkKind(btn.getAttribute('data-kind'));
          var material = linkCopyMaterial(
            kind,
            btn.getAttribute('data-token') || '',
            btn.getAttribute('data-url') || ''
          );
          var text = material.primary || '';
          if (!text) {
            showFlash(flash, 'Clipboard unavailable — create a new token to copy.', false);
            return;
          }
          var okMsg = material.copiedOk || 'Copied.';
          copyTextToClipboard(text).then(function () {
            markCopied(btn, flash, okMsg);
            showToast(okMsg, true);
          }).catch(function () {
            showFlash(flash, 'Clipboard unavailable — create a new token and copy from the flash block.', false);
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

  function revokeLink(id) {
    openConfirmDialog({
      title: 'Revoke access link',
      message: 'The AI will lose access immediately.',
      confirmLabel: 'Revoke',
      danger: true,
      onConfirm: function () { doRevokeLink(id); }
    });
  }

  async function doRevokeLink(id) {
    var flash = $('links-flash');
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

  function normalizeLinkKind(kind) {
    if (kind === 'rest' || kind === 'mcp' || kind === 'get_link') return kind;
    return 'get_link';
  }

  function kindBadgeHtml(kind) {
    var k = normalizeLinkKind(kind);
    var labels = {
      get_link: 'GET link',
      rest: 'REST Bearer',
      mcp: 'MCP token'
    };
    return '<span class="kind-badge kind-' + esc(k) + '" title="Token kind: ' + esc(k) + '">' +
      esc(labels[k] || k) + '</span>';
  }

  /**
   * Clipboard + flash text per token kind. get_link never suggests using the
   * path token as REST/MCP Bearer (those need separate rest/mcp tokens).
   */
  function restPromptForAi(token, base) {
    var tok = String(token || '');
    var auth = tok ? ('Authorization: Bearer ' + tok) : 'Authorization: Bearer <token>';
    return [
      'You have temporary Node-RED AI Access via REST.',
      '',
      'Base URL: ' + base,
      auth,
      '',
      'OpenAPI: ' + base + '/openapi.yaml',
      'Discovery guide: ' + base,
      '',
      'You may read flows and submit proposals. A human owner must approve every change before it is deployed.',
      '',
      'If you cannot send HTTP requests with custom headers (e.g. a web chat app), stop and ask the user to create a GET link instead; do not retry.'
    ].join('\\n');
  }

  function mcpSetupSnippets(token, rpcUrl) {
    var tok = String(token || 'aia_…');
    var authLine = 'Authorization: Bearer ' + tok;
    var claudeDesktop = JSON.stringify({
      mcpServers: {
        'node-red-ai-access': {
          url: rpcUrl,
          headers: { Authorization: 'Bearer ' + tok }
        }
      }
    }, null, 2);
    var cursorJson = JSON.stringify({
      mcpServers: {
        'node-red-ai-access': {
          url: rpcUrl,
          headers: { Authorization: 'Bearer ' + tok }
        }
      }
    }, null, 2);
    var vscodeJson = JSON.stringify({
      servers: {
        'node-red-ai-access': {
          type: 'http',
          url: rpcUrl,
          headers: { Authorization: 'Bearer ' + tok }
        }
      }
    }, null, 2);
    var claudeCli =
      'claude mcp add --transport http node-red-ai-access ' + rpcUrl +
      ' --header "Authorization: Bearer ' + tok + '"';
    var generic = [
      'MCP Streamable HTTP',
      'URL: ' + rpcUrl,
      authLine,
      '',
      'Send JSON-RPC over POST with Accept: application/json, text/event-stream.'
    ].join('\\n');
    return {
      'claude-desktop': { title: 'Claude Desktop', label: 'Copy Claude Desktop JSON', text: claudeDesktop },
      cursor: { title: 'Cursor', label: 'Copy Cursor mcp.json', text: cursorJson },
      vscode: { title: 'VS Code', label: 'Copy VS Code MCP JSON', text: vscodeJson },
      'claude-cli': { title: 'Claude Code CLI', label: 'Copy Claude Code CLI command', text: claudeCli },
      generic: { title: 'Streamable HTTP', label: 'Copy Streamable HTTP details', text: generic }
    };
  }

  function linkCopyMaterial(kind, token, url) {
    var origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    var base = origin + apiBase;
    var rpc = origin + mcpRpc;
    var k = normalizeLinkKind(kind);
    var tok = String(token || '');
    if (k === 'rest') {
      var restPrompt = tok ? restPromptForAi(tok, base) : '';
      return {
        kind: 'rest',
        label: 'REST prompt for AI',
        buttonLabel: 'Copy REST prompt for AI',
        primary: restPrompt,
        hint: 'Paste this prompt into your AI. It includes the REST base URL, Bearer token, OpenAPI, and discovery guide. This is a rest token — not a chat GET link and not for /mcp/rpc.',
        flashOk: 'REST token created — copy the prompt for your AI.',
        copiedOk: 'Copied REST prompt for AI.',
        block: restPrompt || ('REST Bearer (kind=rest)\\nAuthorization: Bearer <token>\\nBase: ' + base),
        tokenDisplay: tok,
        showDev: true
      };
    }
    if (k === 'mcp') {
      var mcpPrimary = tok ? ('Authorization: Bearer ' + tok) : '';
      var snippets = mcpSetupSnippets(tok, rpc);
      var mcpSnippet = [
        'MCP token for /mcp/rpc (kind=mcp)',
        mcpPrimary,
        'POST ' + rpc,
        '',
        'Use the setup tabs above for client-specific config.',
        '',
        'If your AI app cannot add MCP servers, create a REST or GET link instead.'
      ].join('\\n');
      return {
        kind: 'mcp',
        label: 'MCP setup for /mcp/rpc',
        buttonLabel: 'Copy MCP Bearer header',
        primary: mcpPrimary,
        hint: 'Configure your MCP client with the tabs below (real host + token). This mcp token works only on POST /mcp/rpc — not as a chat GET link and not for REST.',
        flashOk: 'MCP token created — use a setup tab to copy client config.',
        copiedOk: 'Copied MCP Bearer header.',
        block: mcpSnippet,
        tokenDisplay: tok,
        showDev: true,
        mcpSnippets: snippets
      };
    }
    var getLink = url || (tok
      ? (origin + (apiBase.replace(/\\/mcp\\/api\\/v1\\/?$/, '/mcp/a/') + tok))
      : '');
    return {
      kind: 'get_link',
      label: 'GET link (chat paste)',
      buttonLabel: 'Copy GET link for AI chat',
      primary: getLink,
      hint: 'Paste this GET link in your AI chat. It is get_link only — REST and MCP need separate tokens from this page. While active you can copy it again from the table.',
      flashOk: 'GET link created.',
      copiedOk: 'Copied GET link for AI chat.',
      block: [
        'Self-contained GET link (kind=get_link, preferred for chat AIs that can only HTTP GET):',
        getLink,
        '',
        'Open that URL for markdown docs + token-scoped GET routes (status, flows, propose, drafts).',
        '',
        'This path token does not work as REST or MCP Bearer — create a REST Bearer or MCP token on this page for those clients.',
        '',
        'If you get 401 access_link_missing, access_link_invalid, token_expired, or wrong_token_kind, ask the user for a new token of the right kind.'
      ].join('\\n'),
      tokenDisplay: tok || getLink,
      showDev: true
    };
  }

  // Kept for page.test source assertions (get_link developer block).
  function accessLinkCopyText(token, url) {
    return linkCopyMaterial('get_link', token, url).block;
  }

  async function onCreateLink(ev) {
    ev.preventDefault();
    var flash = $('links-flash');
    var labelInput = $('link-label');
    var kindSelect = $('link-kind');
    var ttlSeconds = selectedTtlSeconds();
    var kind = normalizeLinkKind(kindSelect && kindSelect.value);
    var maxTtl = maxTtlForKind(kind);
    if (ttlSeconds > maxTtl) {
      showFlash(
        flash,
        kind === 'get_link'
          ? 'GET link expiry cannot exceed 24 hours.'
          : 'Token expiry cannot exceed 30 days for REST/MCP.',
        false
      );
      return;
    }
    var payload = { ttlSeconds: ttlSeconds, kind: kind };
    if (labelInput && labelInput.value.trim()) payload.label = labelInput.value.trim();
    try {
      var created = await api('/links', { method: 'POST', body: JSON.stringify(payload) });
      var createdKind = normalizeLinkKind(created.kind || kind);
      var material = linkCopyMaterial(createdKind, created.token || '', created.url || '');
      var box = $('token-once');
      box.hidden = false;
      var kindLabel = $('token-kind-label');
      if (kindLabel) {
        kindLabel.hidden = false;
        kindLabel.textContent = material.label;
      }
      var tokenEl = $('token-value');
      if (tokenEl) tokenEl.textContent = material.tokenDisplay || '';
      var copyBlock = $('token-copy-block');
      if (copyBlock) {
        copyBlock.textContent = material.block;
      }
      var hint = $('token-docs-hint');
      if (hint) {
        hint.textContent = material.hint;
      }
      var devBlurb = $('token-dev-blurb');
      if (devBlurb) {
        if (createdKind === 'rest') {
          devBlurb.textContent = 'REST prompt + Bearer (reusable while active — also via Copy REST prompt in the table).';
        } else if (createdKind === 'mcp') {
          devBlurb.textContent = 'MCP Bearer for /mcp/rpc (reusable while active — also via Copy MCP Bearer in the table).';
        } else {
          devBlurb.textContent = 'GET link details (reusable while active — also via Copy GET link in the table).';
        }
      }
      var copyBtn = $('token-copy-btn');
      var mcpPanel = $('mcp-setup-panel');
      if (createdKind === 'mcp') {
        if (copyBtn) copyBtn.hidden = true;
        if (mcpPanel) {
          mcpPanel.hidden = false;
          renderMcpSetupPanel(material.mcpSnippets || {}, flash);
        }
      } else {
        if (mcpPanel) {
          mcpPanel.hidden = true;
          var clearTabs = $('mcp-setup-tabs');
          var clearBody = $('mcp-setup-body');
          if (clearTabs) clearTabs.innerHTML = '';
          if (clearBody) clearBody.innerHTML = '';
        }
        if (copyBtn) {
          copyBtn.hidden = false;
          copyBtn.textContent = material.buttonLabel;
          copyBtn.classList.remove('copied');
          copyBtn.disabled = !material.primary;
          copyBtn.onclick = function () {
            var toCopy = material.primary;
            if (!toCopy) {
              showFlash(flash, 'Nothing to copy — create a new token.', false);
              return;
            }
            copyTextToClipboard(toCopy).then(function () {
              markCopied(copyBtn, flash, material.copiedOk);
              showToast(material.copiedOk, true);
            }).catch(function () {
              showFlash(flash, 'Clipboard unavailable — expand For developers and copy manually.', false);
            });
          };
        }
      }
      if (labelInput) labelInput.value = '';
      showFlash(flash, material.flashOk, true);
      showToast(material.flashOk, true);
      loadLinks();
      loadLogs();
    } catch (e) {
      showFlash(flash, e.message || String(e), false);
      showToast(e.message || String(e), false);
    }
  }

  function renderMcpSetupPanel(snippets, flash) {
    var tabsHost = $('mcp-setup-tabs');
    var body = $('mcp-setup-body');
    if (!tabsHost || !body) return;
    var keys = Object.keys(snippets);
    if (!keys.length) {
      tabsHost.innerHTML = '';
      body.innerHTML = '';
      return;
    }
    var active = keys[0];
    function paint() {
      tabsHost.innerHTML = keys.map(function (key) {
        var sn = snippets[key];
        var selected = key === active;
        return '<button type="button" class="mcp-setup-tab' + (selected ? ' is-active' : '') +
          '" role="tab" aria-selected="' + (selected ? 'true' : 'false') +
          '" data-mcp-tab="' + esc(key) + '">' + esc(sn.title) + '</button>';
      }).join('');
      var sn = snippets[active];
      body.innerHTML =
        '<pre class="mcp-setup-snippet" id="mcp-setup-snippet">' + esc(sn.text) + '</pre>' +
        '<button type="button" class="action" id="mcp-setup-copy">' + esc(sn.label) + '</button>';
      tabsHost.querySelectorAll('[data-mcp-tab]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          active = btn.getAttribute('data-mcp-tab') || keys[0];
          paint();
        });
      });
      var copyBtn = $('mcp-setup-copy');
      if (copyBtn) {
        copyBtn.onclick = function () {
          copyTextToClipboard(sn.text).then(function () {
            markCopied(copyBtn, flash, 'Copied ' + sn.title + ' setup.');
            showToast('Copied ' + sn.title + ' setup.', true);
          }).catch(function () {
            showFlash(flash, 'Clipboard unavailable — copy the snippet manually.', false);
          });
        };
      }
    }
    paint();
  }

  function flowLabelOf(p) {
    if (p && p.flowLabel) return String(p.flowLabel);
    var flow = (p && p.payload && p.payload.flow) || {};
    var base = (p && p.baseFlow) || {};
    if (flow.label) return String(flow.label);
    if (base.label) return String(base.label);
    var flowId = p && p.payload && p.payload.flowId;
    if (flowId && cachedFlowLabels[flowId]) return String(cachedFlowLabels[flowId]);
    return '';
  }

  function ensureTitleIncludesFlowName(title, flowLabel) {
    var t = String(title || '').trim();
    var label = String(flowLabel || '').trim();
    if (!label || !t) return t;
    if (t.indexOf(label) >= 0) return t;
    return t + ' in ' + label;
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

  /**
   * Destructive enough to need an in-page confirm: any node deletes, a
   * cleared/replaced flow, or soft validation warnings (scaffold gaps).
   * Small add/modify-only edits without warnings stay one-click.
   */
  function needsApproveConfirm(diff, proposal) {
    if (proposalWarnings(proposal, diff).length > 0) return true;
    if (!diff || !diff.summary) return false;
    var removed = Number(diff.summary.removed) || 0;
    var before = Number(diff.summary.beforeNodeCount) || 0;
    var after = Number(diff.summary.afterNodeCount) || 0;
    if (removed > 0) return true;
    if (before > 0 && after === 0) return true;
    return false;
  }

  /** Soft validation notes from the proposal and/or its diff. */
  function proposalWarnings(proposal, diff) {
    var fromDiff = diff && Array.isArray(diff.warnings) ? diff.warnings : [];
    if (fromDiff.length) return fromDiff;
    if (proposal && Array.isArray(proposal.warnings)) return proposal.warnings;
    return [];
  }

  function renderValidationWarnings(warnings, opts) {
    if (!warnings || !warnings.length) return '';
    opts = opts || {};
    var title = opts.title || ('Needs configuration (' + warnings.length + ')');
    var extraClass = opts.className ? ' ' + opts.className : '';
    var items = warnings.map(function (w) {
      var code = w && w.code ? String(w.code) : '';
      var msg = w && w.error ? String(w.error) : 'Configuration needed before deploy';
      return '<li>' +
        (code ? '<span class="warn-code">' + esc(code) + '</span> — ' : '') +
        esc(msg) +
        '</li>';
    }).join('');
    return '<div class="proposal-warnings' + extraClass + '" role="status">' +
      '<p class="proposal-warnings-title">' + esc(title) + '</p>' +
      '<ul>' + items + '</ul>' +
      '</div>';
  }

  function formatDiffActionSummary(diff) {
    var s = (diff && diff.summary) || {};
    var parts = [];
    var added = Number(s.added) || 0;
    var modified = Number(s.modified) || 0;
    var removed = Number(s.removed) || 0;
    if (added) parts.push(added === 1 ? '1 add' : added + ' adds');
    if (modified) parts.push(modified === 1 ? '1 change' : modified + ' changes');
    if (removed) parts.push(removed === 1 ? '1 delete' : removed + ' deletes');
    if (!parts.length) {
      var before = Number(s.beforeNodeCount) || 0;
      var after = Number(s.afterNodeCount) || 0;
      if (before > 0 && after === 0) return 'Replaces or clears the flow (' + before + ' nodes removed).';
      return 'Review this change before deploying.';
    }
    return 'Summary: ' + parts.join(' · ') + '.';
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

  // Keep in sync with shouldRefreshDisplayTitle / titleFromDiffSummary in proposal-present.ts.
  function shouldRefreshDisplayTitle(storedTitle, removedCount) {
    var t = String(storedTitle || '').trim();
    if (!t) return true;
    if (/^Update(\\s|$)/i.test(t)) return true;
    if (removedCount > 0 && !/^Replace\\b/i.test(t)) return true;
    return false;
  }

  function pluralNodes(n) {
    return n === 1 ? 'node' : 'nodes';
  }

  var disambiguatedTitleCache = {};

  function fmtClockHm(iso) {
    try {
      var d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    } catch (e) {
      return '';
    }
  }

  /**
   * When two cards share a base title (live or stale), append · HH:mm from
   * createdAt — never the relative "12h ago" label. If clock times collide, #1/#2.
   * Keep in sync with buildDisambiguatedTitleMap in title-disambiguate.ts.
   */
  function buildDisambiguatedTitles(proposals) {
    var map = {};
    var groups = {};
    (proposals || []).forEach(function (p) {
      if (!p || !p.id) return;
      // Prefer diff-derived titles so stale + live with the same summary collide.
      var base = displayTitleForProposal(p, proposalDiffCache[p.id]);
      map[p.id] = base;
      if (!groups[base]) groups[base] = [];
      groups[base].push(p);
    });
    Object.keys(groups).forEach(function (base) {
      var list = groups[base];
      if (list.length < 2) return;
      var timed = {};
      list.forEach(function (p) {
        var hm = fmtClockHm(p.createdAt);
        var withTime = hm ? base + ' · ' + hm : base;
        if (!timed[withTime]) timed[withTime] = [];
        timed[withTime].push(p);
      });
      Object.keys(timed).forEach(function (t) {
        var group = timed[t];
        if (group.length === 1) {
          map[group[0].id] = t;
          return;
        }
        group.sort(function (a, b) {
          var ca = String(a.createdAt || '');
          var cb = String(b.createdAt || '');
          if (ca !== cb) return ca < cb ? -1 : 1;
          return String(a.id).localeCompare(String(b.id));
        });
        group.forEach(function (p, i) {
          map[p.id] = t + ' #' + (i + 1);
        });
      });
    });
    return map;
  }

  function titleForProposalCard(p) {
    if (p && p.id && disambiguatedTitleCache[p.id]) {
      return disambiguatedTitleCache[p.id];
    }
    return displayTitleForProposal(p, proposalDiffCache[p && p.id]);
  }

  /** True when this card's heading was clock-disambiguated (not relative time). */
  function titleWasDisambiguated(p) {
    if (!p || !p.id || !disambiguatedTitleCache[p.id]) return false;
    var base = displayTitleForProposal(p, proposalDiffCache[p.id]);
    return disambiguatedTitleCache[p.id] !== base;
  }

  function displayTitleForProposal(p, diff) {
    var stored = p.title || (p.displayName ? titleFromDisplayName(p.displayName) : '');
    var flowLabel = flowLabelOf(p);
    if (!diff || !diff.summary) {
      return ensureTitleIncludesFlowName(
        stored || (flowLabel ? 'Update ' + flowLabel : 'Proposal'),
        flowLabel
      );
    }
    var sum = diff.summary;
    var removed = Number(sum.removed) || 0;
    var added = Number(sum.added) || 0;
    var modified = Number(sum.modified) || 0;
    if (!shouldRefreshDisplayTitle(stored, removed)) {
      return ensureTitleIncludesFlowName(stored, flowLabel);
    }
    var firstType = '';
    if (diff.added && diff.added[0] && diff.added[0].type) {
      firstType = String(diff.added[0].type);
    }
    if (removed > 0) {
      var parts = ['deletes ' + removed + ' ' + pluralNodes(removed)];
      if (added === 1 && firstType) parts.push('adds 1 ' + firstType);
      else if (added > 0) parts.push('adds ' + added + ' ' + pluralNodes(added));
      if (modified > 0) parts.push('edits ' + modified + ' ' + pluralNodes(modified));
      return (flowLabel ? 'Replace ' + flowLabel : 'Replace flow') + ': ' + parts.join(', ');
    }
    var total = added + modified;
    if (total === 0) return flowLabel ? 'Update ' + flowLabel : 'Update flow';
    if (total === 1 && added === 1 && firstType) {
      return ensureTitleIncludesFlowName('Add ' + firstType + ' node', flowLabel);
    }
    if (total === 1 && modified === 1) {
      return flowLabel ? 'Edit node in ' + flowLabel : 'Edit node';
    }
    return flowLabel ? total + ' changes in ' + flowLabel : total + ' changes';
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
    var labelHtml = fieldLabelHtml(p.key);
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
        return '<details class="presence-text"><summary>' + labelHtml +
          ' <span class="muted">(' + text.split('\\n').length + ' lines)</span></summary>' +
          '<div class="presence-text-toolbar">' + previewToggle + '</div>' +
          previewBlock +
          '<pre class="presence-pre">' + esc(text) + '</pre></details>';
      }
      // Short single-line fields (format, syntax, …) stay inline expanded.
      return '<div class="prop-change">' + labelHtml + ': ' +
        '<code class="presence-inline">' + esc(text) + '</code></div>';
    }
    // Wires (and other readable strings) stay as plain text, not JSON-quoted.
    if (typeof p.value === 'string') {
      return '<div class="prop-change">' + labelHtml + ': ' +
        '<code class="presence-inline">' + esc(p.value) + '</code></div>';
    }
    return '<div class="prop-change">' + labelHtml + ': ' +
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
    // Hide raw node ids when the sentence summary already names the change.
    var idHint = n.summary
      ? ''
      : (' <span class="muted tip-id" title="' + esc(n.id) + '">' + tipId(n.id, 8) + '</span>');
    return '<details class="node-presence node-' + kind + '"' + open + '>' +
      '<summary><span class="presence-summary-text">' + summaryText + '</span>' +
      idHint + '</summary>' +
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
    // Prefer byte sizes from the API (summary omits full before/after strings).
    var beforeB = typeof ch.beforeBytes === 'number'
      ? ch.beforeBytes
      : (typeof ch.before === 'string' ? ch.before.length : 0);
    var afterB = typeof ch.afterBytes === 'number'
      ? ch.afterBytes
      : (typeof ch.after === 'string' ? ch.after.length : 0);
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
    var labelHtml = fieldLabelHtml(ch.key);
    if (ch.kind === 'text') {
      var body = mode === 'split' ? renderSplitTextDiff(ch) : renderUnifiedTextDiff(ch);
      var lineCount = textChangeLineCount(ch);
      if (isLargeTextChange(ch)) {
        var lineLabel = lineCount > 0 ? (lineCount + '-line change') : 'large text change';
        return '<div class="prop-change large-text-diff">' +
          labelHtml + ' ' +
          '<details class="large-diff-details">' +
          '<summary class="large-diff-btn">Show ' + esc(lineLabel) + '</summary>' +
          body + '</details></div>';
      }
      // Short fields: no byte counts — the sentence/heading already frames the change.
      return '<div class="prop-change">' + labelHtml + body + '</div>';
    }
    if (mode === 'split') {
      return '<div class="prop-change">' + labelHtml +
        '<div class="prop-change-scalar split">' +
        '<div class="scalar-side"><span class="side-label">Before</span>' +
        '<code class="diff-before" title="before">' + esc(JSON.stringify(ch.before)) + '</code></div>' +
        '<span class="scalar-arrow" aria-hidden="true">→</span>' +
        '<div class="scalar-side"><span class="side-label">After</span>' +
        '<code class="diff-after" title="after">' + esc(JSON.stringify(ch.after)) + '</code></div>' +
        '</div></div>';
    }
      return '<div class="prop-change">' + labelHtml + ': ' +
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
          // Hide raw ids when the sentence heading already describes the node.
          var idHint = m.summary
            ? ''
            : (' <span class="muted tip-id" title="' + esc(m.id) + '">' + tipId(m.id, 8) + '</span>');
          return '<div class="modified-node">' +
            '<div class="modified-heading">' + heading + idHint + '</div>' +
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
      ? '<p class="muted">No starting snapshot was saved with this proposal, so changes are compared with the live flow.</p>'
      : '';
    // Hide +/-/~ counters and tab:label jargon — the card sentence already says it.
    var showModeToggle = diffHasTextChanges(diff);
    var toolbar = '';
    if (showModeToggle) {
      toolbar =
        '<div class="diff-toolbar">' +
        '<div class="diff-mode-toggle" role="group" aria-label="Diff layout" ' +
        'title="Switch how multi-line text changes are shown">' +
        '<button type="button" data-diff-mode="split" title="Show before and after side by side" aria-pressed="' +
        (mode === 'split' ? 'true' : 'false') + '">Side by side</button>' +
        '<button type="button" data-diff-mode="unified" title="Show a single combined line diff" aria-pressed="' +
        (mode === 'unified' ? 'true' : 'false') + '">Unified</button>' +
        '</div></div>';
    }
    var warnHtml = renderValidationWarnings(diff.warnings, {
      title: 'Scaffold warnings — configure before deploy if needed',
      className: 'diff-warnings'
    });
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
      var places = (vc.added || 0) + (vc.removed || 0) + (vc.modified || 0);
      if (places > 0) {
        vsCurrent = '<p class="muted vs-current-plain">The flow also changed in ' +
          places + ' other place' + (places === 1 ? '' : 's') + ' since then.</p>';
      }
    }
    return missing + warnHtml + toolbar + sections + vsCurrent;
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
    var fullText = formatPendingBadgeText(counts.live, counts.stale);
    var badge = $('proposals-pending-badge');
    if (badge) {
      // Tab badge: to-review count only; full wording lives in the tooltip.
      badge.textContent = String(counts.live);
      badge.hidden = counts.pending <= 0;
      badge.title = fullText;
    }
    var filterCount = $('filter-pending-count');
    if (filterCount) filterCount.textContent = fullText;
    var decidedCount = $('filter-decided-count');
    if (decidedCount) decidedCount.textContent = String(counts.decided);
    var dashPending = $('dash-pending');
    if (dashPending) {
      dashPending.textContent = fullText;
      dashPending.title = fullText;
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
    list.querySelectorAll('.id-copy').forEach(function (btn) {
      bindOnce(btn, 'click', function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (ev && ev.preventDefault) ev.preventDefault();
        var fullId = btn.getAttribute('data-copy-id') || '';
        if (!fullId) return;
        var flash = $('proposals-flash');
        copyTextToClipboard(fullId).then(function () {
          showFlash(flash, 'Copied proposal id ' + proposalShortId(fullId, 8), true);
        }).catch(function () {
          showFlash(flash, 'Clipboard unavailable — id is ' + fullId, false);
        });
      });
    });
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
        var id = btn.getAttribute('data-id');
        openConfirmDialog({
          title: 'Dismiss proposal',
          message: 'This closes the out-of-date item from your queue. The flow is unchanged.',
          confirmLabel: 'Dismiss',
          danger: true,
          onConfirm: function () {
            rejectProposal(id, 'Dismissed — ask the AI to resubmit');
          }
        });
      });
    });
    var dismissAll = list.querySelector('#dismiss-all-stale');
    bindOnce(dismissAll, 'click', function () {
      dismissAllStaleProposals();
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
`;
}

function pageClientScriptPartB2Actions(): string {
  return `
  function renderDeleteBanner(diff) {
    if (!isLargeDelete(diff)) return '';
    var beforeN = diff.summary.beforeNodeCount || 0;
    var removedN = diff.summary.removed || 0;
    return '<div class="delete-banner" role="status">Deletes ' + removedN +
      ' of ' + beforeN + ' nodes</div>';
  }

  function renderPendingActions(p, stale) {
    if (!canApprove || p.status !== 'pending') return '';
    // Stale items live in the Out of date group (Dismiss only).
    if (stale) return '';
    var cached = proposalDiffCache[p.id];
    var warns = proposalWarnings(p, cached);
    var warnNote = warns.length
      ? renderValidationWarnings(warns, {
          title: 'Approve will deploy with ' + warns.length +
            ' configuration warning' + (warns.length === 1 ? '' : 's') +
            ' — you can finish setup in the editor afterward'
        })
      : '';
    return warnNote +
      '<p class="muted approve-help">Approve deploys this change to Node-RED. Nothing is live until you approve.</p>' +
      '<div class="row">' +
      '<button type="button" class="action approve-btn" data-id="' + esc(p.id) +
      '">Approve &amp; deploy</button>' +
      '<button type="button" class="action secondary reject-btn" data-id="' + esc(p.id) +
      '">Reject</button>' +
      '</div>' +
      '<details class="advanced-block">' +
      '<summary>Deploy options</summary>' +
      '<label>Deploy type<select class="deploy-type" data-id="' + esc(p.id) + '">' +
      '<option value="nodes"' + (defaultDeploy === 'nodes' ? ' selected' : '') +
      '>Only changed nodes (recommended)</option>' +
      '<option value="flows"' + (defaultDeploy === 'flows' ? ' selected' : '') +
      '>Changed flows</option>' +
      '<option value="full"' + (defaultDeploy === 'full' ? ' selected' : '') +
      '>Full redeploy</option>' +
      '</select></label>' +
      '<p class="full-deploy-warn" data-id="' + esc(p.id) + '"' +
      (defaultDeploy === 'full' ? '' : ' hidden') +
      '>Warning: full restarts the entire runtime.</p>' +
      '</details>';
  }

  function dismissAllStaleProposals() {
    var staleIds = cachedProposals
      .filter(function (p) { return p.status === 'pending' && proposalIsStale(p); })
      .map(function (p) { return p.id; });
    if (!staleIds.length) return;
    var n = staleIds.length;
    openConfirmDialog({
      title: 'Dismiss out-of-date proposals',
      message: 'Dismiss ' + n + ' out-of-date proposal' + (n === 1 ? '' : 's') +
        ' from your queue? The flow is unchanged.',
      confirmLabel: n === 1 ? 'Dismiss' : 'Dismiss all',
      danger: true,
      onConfirm: function () { doDismissAllStaleProposals(staleIds); }
    });
  }

  async function doDismissAllStaleProposals(staleIds) {
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
  }
`;
}

function pageClientScriptPartB2Cards(): string {
  return `
  function renderRequestedVia(p) {
    if (!p.createdBy) return '';
    if (p.createdBy.label) {
      return '<span class="muted">Requested via link "' + esc(p.createdBy.label) + '"</span>';
    }
    if (p.createdBy.linkId) {
      return '<span class="muted">Requested via link ' + tipId(p.createdBy.linkId, 8) + '</span>';
    }
    return '';
  }

  function renderProposalTech(p, cached) {
    return '<details class="tech-details">' +
      '<summary>Technical details</summary>' +
      '<p class="muted">' + esc(proposalTechSummary(p)) + '</p>' +
      '<p class="muted proposal-rev-meta" data-rev-for="' + esc(p.id) + '">' +
      (cached
        ? renderDiffRevMeta(cached) + ' · id ' + proposalIdChip(p.id)
        : 'expectedRev ' + tipId(p.expectedRev, 8) + ' · id ' + proposalIdChip(p.id)) +
      '</p>' +
      '<details><summary>Raw payload</summary><pre>' +
      esc(JSON.stringify(p.payload, null, 2)) + '</pre></details>' +
      '</details>';
  }

  function renderProposalMetaLine(p) {
    var flowLabel = flowLabelOf(p);
    // Colliding titles already carry · HH:mm in the heading; meta still shows
    // an exact local clock (not only "12h ago") so stale peers stay distinct.
    var timeHtml;
    if (titleWasDisambiguated(p) && p.createdAt) {
      var hm = fmtClockHm(p.createdAt);
      timeHtml = hm
        ? '<time class="time-exact" datetime="' + esc(p.createdAt) + '" title="' +
          esc(fmt(p.createdAt)) + '">' + esc(hm) + '</time>'
        : timeCell(p.createdAt);
    } else {
      timeHtml = timeCell(p.createdAt);
    }
    return '<span class="proposal-meta-line">' +
      (flowLabel ? '<span class="proposal-flow">' + esc(flowLabel) + '</span> · ' : '') +
      timeHtml +
      ' · <span class="proposal-id-meta">id ' + proposalIdChip(p.id) + '</span>' +
      '</span>';
  }

  function renderProposalCard(p) {
    var cached = proposalDiffCache[p.id];
    var title = titleForProposalCard(p);
    var flowLabel = flowLabelOf(p);
    var createdBy = renderRequestedVia(p);
    var reason = p.reason
      ? '<p class="muted">Reason: ' + esc(friendlyReason(p.reason)) + '</p>'
      : '';
    var plain = cached ? plainDiffSentence(cached, flowLabel) : '';
    // Show for any large delete — including stale — so owners see the risk.
    var deleteBanner = cached ? renderDeleteBanner(cached) : '';
    // Card-level banner even before diff loads (warnings come from list API).
    var cardWarns = proposalWarnings(p, cached);
    var warnBanner = cardWarns.length && !cached
      ? renderValidationWarnings(cardWarns)
      : '';
    var stale = proposalIsStale(p);
    var actions = renderPendingActions(p, stale);
    var changes =
      '<div class="proposal-changes proposal-diff" data-diff-for="' + esc(p.id) +
      '" data-changes-for="' + esc(p.id) + '">' +
      (cached ? renderHumanDiff(cached) : '<p class="muted">Loading changes…</p>') +
      '</div>';
    return '<article class="proposal-detail" id="proposal-' + esc(p.id) +
      '" data-id="' + esc(p.id) + '" data-status="' + esc(p.status) + '">' +
      '<header class="proposal-card-head">' +
      '<h3 class="proposal-heading" data-title-for="' + esc(p.id) + '">' + esc(title) + '</h3>' +
      '<span class="status-pill ' + esc(p.status) + '">' + esc(p.status) + '</span> ' +
      renderProposalMetaLine(p) +
      '</header>' +
      (createdBy ? createdBy + '<br/>' : '') +
      '<p class="proposal-plain-summary" data-plain-for="' + esc(p.id) + '">' +
      (plain ? esc(plain) : '<span class="muted">Loading summary…</span>') + '</p>' +
      deleteBanner +
      warnBanner +
      reason +
      changes +
      renderProposalTech(p, cached) +
      actions +
      '</article>';
  }
`;
}

function pageClientScriptPartB2CardsList(): string {
  return `
  function renderStaleItem(p) {
    var cached = proposalDiffCache[p.id];
    var title = titleForProposalCard(p);
    var deleteBanner = cached ? renderDeleteBanner(cached) : '';
    var dismissBtn = canApprove
      ? '<button type="button" class="action secondary dismiss-stale-btn" data-id="' +
        esc(p.id) + '">Dismiss</button>'
      : '';
    return '<div class="stale-item proposal-detail" id="proposal-' + esc(p.id) +
      '" data-id="' + esc(p.id) + '" data-status="pending" data-stale="1">' +
      '<div class="stale-item-row">' +
      '<div class="stale-item-main">' +
      '<strong class="proposal-heading" data-title-for="' + esc(p.id) + '">' + esc(title) +
      '</strong>' +
      '<span class="stale-reason muted">Flow changed since this was submitted</span>' +
      renderProposalMetaLine(p) +
      '</div>' +
      dismissBtn +
      '</div>' +
      deleteBanner +
      '<details class="stale-item-diff">' +
      '<summary>Show changes</summary>' +
      '<div class="proposal-changes proposal-diff" data-diff-for="' + esc(p.id) +
      '" data-changes-for="' + esc(p.id) + '">' +
      (cached ? renderHumanDiff(cached) : '<p class="muted">Loading changes…</p>') +
      '</div>' +
      renderProposalTech(p, cached) +
      '</details></div>';
  }

  function renderStaleGroup(items) {
    if (!items.length) return '';
    return '<details class="stale-group">' +
      '<summary>Out of date (' + items.length + ')</summary>' +
      '<p class="muted dismiss-vs-reject">Dismiss closes an out-of-date item from your queue ' +
      '(the AI is asked to resubmit). Reject tells the AI the change was refused — use Reject ' +
      'only on proposals that are still current.</p>' +
      (canApprove
        ? '<div class="stale-group-actions">' +
          '<button type="button" class="action secondary" id="dismiss-all-stale">' +
          'Dismiss all out-of-date</button></div>'
        : '') +
      items.map(renderStaleItem).join('') +
      '</details>';
  }

  function renderCompactProposal(p) {
    var title = titleForProposalCard(p);
    return '<div class="proposal-card-compact" data-id="' + esc(p.id) +
      '" role="button" tabindex="0" aria-expanded="false">' +
      '<strong>' + esc(title) + '</strong>' +
      '<span class="status-pill ' + esc(p.status) + '">' + esc(p.status) + '</span>' +
      renderProposalMetaLine(p) +
      '</div>' +
      '<div class="proposal-detail" id="proposal-' + esc(p.id) + '" data-id="' + esc(p.id) +
      '" data-status="' + esc(p.status) + '" hidden></div>';
  }

  function proposalMatchesSearch(p) {
    var q = String(proposalsSearchQuery || '').trim().toLowerCase();
    if (!q) return true;
    // Match full id, the visible short id (first 8 hex after prop-), or any substring.
    var id = String(p.id || '').toLowerCase();
    var short = String(proposalShortId(p.id, 8) || '').toLowerCase();
    var idCompact = id.replace(/[^a-z0-9]/g, '');
    var qCompact = q.replace(/[^a-z0-9]/g, '');
    var title = String(titleForProposalCard(p) || '').toLowerCase();
    var stored = String(p.title || '').toLowerCase();
    var display = String(p.displayName || '').toLowerCase();
    return id.indexOf(q) >= 0 ||
      (short && short.indexOf(q) >= 0) ||
      (qCompact.length > 0 && idCompact.indexOf(qCompact) >= 0) ||
      title.indexOf(q) >= 0 ||
      stored.indexOf(q) >= 0 ||
      display.indexOf(q) >= 0;
  }

  function countSearchMatchesInFilter(filter) {
    var pending = cachedProposals.filter(function (p) { return p.status === 'pending'; });
    var decided = cachedProposals.filter(function (p) { return p.status !== 'pending'; });
    if (filter === 'decided') {
      return decided.filter(proposalMatchesSearch).length;
    }
    return pending.filter(proposalMatchesSearch).length;
  }

  function renderCrossTabSearchHint(otherFilter, otherCount) {
    if (!proposalsSearchQuery.trim() || otherCount <= 0) return '';
    var label = otherFilter === 'decided' ? 'Decided' : 'Pending';
    var matchWord = otherCount === 1 ? '1 match' : otherCount + ' matches';
    return '<p class="cross-tab-hint" role="status">' +
      esc(matchWord) + ' in ' + esc(label) +
      ' <button type="button" class="cross-tab-switch" data-filter="' + esc(otherFilter) + '">' +
      'Switch to ' + esc(label) + '</button></p>';
  }

  function bindCrossTabHint(list) {
    if (!list) return;
    list.querySelectorAll('.cross-tab-switch').forEach(function (btn) {
      bindOnce(btn, 'click', function () {
        var f = btn.getAttribute('data-filter');
        setProposalsFilter(f === 'decided' ? 'decided' : 'pending');
      });
    });
  }

  function renderEmptyProposalsState(title, muted, extraHtml) {
    return '<div class="empty-state"><p class="empty-title">' + esc(title) + '</p>' +
      '<p class="muted">' + esc(muted) + '</p>' +
      (extraHtml || '') +
      '</div>';
  }

  function renderProposalsList() {
    var list = $('proposals-list');
    if (!list) return;
    var filters = $('proposals-filters');
    var pending = cachedProposals.filter(function (p) { return p.status === 'pending'; });
    var decided = cachedProposals.filter(function (p) { return p.status !== 'pending'; });
    updatePendingBadges();
    if (filters) filters.hidden = cachedProposals.length === 0;
    if (!cachedProposals.length) {
      list.innerHTML = renderEmptyProposalsState(
        'No proposals yet',
        'When an AI submits a change it will appear here for review.'
      );
      return;
    }
    if (proposalsFilter === 'pending') {
      var live = pending.filter(function (p) {
        return !proposalIsStale(p) && proposalMatchesSearch(p);
      });
      var stale = pending.filter(function (p) {
        return proposalIsStale(p) && proposalMatchesSearch(p);
      });
      if (!live.length && !stale.length) {
        var decidedMatches = countSearchMatchesInFilter('decided');
        list.innerHTML = renderEmptyProposalsState(
          proposalsSearchQuery.trim() ? 'No matching proposals' : 'No pending proposals',
          proposalsSearchQuery.trim()
            ? 'Try a different title or id, or clear the search.'
            : 'Switch the filter above to see other proposals.',
          renderCrossTabSearchHint('decided', decidedMatches)
        );
        bindCrossTabHint(list);
        return;
      }
      disambiguatedTitleCache = buildDisambiguatedTitles(live.concat(stale));
      list.innerHTML = live.map(renderProposalCard).join('') + renderStaleGroup(stale);
      live.concat(stale).forEach(function (p) { loadProposalDiff(p.id); });
    } else {
      var matchedDecided = decided.filter(proposalMatchesSearch);
      if (!matchedDecided.length) {
        var pendingMatches = countSearchMatchesInFilter('pending');
        list.innerHTML = renderEmptyProposalsState(
          proposalsSearchQuery.trim() ? 'No matching proposals' : 'No decided proposals',
          proposalsSearchQuery.trim()
            ? 'Try a different title or id, or clear the search.'
            : 'Switch the filter above to see other proposals.',
          renderCrossTabSearchHint('pending', pendingMatches)
        );
        bindCrossTabHint(list);
        return;
      }
      disambiguatedTitleCache = buildDisambiguatedTitles(matchedDecided);
      list.innerHTML = matchedDecided.map(renderCompactProposal).join('');
    }
    bindProposalActions(list);
    focusProposalFromHash();
  }
`;
}

function pageClientScriptPartB2Focus(): string {
  return `
  async function refreshFlowLabels() {
    try {
      var data = await api('/flows');
      var flows = (data && data.flows) || [];
      flows.forEach(function (f) {
        if (f && f.type === 'tab' && f.id && f.label) {
          cachedFlowLabels[f.id] = String(f.label);
        }
      });
    } catch (e) {
      /* optional enrichment for oldest cards */
    }
  }

  async function loadProposals(opts) {
    if (!aiOn) return;
    opts = opts || {};
    var flash = $('proposals-flash');
    if (!opts.skipRender && !opts.keepFlash) {
      showFlash(flash, '', true);
    }
    try {
      await refreshFlowLabels();
      var data = await api('/proposals');
      cachedProposals = (data && data.proposals) || [];
      cachedProposals.forEach(function (p) {
        var id = p && p.payload && p.payload.flowId;
        var label = p && p.flowLabel;
        if (id && label) cachedFlowLabels[id] = String(label);
      });
      if (!opts.skipRender) {
        renderProposalsList();
      } else {
        updatePendingBadges();
      }
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
    var needsRerender = false;
    // Clear search so a deep-linked card is not hidden by the filter box.
    if (proposalsSearchQuery) {
      proposalsSearchQuery = '';
      var searchEl = $('proposals-search');
      if (searchEl) searchEl.value = '';
      needsRerender = true;
    }
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
      needsRerender = true;
    }
    if (needsRerender) {
      // Nested renderProposalsList → focusProposalFromHash finishes the deep link.
      renderProposalsList();
      return !readProposalHashId();
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
    var wasStale = p ? proposalIsStale(p) : false;
    if (p && typeof diff.baseRevStale === 'boolean') {
      p.baseRevStale = diff.baseRevStale;
    }
    // Newly discovered stale → re-render into the Out of date group.
    if (p && p.status === 'pending' && !wasStale && diff.baseRevStale) {
      renderProposalsList();
      return;
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
        (p ? ' · id ' + proposalIdChip(p.id) : '');
      var listHost = $('proposals-list');
      if (listHost) bindProposalActions(listHost);
    }
    var article = document.querySelector('.proposal-detail[data-id="' + id + '"]');
    if (!article) {
      updatePendingBadges();
      return;
    }
    if (diff.baseRevStale) article.setAttribute('data-stale', '1');
    else article.removeAttribute('data-stale');

    // Banner for any large delete (stale or live) — owners must see the risk.
    var existingBanner = article.querySelector('.delete-banner');
    if (isLargeDelete(diff)) {
      var beforeN = diff.summary.beforeNodeCount || 0;
      var removedN = diff.summary.removed || 0;
      var html = 'Deletes ' + removedN + ' of ' + beforeN + ' nodes';
      if (existingBanner) {
        existingBanner.textContent = html;
      } else {
        var anchor = article.querySelector('.proposal-plain-summary') ||
          article.querySelector('.stale-item-row');
        var banner = document.createElement('div');
        banner.className = 'delete-banner';
        banner.setAttribute('role', 'status');
        banner.textContent = html;
        if (anchor && anchor.parentNode) {
          anchor.parentNode.insertBefore(banner, anchor.nextSibling);
        } else {
          article.insertBefore(banner, article.firstChild);
        }
      }
    } else if (existingBanner) {
      existingBanner.parentNode.removeChild(existingBanner);
    }

    // Refresh headings from the live diff; rebuild disambiguation across peers
    // (includes stale cards — relative "12h ago" alone must not be the only cue).
    var pendingPeers = cachedProposals.filter(function (x) { return x.status === 'pending'; });
    disambiguatedTitleCache = buildDisambiguatedTitles(pendingPeers);
    pendingPeers.forEach(function (peer) {
      var el = document.querySelector('[data-title-for="' + peer.id + '"]');
      if (el) el.textContent = titleForProposalCard(peer);
      var article = document.querySelector('.proposal-detail[data-id="' + peer.id + '"]');
      if (article) {
        var meta = article.querySelector('.proposal-meta-line');
        if (meta) {
          meta.outerHTML = renderProposalMetaLine(peer);
          bindProposalActions(article);
        }
      }
    });
    updatePendingBadges();
  }

  async function loadProposalDiff(id) {
    var host = document.querySelector('.proposal-diff[data-diff-for="' + id + '"]');
    try {
      var diff = await api('/proposals/' + encodeURIComponent(id) + '/diff');
      applyDiffToProposalCard(id, diff);
      if (host) {
        host.innerHTML = renderHumanDiff(diff);
        bindDiffModeToggle(host, diff);
        bindPresencePreviewToggles(host);
      }
      // Audit rows reuse displayTitleForProposal — refresh if the log table is open.
      var logsSection = $('section-logs');
      if (logsSection && !logsSection.hidden && cachedLogs.length) {
        applyLogFilter();
      }
    } catch (e) {
      if (host) {
        host.innerHTML = '<p class="muted">Could not load changes: ' +
          esc(e.message || String(e)) + '</p>';
      }
    }
  }`;
}

function pageClientScriptPartC(): string {
  return `

  function dialogFocusables(dialog) {
    if (!dialog) return [];
    var nodes = dialog.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    var out = [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (!nodes[i].closest('[hidden]')) out.push(nodes[i]);
    }
    return out;
  }

  function trapDialogFocus(dialog, ev) {
    if (!dialog || ev.key !== 'Tab') return;
    var list = dialogFocusables(dialog);
    if (!list.length) {
      ev.preventDefault();
      return;
    }
    var first = list[0];
    var last = list[list.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  function showInPageDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    var focusables = dialogFocusables(dialog);
    var prefer = dialog.querySelector('textarea, input:not([type="hidden"]), button.action:not(.secondary)');
    if (prefer && !prefer.disabled) prefer.focus();
    else if (focusables.length) focusables[0].focus();
  }

  function openConfirmDialog(opts) {
    opts = opts || {};
    pendingConfirmAction = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
    var dialog = $('confirm-dialog');
    var title = $('confirm-title');
    var msg = $('confirm-message');
    var btn = $('confirm-action-btn');
    if (title) title.textContent = opts.title || 'Confirm';
    if (msg) {
      msg.textContent = opts.message || '';
      msg.className = opts.danger ? 'danger-text' : 'muted';
    }
    if (btn) {
      btn.textContent = opts.confirmLabel || 'Confirm';
      btn.className = 'action' + (opts.danger ? ' danger' : '');
    }
    showInPageDialog(dialog);
  }

  function openRejectDialog(id) {
    pendingRejectId = id;
    var dialog = $('reject-dialog');
    var input = $('reject-reason-input');
    var titleEl = $('reject-dialog-title');
    var p = cachedProposals.filter(function (x) { return x.id === id; })[0];
    if (titleEl) {
      var t = proposalToastTitle(p);
      titleEl.textContent = t ? '"' + t + '"' : '';
      titleEl.hidden = !t;
    }
    if (input) input.value = '';
    showInPageDialog(dialog);
  }

  function openDeleteConfirmDialog(id, deploymentType, diff) {
    pendingApproveCtx = { id: id, deploymentType: deploymentType, requireDelete: isLargeDelete(diff) };
    var dialog = $('delete-confirm-dialog');
    var heading = $('delete-confirm-heading');
    var titleEl = $('delete-confirm-proposal-title');
    var msg = $('delete-confirm-msg');
    var summaryEl = $('delete-confirm-summary');
    var warnEl = $('delete-confirm-warnings');
    var typeLabel = $('delete-confirm-type-label');
    var input = $('delete-confirm-input');
    var btn = $('delete-confirm-btn');
    var p = cachedProposals.filter(function (x) { return x.id === id; })[0];
    var beforeN = (diff && diff.summary && diff.summary.beforeNodeCount) || 0;
    var removedN = (diff && diff.summary && diff.summary.removed) || 0;
    var large = isLargeDelete(diff);
    var warns = proposalWarnings(p, diff);
    var destructive = removedN > 0 || (beforeN > 0 && ((diff && diff.summary && diff.summary.afterNodeCount) || 0) === 0);
    if (heading) {
      if (large) {
        heading.textContent = 'Confirm large deletion';
      } else if (destructive) {
        heading.textContent = 'Confirm approve & deploy';
      } else if (warns.length) {
        heading.textContent = 'Approve with configuration warnings';
      } else {
        heading.textContent = 'Confirm approve & deploy';
      }
    }
    if (titleEl) {
      var t = proposalToastTitle(p);
      titleEl.textContent = t ? '"' + t + '"' : '';
      titleEl.hidden = !t;
    }
    if (msg) {
      if (large) {
        msg.textContent = 'This proposal deletes ' + removedN + ' of ' + beforeN +
          ' nodes. Type DELETE to confirm approve & deploy.';
        msg.className = 'danger-text';
        msg.hidden = false;
      } else if (removedN > 0) {
        msg.textContent = 'This proposal deletes ' + removedN +
          ' node' + (removedN === 1 ? '' : 's') + '. Confirm before deploying.';
        msg.className = 'danger-text';
        msg.hidden = false;
      } else if (destructive) {
        msg.textContent = 'This proposal replaces or clears the flow. Confirm before deploying.';
        msg.className = 'danger-text';
        msg.hidden = false;
      } else if (warns.length) {
        msg.textContent = 'This proposal has configuration gaps (scaffold). You can approve now and finish setup in the editor afterward.';
        msg.className = 'muted';
        msg.hidden = false;
      } else {
        msg.textContent = '';
        msg.hidden = true;
      }
    }
    if (summaryEl) {
      summaryEl.textContent = formatDiffActionSummary(diff);
    }
    if (warnEl) {
      if (warns.length) {
        warnEl.hidden = false;
        warnEl.innerHTML = renderValidationWarnings(warns, {
          title: 'Configuration warnings'
        });
      } else {
        warnEl.hidden = true;
        warnEl.innerHTML = '';
      }
    }
    if (typeLabel) typeLabel.hidden = !large;
    if (input) {
      input.value = '';
      input.hidden = !large;
    }
    if (btn) btn.disabled = !!large;
    showInPageDialog(dialog);
  }

  /**
   * After approve/reject: keep search useful — switch to Decided if the card
   * moved there, or clear an empty search with a short note.
   */
  function settleSearchAfterAction(actedId, actedStatus) {
    var flash = $('proposals-flash');
    var q = String(proposalsSearchQuery || '').trim();
    if (!q) {
      renderProposalsList();
      return;
    }
    var acted = cachedProposals.filter(function (x) { return x.id === actedId; })[0];
    var status = acted ? acted.status : actedStatus;
    var currentMatches = countSearchMatchesInFilter(proposalsFilter);
    if (currentMatches > 0) {
      renderProposalsList();
      return;
    }
    if (status && status !== 'pending' && proposalsFilter === 'pending') {
      var decidedMatches = countSearchMatchesInFilter('decided');
      if (decidedMatches > 0) {
        setProposalsFilter('decided');
        var prior = flash && !flash.hidden ? String(flash.textContent || '').trim() : '';
        showFlash(
          flash,
          (prior ? prior + ' ' : '') + 'Showing the decided proposal for your search.',
          true
        );
        return;
      }
    }
    proposalsSearchQuery = '';
    var searchEl = $('proposals-search');
    if (searchEl) searchEl.value = '';
    var priorClear = flash && !flash.hidden ? String(flash.textContent || '').trim() : '';
    showFlash(
      flash,
      (priorClear ? priorClear + ' ' : '') + 'Cleared search — no matches left in this filter.',
      true
    );
    renderProposalsList();
  }

  async function doApproveProposal(id, deploymentType) {
    var flash = $('proposals-flash');
    var pBefore = cachedProposals.filter(function (x) { return x.id === id; })[0];
    var toastTitle = proposalToastTitle(pBefore);
    var expectedRev = pBefore && pBefore.expectedRev;
    var peersBefore = expectedRev
      ? cachedProposals.filter(function (x) {
          return x.id !== id && x.status === 'pending' && x.expectedRev === expectedRev;
        }).length
      : 0;
    try {
      var result = await api('/proposals/' + encodeURIComponent(id) + '/approve', {
        method: 'POST',
        body: JSON.stringify({ deploymentType: deploymentType })
      });
      var viewOpts = { title: toastTitle, href: proposalViewHref(id), linkLabel: 'View' };
      if (result.status === 'rejected') {
        var rejectMsg = friendlyReason(result.reason) || 'Proposal rejected (revision conflict).';
        showFlash(flash, rejectMsg, false);
        showToast(rejectMsg, false, viewOpts);
      } else if (result.status === 'failed') {
        var failMsg = friendlyReason(result.reason) || 'Proposal failed.';
        showFlash(flash, failMsg, false);
        showToast(failMsg, false, viewOpts);
      } else {
        showFlash(flash, 'Approved & deployed' +
          (result.resultRev ? ' (' + result.resultRev + ')' : '') +
          (toastTitle ? ': ' + toastTitle : '') + '.', true);
        showToast('Approved & deployed.', true, viewOpts);
      }
      delete proposalDiffCache[id];
      // Clear diff cache for peers that shared the rev — they are now out of date.
      cachedProposals.forEach(function (peer) {
        if (peer.id !== id && peer.status === 'pending' && peer.expectedRev === expectedRev) {
          delete proposalDiffCache[peer.id];
          peer.baseRevStale = true;
        }
      });
      await loadProposals({ skipRender: true });
      updatePendingBadges();
      notifySidebarPendingRefresh();
      if (result.status !== 'rejected' && result.status !== 'failed' && peersBefore > 0) {
        var note = peersBefore === 1
          ? '1 other proposal is now out of date'
          : peersBefore + ' other proposals are now out of date';
        var priorOk = flash && !flash.hidden ? String(flash.textContent || '').trim() : '';
        showFlash(flash, (priorOk ? priorOk + ' ' : '') + note + '.', true);
        showToast(note + '.', true);
      }
      settleSearchAfterAction(id, 'approved');
      loadLogs();
    } catch (e) {
      var errMsg = friendlyReason(e.message) || String(e);
      showFlash(flash, errMsg, false);
      showToast(errMsg, false, toastTitle ? { title: toastTitle } : undefined);
    }
  }

  async function approveProposal(id) {
    var select = document.querySelector('select.deploy-type[data-id="' + id + '"]');
    var deploymentType = select ? select.value : defaultDeploy;
    var diff = proposalDiffCache[id];
    var p = cachedProposals.filter(function (x) { return x.id === id; })[0];
    if (diff && diff.baseRevStale) {
      showToast('This proposal is out of date. Ask the AI to resubmit.', false);
      return;
    }
    if (needsApproveConfirm(diff, p)) {
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
    var pBefore = cachedProposals.filter(function (x) { return x.id === id; })[0];
    var toastTitle = proposalToastTitle(pBefore);
    try {
      await api('/proposals/' + encodeURIComponent(id) + '/reject', {
        method: 'POST',
        body: JSON.stringify({ reason: reason })
      });
      delete proposalDiffCache[id];
      if (!silent) {
        var okMsg = dismissed ? 'Proposal dismissed.' : 'Proposal rejected.';
        showFlash(flash, okMsg + (toastTitle ? ' — ' + toastTitle : ''), true);
        showToast(okMsg, true, {
          title: toastTitle,
          href: proposalViewHref(id),
          linkLabel: 'View'
        });
        await loadProposals({ skipRender: true });
        updatePendingBadges();
        notifySidebarPendingRefresh();
        settleSearchAfterAction(id, 'rejected');
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
      // Need proposals (+ diffs) so audit rows use the same render-time titles.
      if (!cachedProposals.length) {
        try { await loadProposals(); } catch (e) { /* best-effort */ }
      }
      if (canManage) {
        try { await loadLinks(); } catch (e) { /* best-effort for link label lookup */ }
      }
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
      // Prefetch diffs for proposal ids referenced in the log so titles refresh.
      cachedLogs.forEach(function (e) {
        var pid = e.details && e.details.proposalId;
        if (pid && lookupCachedProposal(pid) && !proposalDiffCache[pid]) {
          loadProposalDiff(pid);
        }
      });
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
    // Diagnostics "Your role" row: human Node-RED permission, not AI scope.
    var roleEl = $('status-role');
    if (roleEl) {
      var roleLabel = s.permission === '*'
        ? 'Admin (can approve & manage links)'
        : s.permission === 'read'
          ? 'Read-only'
          : (s.permission ? String(s.permission) : 'limited');
      roleEl.textContent = roleLabel;
      roleEl.title =
        'This is your Node-RED permission. AI access links can only read flows and propose changes — they cannot deploy.';
    }

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
      ? 'Review changes from your AI assistant. Each card shows a short id (first 8 hex after prop-; click to copy the full id). Approve & deploy makes them live; Reject leaves the flow unchanged; Dismiss closes out-of-date items.'
      : 'Approve, reject, and dismiss require full admin permission (*). You can still review proposals. Short ids are the first 8 hex characters after prop- (click to copy the full id).';

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

  function clearDialogPending(dialog) {
    if (!dialog) return;
    if (dialog.id === 'reject-dialog') pendingRejectId = null;
    if (dialog.id === 'delete-confirm-dialog') pendingApproveCtx = null;
    if (dialog.id === 'confirm-dialog') pendingConfirmAction = null;
  }

  function enhanceInPageDialog(dialog) {
    if (!dialog || dialog.getAttribute('data-dialog-enhanced')) return;
    dialog.setAttribute('data-dialog-enhanced', '1');
    // Backdrop click cancels (native <dialog> only closes on Esc by default).
    dialog.addEventListener('click', function (ev) {
      if (ev.target === dialog) {
        clearDialogPending(dialog);
        dialog.close();
      }
    });
    // Esc fires cancel before close — clear here so form submit is unaffected.
    dialog.addEventListener('cancel', function () {
      clearDialogPending(dialog);
    });
    dialog.addEventListener('keydown', function (ev) {
      trapDialogFocus(dialog, ev);
    });
  }

  function setupDialogs() {
    ['reject-dialog', 'delete-confirm-dialog', 'confirm-dialog'].forEach(function (id) {
      enhanceInPageDialog($(id));
    });

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
        if (pendingApproveCtx && pendingApproveCtx.requireDelete) {
          deleteBtn.disabled = deleteInput.value !== 'DELETE';
        } else {
          deleteBtn.disabled = false;
        }
      });
    }
    if (deleteForm) {
      deleteForm.addEventListener('submit', function (ev) {
        var submitter = ev.submitter || document.activeElement;
        var value = submitter && submitter.value ? submitter.value : '';
        if (value === 'confirm' && pendingApproveCtx) {
          var requireDelete = !!pendingApproveCtx.requireDelete;
          var typedOk = !requireDelete || (deleteInput && deleteInput.value === 'DELETE');
          if (typedOk) {
            doApproveProposal(pendingApproveCtx.id, pendingApproveCtx.deploymentType);
          }
        }
        pendingApproveCtx = null;
      });
    }
    var confirmForm = $('confirm-form');
    if (confirmForm) {
      confirmForm.addEventListener('submit', function (ev) {
        var submitter = ev.submitter || document.activeElement;
        var value = submitter && submitter.value ? submitter.value : '';
        var action = pendingConfirmAction;
        pendingConfirmAction = null;
        if (value === 'confirm' && action) action();
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
  var proposalsSearch = $('proposals-search');
  if (proposalsSearch) {
    proposalsSearch.addEventListener('input', function () {
      proposalsSearchQuery = String(proposalsSearch.value || '');
      renderProposalsList();
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
    pageClientScriptPartB2Actions() +
    pageClientScriptPartB2Cards() +
    pageClientScriptPartB2CardsList() +
    pageClientScriptPartB2Focus() +
    pageClientScriptPartB2Apply() +
    pageClientScriptPartC() +
    pageClientScriptPartCLogs() +
    pageClientScriptPartD() +
    pageClientScriptPartDBoot()
  ).trim();
}
