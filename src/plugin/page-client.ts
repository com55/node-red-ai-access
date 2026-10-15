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
    if (res.status === 401) {
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

  boot();
})();
`;
}

export function pageClientScript(): string {
  return (
    pageClientScriptPartA() +
    pageClientScriptPartA2() +
    pageClientScriptPartB() +
    pageClientScriptPartC() +
    pageClientScriptPartD()
  ).trim();
}
