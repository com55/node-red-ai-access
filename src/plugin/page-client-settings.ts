/**
 * Dashboard Settings + OAuth tabs (moved from the editor sidebar in 0.2.0-beta.3).
 * Same REST endpoints and permission checks as the sidebar had:
 * GET /settings (admin session), PUT /settings + check-public-url (permission *),
 * GET /oauth/status, GET/DELETE /oauth/clients.
 *
 * All dynamic values are written via textContent / value / esc() — never raw HTML.
 */

function settingsPartForm(): string {
  return `
  var settingsData = null;
  var settingsSaving = false;
  var settingsTimer = null;
  var SETTINGS_FIELDS = {
    enabled: 'enabled', allowWithoutAdminAuth: 'allow-without',
    defaultLinkTtlSeconds: 'ttl', defaultDeploymentType: 'deploy',
    proposalTtlDays: 'proposal-ttl', maxActiveLinks: 'max-links', publicBaseUrl: 'public-url',
    corsAllowedOrigins: 'cors', rateLimitWindowMs: 'rate-window',
    rateLimitMaxPerIp: 'rate-ip', rateLimitMaxPerToken: 'rate-token'
  };
  var SECRET_PATTERN_RE = /^[A-Za-z0-9_-]{2,40}$/;
  var OAUTH_ACCESS_UNITS = [['minutes', 60], ['hours', 3600]];
  var OAUTH_REFRESH_UNITS = [['hours', 3600], ['days', 86400]];

  function settingsCanEdit() { return !!(settingsData && settingsData.canEdit); }
  function fieldLocked(key) {
    return !!(settingsData && settingsData.sources && settingsData.sources[key] === 'settings.js');
  }

  function setDurationInputs(id, seconds, units) {
    var unit = units[0];
    for (var i = units.length - 1; i >= 0; i--) {
      if (seconds % units[i][1] === 0) { unit = units[i]; break; }
    }
    $(id).value = String(Math.max(1, Math.round(seconds / unit[1])));
    $(id + '-unit').value = unit[0];
  }
  function readDurationInputs(id, units) {
    var amount = Number($(id).value);
    var name = $(id + '-unit') ? $(id + '-unit').value : units[0][0];
    var mult = units[0][1];
    units.forEach(function (u) { if (u[0] === name) mult = u[1]; });
    return Math.round(amount * mult);
  }

  function trustProxyText(tp) {
    return tp === false || tp === undefined || tp === null || tp === 0
      ? 'Trust proxy: off (set httpServerOptions["trust proxy"] in settings.js if behind a reverse proxy). Rate limits key on the socket address.'
      : 'Trust proxy: ' + (tp === true ? 'on' : String(tp)) + '. Rate limits key on the forwarded client address.';
  }

  function mcpServerUrl() {
    var s = (settingsData && settingsData.settings) || {};
    var base = s.publicBaseUrl ? String(s.publicBaseUrl).replace(/\\/$/, '') : location.origin;
    return base + mcpRpc.replace(/\\/rpc$/, '');
  }

  function applySettings(data) {
    settingsData = data;
    var s = data.settings || {};
    var ro = !data.canEdit;
    var adminAuth = !!data.adminAuthEnabled;
    $('settings-readonly').hidden = !ro;
    $('row-enabled').hidden = !adminAuth;
    $('row-allow-without').hidden = adminAuth;
    $('set-enabled').checked = s.enabled !== false;
    $('set-allow-without').checked = !!s.allowWithoutAdminAuth;
    $('set-deploy').value = s.defaultDeploymentType || 'nodes';
    $('set-deploy-full-warn').hidden = $('set-deploy').value !== 'full';
    $('set-ttl').value = String(Math.max(1, Math.round((s.defaultLinkTtlSeconds || 14400) / 3600)));
    $('set-proposal-ttl').value = String(s.proposalTtlDays == null ? 7 : s.proposalTtlDays);
    $('set-max-links').value = s.maxActiveLinks == null ? '' : String(s.maxActiveLinks);
    $('set-public-url').value = s.publicBaseUrl || '';
    $('set-cors').value = (s.corsAllowedOrigins || []).join(', ');
    $('set-rate-window').value = s.rateLimitWindowMs == null ? '' : String(s.rateLimitWindowMs);
    $('set-rate-ip').value = s.rateLimitMaxPerIp == null ? '' : String(s.rateLimitMaxPerIp);
    $('set-rate-token').value = s.rateLimitMaxPerToken == null ? '' : String(s.rateLimitMaxPerToken);
    var tpText = trustProxyText(data.trustProxy);
    $('set-trust-proxy').textContent = tpText;
    $('set-trust-proxy-inline').textContent = tpText;
    Object.keys(SETTINGS_FIELDS).forEach(function (key) {
      var id = SETTINGS_FIELDS[key];
      var locked = fieldLocked(key);
      var input = $('set-' + id);
      if (input) input.disabled = ro || locked;
      var badge = $('lock-' + id);
      if (badge) badge.hidden = !locked;
    });
    $('set-check-public-url').disabled = ro;
    renderSecretPatterns(data);

    var o = s.oauth || {};
    var oauthLocked = fieldLocked('oauth');
    $('oauth-enabled').checked = !!o.enabled;
    setDurationInputs('oauth-access-ttl', o.accessTokenTtlSec || 3600, OAUTH_ACCESS_UNITS);
    setDurationInputs('oauth-refresh-ttl', o.refreshIdleTtlSec || 2592000, OAUTH_REFRESH_UNITS);
    $('oauth-refresh-max').value = String(Math.round((typeof o.refreshMaxLifetimeSec === 'number' ? o.refreshMaxLifetimeSec : 7776000) / 86400));
    $('oauth-dcr-cap').value = String(o.dcrMaxClients || 5);
    ['oauth-enabled', 'oauth-access-ttl', 'oauth-access-ttl-unit', 'oauth-refresh-ttl', 'oauth-refresh-ttl-unit',
      'oauth-refresh-max', 'oauth-dcr-cap'].forEach(function (id) { $(id).disabled = ro || oauthLocked; });
    $('lock-oauth').hidden = !oauthLocked;
    $('oauth-server-url').textContent = mcpServerUrl();
  }

  function oauthEnableWarning(value) {
    if (!value) return 'No Public URL is configured. OAuth clients may not discover this server.';
    try {
      var url = new URL(value);
      var host = url.hostname.toLowerCase().replace(/\\.$/, '');
      if (url.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return '';
      return 'The Public URL does not use HTTPS. OAuth tokens and redirects may be exposed.';
    } catch (e) {
      return 'The Public URL is invalid. OAuth clients may not discover this server.';
    }
  }

  function collectSettingsPayload() {
    var payload = {
      enabled: $('set-enabled').checked,
      allowWithoutAdminAuth: $('set-allow-without').checked,
      defaultLinkTtlSeconds: Number($('set-ttl').value) * 3600,
      defaultDeploymentType: $('set-deploy').value,
      proposalTtlDays: Number($('set-proposal-ttl').value),
      maxActiveLinks: Number($('set-max-links').value),
      publicBaseUrl: String($('set-public-url').value).trim(),
      corsAllowedOrigins: String($('set-cors').value).split(',').map(function (x) { return x.trim(); }).filter(Boolean),
      rateLimitWindowMs: Number($('set-rate-window').value),
      rateLimitMaxPerIp: Number($('set-rate-ip').value),
      rateLimitMaxPerToken: Number($('set-rate-token').value),
      oauth: {
        enabled: $('oauth-enabled').checked,
        accessTokenTtlSec: readDurationInputs('oauth-access-ttl', OAUTH_ACCESS_UNITS),
        refreshIdleTtlSec: readDurationInputs('oauth-refresh-ttl', OAUTH_REFRESH_UNITS),
        refreshMaxLifetimeSec: Math.round(Number($('oauth-refresh-max').value) * 86400),
        dcrMaxClients: Number($('oauth-dcr-cap').value)
      }
    };
    Object.keys(payload).forEach(function (key) { if (fieldLocked(key)) delete payload[key]; });
    // Persist the max lifetime only when changed, so the default can evolve.
    var loaded = (settingsData && settingsData.settings && settingsData.settings.oauth) || {};
    var loadedMax = typeof loaded.refreshMaxLifetimeSec === 'number' ? loaded.refreshMaxLifetimeSec : 7776000;
    if (payload.oauth && Math.round(payload.oauth.refreshMaxLifetimeSec / 86400) === Math.round(loadedMax / 86400)) {
      delete payload.oauth.refreshMaxLifetimeSec;
    }
    return payload;
  }

`;
}

function settingsPartSecrets(): string {
  return `
  function secretPatternsEditable() {
    return settingsCanEdit() && !fieldLocked('secretNamePatterns');
  }

  // Chips are built with createElement/textContent only (pattern text is never HTML).
  function renderSecretPatterns(data) {
    var list = $('secret-patterns');
    var s = (data && data.settings) || {};
    var patterns = Array.isArray(s.secretNamePatterns) ? s.secretNamePatterns : [];
    var editable = secretPatternsEditable();
    var source = data && data.sources ? data.sources.secretNamePatterns : 'default';
    $('secret-patterns-source').textContent = source === 'settings.js' ? '(set in settings.js)'
      : source === 'disk' ? '(customized)' : '(defaults)';
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!patterns.length) {
      var empty = document.createElement('li');
      empty.className = 'chip-empty secret-patterns-empty-warning';
      empty.setAttribute('role', 'alert');
      empty.textContent = 'Warning: the pattern list is empty, so secrets are no longer redacted by ' +
        'name (env vars, password/token fields). Only known token formats are still hidden from AI. ' +
        'Use "Reset to defaults" to restore protection.';
      list.appendChild(empty);
    }
    patterns.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'chip';
      var label = document.createElement('code');
      label.textContent = String(p);
      li.appendChild(label);
      if (editable) {
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'chip-remove';
        rm.setAttribute('aria-label', 'Remove ' + String(p));
        rm.title = 'Remove';
        rm.textContent = '×';
        rm.addEventListener('click', function () {
          saveSecretPatterns(patterns.filter(function (x) { return x !== p; }));
        });
        li.appendChild(rm);
      }
      list.appendChild(li);
    });
    $('set-secret-new').disabled = !editable;
    $('set-secret-add').disabled = !editable;
    $('set-secret-reset').disabled = !editable || source !== 'disk';
    $('lock-secret-patterns').hidden = !fieldLocked('secretNamePatterns');
  }

  function currentSecretPatterns() {
    var s = (settingsData && settingsData.settings) || {};
    return Array.isArray(s.secretNamePatterns) ? s.secretNamePatterns.slice() : [];
  }

  function saveSecretPatterns(next) {
    if (!secretPatternsEditable() || settingsSaving) return;
    persistSettings({ secretNamePatterns: next });
  }

  function addSecretPattern() {
    var input = $('set-secret-new');
    var value = String(input.value || '').trim().toUpperCase();
    if (!value) return;
    if (!SECRET_PATTERN_RE.test(value)) {
      settingsFlash('Pattern must be 2-40 letters, digits, "_" or "-".', false);
      return;
    }
    var list = currentSecretPatterns();
    if (list.indexOf(value) !== -1) {
      settingsFlash('Pattern ' + value + ' is already in the list.', false);
      return;
    }
    list.push(value);
    input.value = '';
    saveSecretPatterns(list);
  }

  function resetSecretPatterns() {
    if (!secretPatternsEditable()) return;
    openConfirmDialog({
      title: 'Reset secret name patterns',
      message: 'Replace the list with the built-in defaults?',
      confirmLabel: 'Reset',
      onConfirm: function () { persistSettings({ secretNamePatterns: null }); }
    });
  }

`;
}

function settingsPartSave(): string {
  return `
  function settingsFlash(msg, ok) {
    var tab = document.querySelector('nav.tabs button[aria-current="page"]');
    var target = tab && tab.getAttribute('data-tab') === 'oauth' ? 'oauth-flash' : 'settings-flash';
    if (ok) showToast(msg, true);
    else showFlash($(target), msg, false);
  }

  async function persistSettings(payload) {
    settingsSaving = true;
    try {
      var data = await api('/settings', { method: 'PUT', body: JSON.stringify(payload) });
      applySettings(data);
      var warn = data.warnings && data.warnings.length ? data.warnings.join(' ') : '';
      $('set-public-url-warning').textContent = warn;
      $('set-public-url-warning').hidden = !warn;
      showFlash($('settings-flash'), '', true);
      showFlash($('oauth-flash'), '', true);
      settingsFlash('Settings saved.', true);
      refreshStatusQuiet();
      loadOAuthStatus();
    } catch (e) {
      settingsFlash(e.message || String(e), false);
    } finally {
      settingsSaving = false;
    }
  }

  function saveSettingsNow() {
    if (!settingsCanEdit() || settingsSaving) return;
    var fields = ['set-ttl', 'set-proposal-ttl', 'set-max-links', 'set-rate-window', 'set-rate-ip', 'set-rate-token',
      'oauth-access-ttl', 'oauth-refresh-ttl', 'oauth-refresh-max', 'oauth-dcr-cap'];
    for (var i = 0; i < fields.length; i++) {
      var input = $(fields[i]);
      if (!input || input.disabled) continue;
      var n = Number(input.value), min = Number(input.min || 0);
      var max = input.max ? Number(input.max) : Infinity;
      if (!input.value.trim() || !Number.isInteger(n) || n < min || n > max) {
        input.setAttribute('aria-invalid', 'true');
        settingsFlash('Enter a whole number with a minimum of ' + min + (max < Infinity ? ' and a maximum of ' + max : '') + '.', false);
        return;
      }
      input.removeAttribute('aria-invalid');
    }
    var payload = collectSettingsPayload();
    var was = settingsData && settingsData.settings && settingsData.settings.oauth && settingsData.settings.oauth.enabled;
    if (!was && payload.oauth && payload.oauth.enabled) {
      var url = payload.publicBaseUrl === undefined ? settingsData.settings.publicBaseUrl : payload.publicBaseUrl;
      var warning = oauthEnableWarning(url);
      if (warning) {
        $('oauth-enabled').checked = false;
        openConfirmDialog({
          title: 'Enable MCP OAuth?',
          message: warning + ' Enable OAuth anyway?',
          confirmLabel: 'Enable anyway',
          onConfirm: function () { $('oauth-enabled').checked = true; persistSettings(payload); }
        });
        return;
      }
    }
    persistSettings(payload);
  }

  function scheduleSettingsSave() {
    if (!settingsCanEdit()) return;
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(function () { settingsTimer = null; saveSettingsNow(); }, 400);
  }

  async function loadSettings() {
    try {
      applySettings(await api('/settings'));
    } catch (e) {
      settingsFlash(e.message || String(e), false);
    }
  }

  async function refreshStatusQuiet() {
    try { applyStatus(await api('/status')); } catch (e) { /* ignore */ }
  }

  function setCheckResult(state, text) {
    var el = $('set-check-result');
    el.className = 'check-result' + (state ? ' is-' + state : '');
    el.textContent = text || '';
    el.hidden = !text;
    el.setAttribute('role', state === 'fail' ? 'alert' : 'status');
  }

  async function checkPublicUrl() {
    setCheckResult('pending', 'Checking…');
    try {
      var r = await api('/settings/check-public-url', {
        method: 'POST', body: JSON.stringify({ publicBaseUrl: $('set-public-url').value })
      });
      setCheckResult(r.ok ? 'ok' : 'fail', (r.ok ? '✓ Reachable: ' : '✗ Failed: ') + (r.message || r.error || '') +
        (r.status ? ' (HTTP ' + r.status + ')' : ''));
    } catch (e) {
      setCheckResult('fail', '✗ ' + (e.message || String(e)));
    }
  }

`;
}

function settingsPartOAuth(): string {
  return `
  function editorNodeHref(c) {
    var base = editorRoot && editorRoot !== '/' ? editorRoot.replace(/\\/$/, '') + '/' : '/';
    if (c.nodeId) return base + '#node/' + encodeURIComponent(c.nodeId);
    if (c.flowId) return base + '#flow/' + encodeURIComponent(c.flowId);
    return '';
  }

  function collisionHtml(c) {
    var effect = c.kind === 'authorization' ? ' — OAuth login/token routes disabled' : ' — OAuth metadata disabled';
    var path = '<code>' + esc(c.path || '') + '</code>';
    var html;
    if (c.source === 'text') return esc(c.text || '');
    if (c.source === 'http-in') {
      var label = "'" + esc(c.nodeName || c.nodeId || 'unnamed') + "'";
      var href = editorNodeHref(c);
      html = 'Route ' + path + ' is already used by http-in node ' +
        (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener" title="Open node in the editor">' + label + '</a>' : label);
    } else if (c.source === 'httpStatic') {
      html = 'File ' + path + ' is served by httpStatic';
    } else if (c.source === 'middleware') {
      html = 'Path ' + path + ' is already handled by other middleware (' + esc(c.layer || 'unknown') + ')';
    } else {
      html = 'Route ' + path + ' is already registered by another node or plugin';
    }
    return html + esc(effect);
  }

  function renderOAuthRouteWarning(status) {
    var box = $('oauth-route-warning');
    var details = status.details;
    if (!details) {
      details = [];
      (status.authorization || []).forEach(function (t) { details.push({ kind: 'authorization', source: 'text', text: t }); });
      (status.metadata || []).forEach(function (t) { details.push({ kind: 'metadata', source: 'text', text: t }); });
    }
    var html = '';
    if (status.httpNodeRootFallback) {
      html += '<p>httpNodeRoot is disabled: OAuth metadata is served under the admin /mcp path.</p>';
    }
    if (details.length) {
      html += '<h2>OAuth route conflict</h2><p>These paths are already in use, so AI Access will not serve them. ' +
        'Remove or change the conflicting routes, then deploy.</p><ul class="conflict-list">' +
        details.map(function (c) { return '<li>' + collisionHtml(c) + '</li>'; }).join('') + '</ul>';
    }
    box.innerHTML = html;
    box.hidden = !html;
  }

  var oauthStatusGen = 0;
  var oauthClientsGen = 0;
  async function loadOAuthStatus() {
    var gen = ++oauthStatusGen;
    try {
      var st = await api('/oauth/status');
      if (gen !== oauthStatusGen) return; // superseded by a newer refresh
      renderOAuthRouteWarning(st);
    } catch (e) {
      var box = $('oauth-route-warning');
      box.textContent = 'OAuth route status unavailable: ' + (e.message || String(e));
      box.hidden = false;
    }
  }

  async function loadOAuthClients() {
    var list = $('oauth-clients');
    var gen = ++oauthClientsGen;
    try {
      var data = await api('/oauth/clients');
      if (gen !== oauthClientsGen) return;
      var clients = (data && data.clients) || [];
      if (!clients.length) {
        list.innerHTML = '<p class="muted">No registered OAuth clients.</p>';
        return;
      }
      var canRevoke = settingsCanEdit();
      list.innerHTML = clients.map(function (c, i) {
        return '<div class="client-row"><div><strong>' + esc(c.client_name || 'Unnamed client') + '</strong>' +
          '<div class="client-meta"><code>' + esc(c.client_id) + '</code></div></div>' +
          '<button type="button" class="action danger" data-oauth-revoke="' + i + '"' + (canRevoke ? '' : ' disabled') +
          '>Revoke</button></div>';
      }).join('');
      list.querySelectorAll('[data-oauth-revoke]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var c = clients[Number(btn.getAttribute('data-oauth-revoke'))];
          if (!c) return;
          openConfirmDialog({
            title: 'Revoke OAuth client',
            message: 'Revoke OAuth client "' + (c.client_name || c.client_id) + '" and all of its tokens?',
            confirmLabel: 'Revoke',
            danger: true,
            onConfirm: async function () {
              try {
                await api('/oauth/clients/' + encodeURIComponent(c.client_id), { method: 'DELETE' });
                showToast('OAuth client revoked.', true);
                loadOAuthClients();
              } catch (e) {
                showFlash($('oauth-flash'), e.message || String(e), false);
              }
            }
          });
        });
      });
    } catch (e) {
      list.textContent = 'OAuth clients unavailable: ' + (e.message || String(e));
    }
  }

`;
}

function settingsPartWire(): string {
  return `
  function loadOAuthTab() {
    loadSettings();
    loadOAuthStatus();
    loadOAuthClients();
  }

  (function wireSettings() {
    var sec = $('section-settings');
    var oauthSec = $('section-oauth');
    [sec, oauthSec].forEach(function (host) {
      if (!host) return;
      host.querySelectorAll('input, select').forEach(function (el) {
        if (el.id === 'set-public-url' || el.getAttribute('data-no-autosave')) return;
        el.addEventListener('change', scheduleSettingsSave);
      });
    });
    $('set-public-url').addEventListener('change', scheduleSettingsSave);
    $('set-deploy').addEventListener('change', function () {
      $('set-deploy-full-warn').hidden = $('set-deploy').value !== 'full';
    });
    $('set-check-public-url').addEventListener('click', checkPublicUrl);
    $('set-secret-add').addEventListener('click', addSecretPattern);
    $('set-secret-new').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); addSecretPattern(); }
    });
    $('set-secret-reset').addEventListener('click', resetSecretPatterns);
    $('oauth-refresh').addEventListener('click', function () { loadOAuthStatus(); loadOAuthClients(); });
    $('oauth-copy-url').addEventListener('click', function () {
      copyTextToClipboard($('oauth-server-url').textContent || '');
      showToast('Server URL copied.', true);
    });
  })();
`;
}

export function pageClientSettingsScript(): string {
  return (
    settingsPartForm() +
    settingsPartSecrets() +
    settingsPartSave() +
    settingsPartOAuth() +
    settingsPartWire()
  );
}
