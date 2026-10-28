/**
 * Editor sidebar AI Access tab — script + styles served from
 * GET /mcp/editor/ai-access-sidebar.js (Cache-Control: no-store).
 *
 * Companion `ai-access.html` is a thin loader that injects this file with a
 * cache-bust query so Node-RED's cached companion HTML no longer freezes UX.
 */

import { packageVersion } from './package-version.js';

/** Derived from package.json via build-time `__AI_ACCESS_VERSION__` (not hand-typed). */
export const EDITOR_SIDEBAR_ASSET_VERSION = packageVersion();

function editorSidebarStyles(): string {
  return `#red-ui-sidebar-ai-access {
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}
#red-ui-sidebar-ai-access .red-ui-sidebar-header {
  text-align: left;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
#red-ui-sidebar-ai-access .red-ui-sidebar-header .ai-access-refresh-link {
  font-weight: 400;
  font-size: 0.85em;
  flex: 0 0 auto;
  white-space: nowrap;
}
#red-ui-sidebar-ai-access .red-ui-sidebar-ai-access-body {
  position: relative;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 10px 12px 16px;
  box-sizing: border-box;
}
#red-ui-sidebar-ai-access .red-ui-settings-section-description {
  color: var(--red-ui-secondary-text-color, #666);
  margin-bottom: 10px;
  line-height: 1.4;
}
#red-ui-sidebar-ai-access .ai-access-status-block {
  margin: 0 0 12px;
  padding: 8px 10px;
  background: var(--red-ui-secondary-background, #f3f3f3);
  border-radius: 4px;
}
#red-ui-sidebar-ai-access .ai-access-status-block p {
  margin: 0 0 6px;
}
#red-ui-sidebar-ai-access .ai-access-oauth-warning {
  color: #9b2c2c;
  white-space: pre-wrap;
}
#red-ui-sidebar-ai-access .ai-access-oauth-client {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--red-ui-secondary-border-color, #ddd);
}
#red-ui-sidebar-ai-access .ai-access-oauth-client span {
  overflow-wrap: anywhere;
}
#red-ui-sidebar-ai-access .ai-access-dialog {
  position: absolute;
  inset: 0;
  z-index: 10;
  padding: 18px;
  background: var(--red-ui-primary-background, #fff);
}
#red-ui-sidebar-ai-access .ai-access-dialog-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
#red-ui-sidebar-ai-access .ai-access-ttl-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}
#red-ui-sidebar-ai-access .ai-access-ttl-presets button[aria-pressed='true'] {
  font-weight: 700;
  border-color: var(--red-ui-form-input-focus-color, #999);
}
#red-ui-sidebar-ai-access .red-ui-settings-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 5px 0 2px;
}
#red-ui-sidebar-ai-access .ai-access-public-url-controls {
  display: flex;
  gap: 6px;
}
#red-ui-sidebar-ai-access .ai-access-public-url-controls input {
  flex: 1;
  min-width: 0;
}
#red-ui-sidebar-ai-access .ai-access-public-url-controls button {
  flex: 0 0 auto;
}
#red-ui-sidebar-ai-access .ai-access-actions {
  margin-top: 12px;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
}
#red-ui-sidebar-ai-access .ai-access-actions .red-ui-button {
  margin: 0;
  flex: 1 1 auto;
  white-space: nowrap;
}
#red-ui-sidebar-ai-access .red-ui-settings-row.stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
#red-ui-sidebar-ai-access .red-ui-settings-row label {
  display: inline-block;
  min-width: 0;
  flex: 1 1 auto;
}
#red-ui-sidebar-ai-access .red-ui-settings-row.stacked label {
  flex: none;
  width: 100%;
}
#red-ui-sidebar-ai-access .red-ui-settings-row.stacked input,
#red-ui-sidebar-ai-access .red-ui-settings-row.stacked select {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
#red-ui-sidebar-ai-access .red-ui-settings-row label p {
  margin: 0 0 2px;
  font-weight: 600;
}
/* Compact toast in the header — must not cover the intro description. */
#red-ui-sidebar-ai-access #ai-access-flash {
  flex: 0 1 auto;
  margin: 0;
  padding: 0;
  max-width: 9rem;
  border: 0;
  border-radius: 4px;
  box-sizing: border-box;
  background: transparent;
  color: inherit;
  font-weight: 500;
  font-size: 0.85em;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-2px);
  transition: opacity 0.35s ease, transform 0.35s ease, visibility 0.35s;
}
#red-ui-sidebar-ai-access #ai-access-flash.is-visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
  padding: 3px 8px;
}
#red-ui-sidebar-ai-access #ai-access-flash.ok {
  color: #1b6b4a;
  background: #e8f6ef;
}
#red-ui-sidebar-ai-access #ai-access-flash.error {
  color: #9b2c2c;
  background: #fdecec;
}
/* After fade: strip chrome so no empty green/red outline remains. */
#red-ui-sidebar-ai-access #ai-access-flash:not(.is-visible) {
  padding: 0;
  border: 0;
  background: transparent;
  color: transparent;
}`;
}

function editorSidebarScriptPartA(): string {
  return `
  /**
   * Editor right-hand sidebar tab: AI Access.
   * Served from /mcp/editor/ai-access-sidebar.js (no-store + ?v= cache-bust).
   *
   * RED.sidebar.addTab (Node-RED 4.x):
   * - id, label, name, iconClass, content (jQuery/DOM), onchange, action
   */
  (function () {
    if (typeof RED === 'undefined' || !RED.sidebar || !RED.sidebar.addTab) {
      return;
    }
    if (typeof $ === 'undefined') {
      return;
    }
    if (window.__com55AiAccessSidebarLoaded) {
      return;
    }
    window.__com55AiAccessSidebarLoaded = true;

    var TAB_ID = 'ai-access';
    var CONTENT_ID = 'red-ui-sidebar-ai-access';
    var API_BASE = null;
    var CAN_EDIT = false;
    var ADMIN_AUTH = true;
    var LAST = null;
    var dialogOpen = false;
    var FIELD_IDS = {
      enabled: 'enabled', allowWithoutAdminAuth: 'allow-without',
      defaultLinkTtlSeconds: 'ttl', defaultDeploymentType: 'deploy',
      maxActiveLinks: 'max-links', publicBaseUrl: 'public-url',
      corsAllowedOrigins: 'cors', rateLimitWindowMs: 'rate-window',
      rateLimitMaxPerIp: 'rate-ip', rateLimitMaxPerToken: 'rate-token'
    };

    function authHeaders() {
      var headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      try {
        var key = 'auth-tokens';
        var root = (RED.settings.httpAdminRoot || '/').replace(/\\/$/, '');
        if (root && root !== '/') {
          key = 'auth-tokens' + root.replace(/\\//g, '-');
        }
        var raw = localStorage.getItem(key);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && parsed.access_token) {
            headers.Authorization = 'Bearer ' + parsed.access_token;
          }
        }
      } catch (e) {
        /* ignore */
      }
      return headers;
    }

    function resolveApiBase() {
      if (API_BASE) return API_BASE;
      var root = RED.settings.httpAdminRoot || '/';
      if (!root || root === '/') {
        API_BASE = '/mcp/api/v1';
      } else {
        API_BASE = root.replace(/\\/$/, '') + '/mcp/api/v1';
      }
      return API_BASE;
    }

    function mcpPageUrl(hash) {
      var url = (LAST && LAST.mcpPageUrl) || '/mcp';
      if (hash) {
        return url.split('#')[0] + '#' + hash.replace(/^#/, '');
      }
      return url;
    }

    function api(path, options) {
      return fetch(
        resolveApiBase() + path,
        Object.assign(
          {
            credentials: 'same-origin',
            headers: authHeaders(),
          },
          options || {}
        )
      ).then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch (e) {
              body = { error: text };
            }
          }
          if (!res.ok) {
            var err = new Error((body && body.error) || 'HTTP ' + res.status);
            err.status = res.status;
            err.body = body;
            throw err;
          }
          return body;
        });
      });
    }

    function setFlash($el, message, ok) {
      if (!$el || !$el.length) return;
      var text = message ? String(message) : '';
      if (!text) {
        // Fade out first; clear ok/error chrome after transition so no empty box remains.
        $el.removeClass('is-visible');
        $el.text('');
        window.setTimeout(function () {
          if ($el.hasClass('is-visible')) return;
          $el.removeClass('ok error');
        }, 400);
        return;
      }
      $el.toggleClass('ok', !!ok).toggleClass('error', !ok);
      $el.text(text);
      $el.addClass('is-visible');
    }

    function openConfirmDialog(message) {
      if (dialogOpen) return Promise.resolve(false);
      dialogOpen = true;
      $('#ai-access-dialog-message').text(message);
      $('#ai-access-dialog').show();
      return new Promise(function (resolve) {
        function finish(accepted) {
          $('#ai-access-dialog').hide();
          $('#ai-access-dialog-allow').off('click');
          $('#ai-access-dialog-cancel').off('click');
          dialogOpen = false;
          resolve(accepted);
        }
        $('#ai-access-dialog-allow').on('click', function () { finish(true); });
        $('#ai-access-dialog-cancel').on('click', function () { finish(false); });
      });
    }

    function hoursFromSeconds(seconds) {
      var s = Number(seconds);
      if (!Number.isFinite(s) || s <= 0) return 4;
      return Math.round(s / 3600);
    }

    function selectedTtlHours() {
      var pressed = $('#' + CONTENT_ID + ' .ai-access-ttl-presets button[aria-pressed="true"]');
      if (pressed.length) {
        return Number(pressed.attr('data-hours')) || 4;
      }
      return Number($('#ai-access-ttl').val()) || 4;
    }

    function setTtlHours(hours) {
      var h = Number(hours);
      if (!Number.isFinite(h) || h <= 0) h = 4;
      $('#ai-access-ttl').val(h);
      $('#' + CONTENT_ID + ' .ai-access-ttl-presets button').each(function () {
        var btn = $(this);
        btn.attr('aria-pressed', Number(btn.attr('data-hours')) === h ? 'true' : 'false');
      });
    }

    function applyForm(data) {
      LAST = data;
      CAN_EDIT = !!(data && data.canEdit);
      ADMIN_AUTH = !!(data && data.adminAuthEnabled);
      var s = (data && data.settings) || {};

      $('#ai-access-enabled').prop('checked', s.enabled !== false);
      $('#ai-access-allow-without').prop('checked', !!s.allowWithoutAdminAuth);
      setTtlHours(hoursFromSeconds(s.defaultLinkTtlSeconds || 14400));
      $('#ai-access-deploy').val(s.defaultDeploymentType || 'nodes');
      $('#ai-access-full-warn').toggle($('#ai-access-deploy').val() === 'full');

      $('#ai-access-adminauth-row').toggle(ADMIN_AUTH);
      $('#ai-access-local-row').toggle(!ADMIN_AUTH);
      $('#ai-access-local-warn').toggle(!ADMIN_AUTH);

      var readonly = !CAN_EDIT;
      $('#' + CONTENT_ID + ' input, #' + CONTENT_ID + ' select').prop('disabled', readonly);
      $('#' + CONTENT_ID + ' .ai-access-ttl-presets button').prop('disabled', readonly);
      $('#ai-access-readonly-note').toggle(readonly);
      ['maxActiveLinks', 'publicBaseUrl', 'rateLimitWindowMs', 'rateLimitMaxPerIp', 'rateLimitMaxPerToken'].forEach(function (key) {
        $('#ai-access-' + FIELD_IDS[key]).val(s[key] == null ? '' : s[key]);
      });
      $('#ai-access-cors').val((s.corsAllowedOrigins || []).join(', '));
      $('#ai-access-trust-proxy').text(String(data.trustProxy));
      Object.keys(FIELD_IDS).forEach(function (key) {
        var locked = data.sources && data.sources[key] === 'settings.js';
        $('#ai-access-' + FIELD_IDS[key]).prop('disabled', readonly || locked);
        $('#ai-access-lock-' + FIELD_IDS[key]).toggle(!!locked);
      });
      $('#' + CONTENT_ID + ' .ai-access-ttl-presets button').prop('disabled', readonly || (data.sources && data.sources.defaultLinkTtlSeconds === 'settings.js'));
      $('#ai-access-check-public-url').prop('disabled', readonly);
      var oauth = s.oauth || {};
      $('#ai-access-oauth-enabled').prop('checked', !!oauth.enabled);
      setDuration('access-ttl', oauth.accessTokenTtlSec || 3600, OAUTH_ACCESS_UNITS);
      setDuration('refresh-ttl', oauth.refreshIdleTtlSec || 2592000, OAUTH_REFRESH_UNITS);
      $('#ai-access-oauth-refresh-max').val(Math.round((oauth.refreshMaxLifetimeSec || 0) / 86400));
      $('#ai-access-oauth-refresh-max-unit').val('days');
      $('#ai-access-oauth-dcr-cap').val(oauth.dcrMaxClients || 20);
      var oauthLocked = readonly || (data.sources && data.sources.oauth === 'settings.js');
      $('#ai-access-oauth-enabled, #ai-access-oauth-access-ttl, #ai-access-oauth-access-ttl-unit, #ai-access-oauth-refresh-ttl, #ai-access-oauth-refresh-ttl-unit, #ai-access-oauth-refresh-max, #ai-access-oauth-refresh-max-unit, #ai-access-oauth-dcr-cap').prop('disabled', oauthLocked);
      $('#ai-access-oauth-lock').toggle(!!(data.sources && data.sources.oauth === 'settings.js'));
    }

    var OAUTH_ACCESS_UNITS = [['minutes', 60, 'Minutes'], ['hours', 3600, 'Hours']];
    var OAUTH_REFRESH_UNITS = [['hours', 3600, 'Hours'], ['days', 86400, 'Days']];
    var OAUTH_MAX_UNITS = [['days', 86400, 'Days']];

    // Show seconds as the largest unit that divides them evenly (smallest unit otherwise).
    function setDuration(field, seconds, units) {
      var unit = units[0];
      for (var i = units.length - 1; i >= 0; i--) {
        if (seconds % units[i][1] === 0) { unit = units[i]; break; }
      }
      $('#ai-access-oauth-' + field).val(Math.max(1, Math.round(seconds / unit[1])));
      $('#ai-access-oauth-' + field + '-unit').val(unit[0]);
    }

    function readDuration(field, units) {
      var amount = Number($('#ai-access-oauth-' + field).val());
      var name = $('#ai-access-oauth-' + field + '-unit').val();
      var mult = units[0][1];
      units.forEach(function (u) { if (u[0] === name) mult = u[1]; });
      return Math.round(amount * mult);
    }

    function refreshOAuth() {
      api('/oauth/status').then(function (status) {
        var warnings = [];
        if (status.httpNodeRootFallback) warnings.push('httpNodeRoot is disabled: OAuth metadata is served under the admin /mcp path.');
        if (status.authorization && status.authorization.length) warnings.push('OAuth authorization routes collide with: ' + status.authorization.join(', '));
        if (status.metadata && status.metadata.length) warnings.push('OAuth metadata routes collide with: ' + status.metadata.join(', '));
        $('#ai-access-oauth-route-warning').text(warnings.join('\\n')).toggle(warnings.length > 0);
      }).catch(function (err) {
        $('#ai-access-oauth-route-warning').text('OAuth route status unavailable: ' + err.message).show();
      });
      api('/oauth/clients').then(function (data) {
        var list = $('#ai-access-oauth-clients').empty();
        var clients = (data && data.clients) || [];
        if (!clients.length) {
          $('<p></p>').text('No registered OAuth clients.').appendTo(list);
          return;
        }
        clients.forEach(function (client) {
          var row = $('<div class="ai-access-oauth-client"></div>').appendTo(list);
          $('<span></span>').text((client.client_name || 'Unnamed client') + ' (' + client.client_id + ')').appendTo(row);
          $('<button type="button" class="red-ui-button"></button>').text('Revoke').prop('disabled', !CAN_EDIT)
            .appendTo(row).on('click', function () {
              openConfirmDialog('Revoke OAuth client "' + (client.client_name || client.client_id) + '" and its tokens?')
                .then(function (accepted) {
                  if (!accepted) return;
                  api('/oauth/clients/' + encodeURIComponent(client.client_id), { method: 'DELETE' })
                    .then(function () { setFlash($('#ai-access-flash'), 'OAuth client revoked.', true); refreshOAuth(); })
                    .catch(function (err) { setFlash($('#ai-access-flash'), err.message || String(err), false); });
                });
            });
        });
      }).catch(function (err) {
        $('#ai-access-oauth-clients').text('OAuth clients unavailable: ' + err.message);
      });
    }

    function oauthPublicUrlWarning(value) {
      if (!value) return 'No Public URL is configured. OAuth clients may not discover this server.';
      try {
        var url = new URL(value);
        var host = url.hostname.toLowerCase();
        if (host.endsWith('.')) host = host.slice(0, -1);
        if (url.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return '';
        return 'The Public URL does not use HTTPS. OAuth tokens and redirects may be exposed.';
      } catch (e) {
        return 'The Public URL is invalid. OAuth clients may not discover this server.';
      }
    }

    function formatPendingBadge(live, stale) {
      var parts = [];
      if (live > 0) parts.push(live + ' to review');
      if (stale > 0) parts.push(stale + ' out of date');
      return parts.length ? parts.join(' · ') : '0';
    }

    function pendingSidebarText(live, stale, total) {
      if (total === 0) return '0 proposals waiting for review';
      if (total === 1 && stale === 0) return '1 proposal to review';
      return formatPendingBadge(live, stale);
    }

    function refreshPending() {
      api('/proposals')
        .then(function (data) {
          var proposals = (data && data.proposals) || [];
          var pending = proposals.filter(function (p) {
            return p.status === 'pending';
          });
          var stale = pending.filter(function (p) {
            return !!p.baseRevStale;
          }).length;
          var live = pending.length - stale;
          $('#ai-access-pending-line').text(pendingSidebarText(live, stale, pending.length));
          $('#ai-access-status-block').show();
        })
        .catch(function () {
          $('#ai-access-pending-line').text('—');
        });
    }

    // /mcp page posts here after approve so the sidebar badge updates immediately.
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        var pendingChannel = new BroadcastChannel('ai-access-pending');
        pendingChannel.onmessage = function (ev) {
          if (ev && ev.data && ev.data.type === 'refresh-pending') {
            refreshPending();
          }
        };
      }
    } catch (e) {
      /* ignore */
    }

    function loadSettings() {
      setFlash($('#ai-access-flash'), '', true);
      api('/settings')
        .then(function (data) {
          applyForm(data);
          refreshPending();
          refreshOAuth();
        })
        .catch(function (err) {
          setFlash($('#ai-access-flash'), err.message || String(err), false);
        });
    }

    var saveTimer = null;
    var saving = false;

    var savedToastTimer = null;

    function showSavedToast() {
      var $flash = $('#ai-access-flash');
      setFlash($flash, 'Saved', true);
      if (savedToastTimer) clearTimeout(savedToastTimer);
      savedToastTimer = setTimeout(function () {
        savedToastTimer = null;
        setFlash($flash, '', true);
      }, 2000);
    }

    function saveSettings(opts) {
      var silent = !!(opts && opts.silent);
      if (!CAN_EDIT || saving || dialogOpen) return;
      var payload = {
        enabled: $('#ai-access-enabled').is(':checked'),
        allowWithoutAdminAuth: $('#ai-access-allow-without').is(':checked'),
        defaultLinkTtlSeconds: Math.max(1, Math.floor(selectedTtlHours() * 3600)),
        defaultDeploymentType: $('#ai-access-deploy').val(),
        maxActiveLinks: Number($('#ai-access-max-links').val()),
        publicBaseUrl: String($('#ai-access-public-url').val()).trim(),
        corsAllowedOrigins: String($('#ai-access-cors').val()).split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        rateLimitWindowMs: Number($('#ai-access-rate-window').val()),
        rateLimitMaxPerIp: Number($('#ai-access-rate-ip').val()),
        rateLimitMaxPerToken: Number($('#ai-access-rate-token').val()),
        oauth: {
          enabled: $('#ai-access-oauth-enabled').is(':checked'),
          accessTokenTtlSec: readDuration('access-ttl', OAUTH_ACCESS_UNITS),
          refreshIdleTtlSec: readDuration('refresh-ttl', OAUTH_REFRESH_UNITS),
          refreshMaxLifetimeSec: readDuration('refresh-max', OAUTH_MAX_UNITS),
          dcrMaxClients: Number($('#ai-access-oauth-dcr-cap').val()),
        },
      };
      Object.keys(payload).forEach(function (key) {
        if (LAST && LAST.sources && LAST.sources[key] === 'settings.js') delete payload[key];
      });
      if (LAST && LAST.settings && !(LAST.settings.oauth && LAST.settings.oauth.enabled) && payload.oauth && payload.oauth.enabled) {
        var warning = oauthPublicUrlWarning(payload.publicBaseUrl === undefined ? LAST.settings.publicBaseUrl : payload.publicBaseUrl);
        if (warning) {
          openConfirmDialog(warning + '\\n\\nEnable OAuth anyway?').then(function (accepted) {
            if (accepted) persistSettings(payload, silent);
            else $('#ai-access-oauth-enabled').prop('checked', false);
          });
          return;
        }
      }
      persistSettings(payload, silent);
    }

    function persistSettings(payload, silent) {
      saving = true;
      api('/settings', { method: 'PUT', body: JSON.stringify(payload) })
        .then(function (data) {
          applyForm(data);
          if (data.warnings && data.warnings.length) {
            $('#ai-access-check-result').text(data.warnings.join(' '));
          }
          if (silent) showSavedToast();
          else setFlash($('#ai-access-flash'), 'Settings saved.', true);
          refreshPending();
          refreshOAuth();
        })
        .catch(function (err) {
          setFlash($('#ai-access-flash'), err.message || String(err), false);
        })
        .then(function () {
          saving = false;
        });
    }

    function scheduleAutoSave() {
      if (!CAN_EDIT) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        saveSettings({ silent: true });
      }, 400);
    }
`;
}

function editorSidebarScriptPartB(): string {
  return `
    function buildContent() {
      var content = $('<div></div>', { id: CONTENT_ID, class: 'red-ui-sidebar-ai-access' });

      var header = $('<div class="red-ui-sidebar-header"></div>').appendTo(content);
      $('<span></span>').text('AI Access').appendTo(header);
      // Saved/error toast lives in the header so it never covers the intro text.
      $('<div id="ai-access-flash" aria-live="polite"></div>').appendTo(header);
      $('<button type="button" id="ai-access-refresh" class="red-ui-button ai-access-refresh-link"></button>')
        .text('Refresh')
        .appendTo(header)
        .on('click', loadSettings);

      var body = $('<div class="red-ui-sidebar-ai-access-body"></div>').appendTo(content);
      var dialog = $('<div id="ai-access-dialog" class="ai-access-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-access-dialog-title" style="display:none"></div>').appendTo(body);
      $('<h3 id="ai-access-dialog-title"></h3>').text('Confirm OAuth action').appendTo(dialog);
      $('<p id="ai-access-dialog-message"></p>').appendTo(dialog);
      var dialogActions = $('<div class="ai-access-dialog-actions"></div>').appendTo(dialog);
      $('<button type="button" id="ai-access-dialog-cancel" class="red-ui-button"></button>').text('Cancel').appendTo(dialogActions);
      $('<button type="button" id="ai-access-dialog-allow" class="red-ui-button"></button>').text('Continue').appendTo(dialogActions);

      $('<div class="red-ui-settings-section-description"></div>')
        .text('Configure temporary AI access features. Changes apply immediately (no restart).')
        .appendTo(body);

      $('<p id="ai-access-readonly-note" class="form-tips" style="display:none;"></p>')
        .text('Read-only: full admin permission (*) is required to change these settings.')
        .appendTo(body);

      var status = $(
        '<div id="ai-access-status-block" class="ai-access-status-block" style="display:none;"></div>'
      ).appendTo(body);
      $('<p id="ai-access-pending-line"></p>')
        .text('0 proposals waiting for review')
        .appendTo(status);
      $('<button type="button" id="ai-access-review" class="red-ui-button"></button>')
        .text('Review')
        .appendTo(status)
        .on('click', function () {
          window.open(mcpPageUrl('proposals'), '_blank');
        });

      var row;

      row = $('<div class="red-ui-settings-row" id="ai-access-adminauth-row"></div>').appendTo(body);
      $('<input id="ai-access-enabled" type="checkbox">').appendTo(row);
      $('<label for="ai-access-enabled"></label>')
        .html(
          '<p>Enable AI Access features</p>When off, access links, proposals, and AI tools are disabled.'
        )
        .appendTo(row);

      row = $(
        '<div class="red-ui-settings-row" id="ai-access-local-row" style="display:none;"></div>'
      ).appendTo(body);
      $('<input id="ai-access-allow-without" type="checkbox">').appendTo(row);
      $('<label for="ai-access-allow-without"></label>')
        .html(
          '<p>Allow AI Access without adminAuth (local-only)</p>Not for production. Anyone who can reach the editor admin port can use AI features.'
        )
        .appendTo(row);

      $('<div id="ai-access-local-warn" class="form-tips" style="display:none;color:#b33;"></div>')
        .text(
          'Warning: adminAuth is disabled. Enabling this opt-in exposes AI Access without login.'
        )
        .appendTo(body);

      row = $('<div class="red-ui-settings-row stacked"></div>').appendTo(body);
      $('<label for="ai-access-deploy"></label>').text('Default deploy type').appendTo(row);
      var select = $('<select id="ai-access-deploy"></select>').appendTo(row);
      $('<option value="nodes">Only changed nodes (recommended)</option>').appendTo(select);
      $('<option value="flows">Changed flows</option>').appendTo(select);
      $('<option value="full">Full redeploy</option>').appendTo(select);
      $('<p id="ai-access-full-warn" class="form-tips" style="display:none;color:#b33;"></p>')
        .text('Warning: full restarts the entire runtime.')
        .appendTo(row);
      select.on('change', function () {
        $('#ai-access-full-warn').toggle(select.val() === 'full');
      });

      row = $('<div class="red-ui-settings-row stacked"></div>').appendTo(body);
      $('<label for="ai-access-ttl"></label>').text('Default link expiry').appendTo(row);
      var presets = $(
        '<div class="ai-access-ttl-presets" role="group" aria-label="Link expiry"></div>'
      ).appendTo(row);
      [1, 4, 24].forEach(function (h) {
        $('<button type="button" class="red-ui-button"></button>')
          .attr('data-hours', String(h))
          .attr('aria-pressed', h === 4 ? 'true' : 'false')
          .text(h === 1 ? '1 hour' : h + ' hours')
          .appendTo(presets)
          .on('click', function () {
            setTtlHours(h);
            scheduleAutoSave();
          });
      });
      $('<input id="ai-access-ttl" type="hidden" value="4">').appendTo(row);

      [
        ['max-links', 'Maximum active links', 'number'],
        ['public-url', 'Public URL (HTTPS origin)', 'text'],
        ['cors', 'CORS allowed origins (comma separated)', 'text'],
        ['rate-window', 'Rate limit window (ms)', 'number'],
        ['rate-ip', 'Requests per IP per window', 'number'],
        ['rate-token', 'Requests per token per window', 'number']
      ].forEach(function (field) {
        var id = 'ai-access-' + field[0];
        var fieldRow = $('<div class="red-ui-settings-row stacked"></div>').appendTo(body);
        $('<label></label>').attr('for', id).text(field[1]).appendTo(fieldRow);
        var controls = field[0] === 'public-url' ? $('<div class="ai-access-public-url-controls"></div>').appendTo(fieldRow) : fieldRow;
        var input = $('<input>').attr('id', id).attr('type', field[2]).appendTo(controls);
        if (field[2] === 'number') input.attr('min', '1').attr('step', 'any');
        input.on('change', scheduleAutoSave);
        if (field[0] === 'public-url') {
          $('<button type="button" id="ai-access-check-public-url" class="red-ui-button"></button>')
            .text('Check').appendTo(controls).on('click', function () {
              $('#ai-access-check-result').text('Checking…');
              api('/settings/check-public-url', { method: 'POST', body: JSON.stringify({ publicBaseUrl: $('#ai-access-public-url').val() }) })
                .then(function (result) {
                  $('#ai-access-check-result').text((result.ok ? 'OK: ' : 'Failed: ') + (result.message || result.error) + (result.status ? ' (HTTP ' + result.status + ')' : ''));
                }).catch(function (err) { $('#ai-access-check-result').text(err.message); });
            });
          $('<p class="form-tips"></p>').text("Loopback checks use Node-RED's listening port; behind a reverse proxy, use the internal port. Unix-socket listeners are not supported. HTTPS checks fail with self-signed certificates.").appendTo(fieldRow);
          $('<p id="ai-access-check-result" aria-live="polite"></p>').appendTo(fieldRow);
        }
      });
      var trustRow = $('<div class="red-ui-settings-row stacked"></div>').appendTo(body);
      $('<label></label>').text('Express trust proxy (read-only)').appendTo(trustRow);
      $('<span id="ai-access-trust-proxy"></span>').appendTo(trustRow);
      $('<h3></h3>').text('MCP OAuth').appendTo(body);
      $('<p class="form-tips"></p>').text('Clients can request read or propose access through OAuth. Changes apply immediately.').appendTo(body);
      row = $('<div class="red-ui-settings-row"></div>').appendTo(body);
      $('<input id="ai-access-oauth-enabled" type="checkbox">').appendTo(row);
      $('<label for="ai-access-oauth-enabled"></label>').text('Enable MCP OAuth').appendTo(row);
      $('<span id="ai-access-oauth-lock" class="form-tips" style="display:none"></span>')
        .text('🔒 Locked by settings.js').appendTo(row);
      [
        ['access-ttl', 'Access token lifetime', OAUTH_ACCESS_UNITS],
        ['refresh-ttl', 'Refresh token idle lifetime', OAUTH_REFRESH_UNITS],
        ['refresh-max', 'Refresh token max lifetime (0 = unlimited, default)', OAUTH_MAX_UNITS],
        ['dcr-cap', 'Maximum registered OAuth clients', null]
      ].forEach(function (field) {
        var id = 'ai-access-oauth-' + field[0];
        var oauthRow = $('<div class="red-ui-settings-row stacked"></div>').appendTo(body);
        $('<label></label>').attr('for', id).text(field[1]).appendTo(oauthRow);
        $('<input type="number" step="1" style="width:80px">').attr('id', id).attr('min', field[0] === 'refresh-max' ? 0 : 1).appendTo(oauthRow).on('change', scheduleAutoSave);
        if (!field[2]) return;
        var select = $('<select></select>').attr('id', id + '-unit').attr('aria-label', field[1] + ' unit')
          .appendTo(oauthRow).on('change', scheduleAutoSave);
        field[2].forEach(function (u) { $('<option></option>').attr('value', u[0]).text(u[2]).appendTo(select); });
      });
      $('<p id="ai-access-oauth-route-warning" class="form-tips ai-access-oauth-warning" role="status" style="display:none"></p>').appendTo(body);
      $('<h4></h4>').text('Registered OAuth clients').appendTo(body);
      $('<div id="ai-access-oauth-clients" aria-live="polite"></div>').appendTo(body);
      Object.keys(FIELD_IDS).forEach(function (key) {
        var id = FIELD_IDS[key];
        $('<span class="form-tips" style="display:none"></span>')
          .attr('id', 'ai-access-lock-' + id).text('🔒 Locked by settings.js')
          .appendTo(content.find('#ai-access-' + id).closest('.red-ui-settings-row'));
      });

      content.find('#ai-access-enabled, #ai-access-allow-without, #ai-access-deploy, #ai-access-oauth-enabled').on(
        'change',
        scheduleAutoSave
      );

      row = $('<div class="red-ui-settings-row ai-access-actions"></div>').appendTo(body);
      $('<button type="button" id="ai-access-open-mcp" class="red-ui-button"></button>')
        .text('Open AI Access dashboard')
        .appendTo(row)
        .on('click', function () {
          window.open(mcpPageUrl(), '_blank');
        });

      return content;
    }

    var content = buildContent();

    RED.actions.add('com55:show-ai-access-tab', function () {
      RED.sidebar.show(TAB_ID);
    });

    RED.sidebar.addTab({
      id: TAB_ID,
      label: 'AI Access',
      name: 'AI Access',
      iconClass: 'fa fa-plug',
      content: content,
      enableOnEdit: true,
      action: 'com55:show-ai-access-tab',
      onchange: function () {
        loadSettings();
      },
    });
  })();
`;
}

function editorSidebarScriptBody(): string {
  return editorSidebarScriptPartA() + editorSidebarScriptPartB();
}

/** Full JS payload for GET /mcp/editor/ai-access-sidebar.js (injects CSS, then runs tab). */
export function renderEditorSidebarJs(): string {
  const css = JSON.stringify(editorSidebarStyles());
  return [
    `/* @com55/node-red-ai-access editor sidebar v=${EDITOR_SIDEBAR_ASSET_VERSION} */`,
    `(function(){`,
    `  if (typeof document === 'undefined') return;`,
    `  if (!document.getElementById('com55-ai-access-sidebar-css')) {`,
    `    var style = document.createElement('style');`,
    `    style.id = 'com55-ai-access-sidebar-css';`,
    `    style.textContent = ${css};`,
    `    document.head.appendChild(style);`,
    `  }`,
    `})();`,
    editorSidebarScriptBody(),
  ].join('\n');
}

/**
 * Thin companion HTML loader. Version is always {@link EDITOR_SIDEBAR_ASSET_VERSION}
 * (from package.json) — never hand-typed in a second place.
 */
export function renderEditorSidebarLoaderHtml(
  version: string = EDITOR_SIDEBAR_ASSET_VERSION
): string {
  const safeVersion = version.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `<script>
  /**
   * Thin loader for the AI Access editor sidebar.
   * Logic lives at GET /mcp/editor/ai-access-sidebar.js (Cache-Control: no-store)
   * so companion-HTML caching does not freeze sidebar UX across plugin updates.
   * Asset version is derived from package.json at build time.
   */
  (function () {
    if (typeof RED === 'undefined' || !RED.sidebar || !RED.sidebar.addTab) {
      return;
    }
    if (window.__com55AiAccessSidebarLoading) {
      return;
    }
    window.__com55AiAccessSidebarLoading = true;

    var EDITOR_SIDEBAR_ASSET_VERSION = '${safeVersion}';
    var root = (RED.settings.httpAdminRoot || '/').replace(/\\/$/, '');
    var src =
      (root || '') +
      '/mcp/editor/ai-access-sidebar.js?v=' +
      encodeURIComponent(EDITOR_SIDEBAR_ASSET_VERSION);

    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onerror = function () {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[ai-access] failed to load sidebar script:', src);
      }
    };
    (document.head || document.documentElement).appendChild(s);
  })();
</script>
`;
}
