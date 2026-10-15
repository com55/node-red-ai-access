/** Inline client script for the /mcp admin page (editor localStorage Bearer). */

function pageClientScriptPartA(): string {
  return `
(function () {
  var root = document.getElementById('mcp-root');
  if (!root) return;
  var cfg = JSON.parse(root.getAttribute('data-config') || '{}');
  var apiBase = cfg.apiBase || '/mcp/api/v1';
  var editorRoot = cfg.editorRoot || '/';
  var authTokenKey = cfg.authTokenKey || 'auth-tokens';
  var canManage = false;
  var canApprove = false;
  var aiOn = false;
  var defaultTtl = 86400;
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
      '<div id="token-once" class="token-once" hidden><strong>Token (shown once)</strong><code id="token-value"></code></div>';
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
      $('token-value').textContent = created.token;
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

  function renderNodeRef(n) {
    var label = (n.name ? esc(n.name) + ' · ' : '') + esc(n.type || '?');
    return '<li><code title="' + esc(n.id) + '">' + tipId(n.id, 8) + '</code> ' + label + '</li>';
  }

  function renderPropertyChange(ch) {
    if (ch.kind === 'text') {
      var lines = (ch.lines || []).map(function (line) {
        var cls = line.op === 'add' ? 'diff-add' : line.op === 'remove' ? 'diff-remove' : 'diff-eq';
        var prefix = line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' ';
        return '<div class="' + cls + '">' + esc(prefix + line.text) + '</div>';
      }).join('');
      return '<div class="prop-change"><strong>' + esc(ch.key) + '</strong>' +
        '<div class="diff-block" role="region" aria-label="Line diff for ' + esc(ch.key) + '">' +
        lines + '</div></div>';
    }
    return '<div class="prop-change"><strong>' + esc(ch.key) + '</strong>: ' +
      '<code class="diff-before" title="before">' + esc(JSON.stringify(ch.before)) + '</code>' +
      ' → <code class="diff-after" title="after">' + esc(JSON.stringify(ch.after)) + '</code></div>';
  }

  function renderDiffView(diff) {
    if (!diff) return '<p class="muted">Diff unavailable.</p>';
    var stale = diff.baseRevStale
      ? '<p class="stale-banner" role="status">Base revision is stale — approve would fail. Ask the AI to re-read flows and resubmit.</p>'
      : '';
    var sum = diff.summary || {};
    var counts = '<p class="diff-summary"><strong>+' + (sum.added || 0) +
      '</strong> added · <strong>-' + (sum.removed || 0) +
      '</strong> removed · <strong>~' + (sum.modified || 0) +
      '</strong> modified' +
      (sum.tabChanges && sum.tabChanges.length
        ? ' · tab: ' + esc(sum.tabChanges.join(', '))
        : '') +
      '</p>';
    var meta = '<p class="muted">expectedRev ' + tipId(diff.expectedRev, 8) +
      ' · currentRev ' + tipId(diff.currentRev, 8) + '</p>';
    var sections = '';
    if (diff.added && diff.added.length) {
      sections += '<div class="diff-section"><h4>Added nodes</h4><ul>' +
        diff.added.map(renderNodeRef).join('') + '</ul></div>';
    }
    if (diff.removed && diff.removed.length) {
      sections += '<div class="diff-section"><h4>Removed nodes</h4><ul>' +
        diff.removed.map(renderNodeRef).join('') + '</ul></div>';
    }
    if (diff.modified && diff.modified.length) {
      sections += '<div class="diff-section"><h4>Modified nodes</h4>' +
        diff.modified.map(function (m) {
          return '<div class="modified-node">' +
            '<div><code title="' + esc(m.id) + '">' + tipId(m.id, 8) + '</code> ' +
            (m.name ? esc(m.name) + ' · ' : '') + esc(m.type || '?') + '</div>' +
            (m.changes || []).map(renderPropertyChange).join('') +
            '</div>';
        }).join('') + '</div>';
    }
    if (!sections) {
      sections = '<p class="muted">No node changes vs the current flow.</p>';
    }
    return stale + counts + meta + sections;
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

  async function loadProposalDiff(id) {
    var host = document.querySelector('.proposal-diff[data-diff-for="' + id + '"]');
    if (!host) return;
    try {
      var diff = await api('/proposals/' + encodeURIComponent(id) + '/diff');
      host.innerHTML = renderDiffView(diff);
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
          '<td class="col-action"><code>' + esc(e.action) + '</code></td>' +
          '<td class="col-actor">' + actorLabel(e.actor) + '</td>' +
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
              (a === current ? ' selected' : '') + '>' + esc(a) + '</option>';
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
    defaultTtl = s.defaultLinkTtlSeconds || 86400;
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
    pageClientScriptPartB2() +
    pageClientScriptPartC() +
    pageClientScriptPartD()
  ).trim();
}
