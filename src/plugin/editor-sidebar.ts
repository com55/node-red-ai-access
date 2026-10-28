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
  position: relative;
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
#red-ui-sidebar-ai-access .ai-access-oauth-warning {
  color: #9b2c2c;
  background: #fdf0f0;
  border: 1px solid #f0c4c4;
  border-radius: 4px;
  padding: 8px 10px;
  margin: 8px 0 4px;
  line-height: 1.4;
}
#red-ui-sidebar-ai-access .ai-access-oauth-warning p {
  margin: 0 0 4px;
}
#red-ui-sidebar-ai-access .ai-access-oauth-warning ul {
  margin: 0 0 6px 18px;
  padding: 0;
}
#red-ui-sidebar-ai-access .ai-access-oauth-warning li {
  margin: 2px 0;
  overflow-wrap: anywhere;
}
#red-ui-sidebar-ai-access .ai-access-oauth-warning code {
  font-family: var(--red-ui-monospace-font, monospace);
  color: var(--red-ui-primary-text-color, #333);
  background: rgba(0, 0, 0, 0.06);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 0.95em;
  overflow-wrap: anywhere;
  word-break: break-all;
  white-space: normal;
}
#red-ui-sidebar-ai-access .ai-access-oauth-warning a {
  text-decoration: underline;
  cursor: pointer;
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
#red-ui-sidebar-ai-access .red-ui-settings-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 5px 0 2px;
}
#red-ui-sidebar-ai-access .red-ui-settings-row label {
  display: inline-block;
  min-width: 0;
  flex: 1 1 auto;
}
#red-ui-sidebar-ai-access .red-ui-settings-row label p {
  margin: 0 0 2px;
  font-weight: 600;
}
#red-ui-sidebar-ai-access .ai-access-actions {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}
#red-ui-sidebar-ai-access .ai-access-actions .red-ui-button {
  margin: 0;
  white-space: nowrap;
}
#red-ui-sidebar-ai-access .ai-access-muted {
  color: var(--red-ui-secondary-text-color, #888);
  font-size: 0.85em;
  line-height: 1.35;
  margin: 0;
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
   * Since 0.2.0-beta.3 the sidebar holds only: the AI Access toggle, the MCP
   * OAuth toggle, the OAuth route-conflict warning (with RED.view.reveal links),
   * and a button opening the dashboard (<httpAdminRoot>/ai-access). Every other
   * setting lives on the dashboard.
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

    function adminRoot() {
      var root = RED.settings.httpAdminRoot || '/';
      return !root || root === '/' ? '' : root.replace(/\\/$/, '');
    }

    function resolveApiBase() {
      if (!API_BASE) API_BASE = adminRoot() + '/mcp/api/v1';
      return API_BASE;
    }

    function dashboardUrl(hash) {
      var url = (LAST && LAST.mcpPageUrl) || adminRoot() + '/ai-access';
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
      var allowBtn = document.getElementById('ai-access-dialog-allow');
      if (allowBtn && allowBtn.focus) allowBtn.focus();
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

    function applyForm(data) {
      LAST = data;
      CAN_EDIT = !!(data && data.canEdit);
      ADMIN_AUTH = !!(data && data.adminAuthEnabled);
      var s = (data && data.settings) || {};
      var sources = (data && data.sources) || {};
      var readonly = !CAN_EDIT;

      $('#ai-access-enabled').prop('checked', s.enabled !== false)
        .prop('disabled', readonly || sources.enabled === 'settings.js');
      $('#ai-access-allow-without').prop('checked', !!s.allowWithoutAdminAuth)
        .prop('disabled', readonly || sources.allowWithoutAdminAuth === 'settings.js');
      $('#ai-access-adminauth-row').toggle(ADMIN_AUTH);
      $('#ai-access-local-row').toggle(!ADMIN_AUTH);

      var oauth = s.oauth || {};
      $('#ai-access-oauth-enabled').prop('checked', !!oauth.enabled)
        .prop('disabled', readonly || sources.oauth === 'settings.js');
      $('#ai-access-readonly-note').toggle(readonly);
      $('#ai-access-lock-enabled').toggle(sources.enabled === 'settings.js');
      $('#ai-access-lock-allow-without').toggle(sources.allowWithoutAdminAuth === 'settings.js');
      $('#ai-access-oauth-lock').toggle(sources.oauth === 'settings.js');
    }

    function refreshOAuth() {
      api('/oauth/status').then(function (status) {
        renderRouteWarning(status);
      }).catch(function () {
        $('#ai-access-oauth-route-warning').empty().hide();
      });
    }

    function collisionItem(c) {
      var li = $('<li></li>');
      var effect = c.kind === 'authorization' ? ' — OAuth login/token routes disabled' : ' — OAuth metadata disabled';
      if (c.source === 'http-in') {
        $('<span></span>').text('Route ').appendTo(li);
        $('<code></code>').text(c.path).appendTo(li);
        $('<span></span>').text(' is already used by http-in node ').appendTo(li);
        var label = "'" + (c.nodeName || c.nodeId || 'unnamed') + "'";
        if (c.nodeId && RED.view && RED.view.reveal) {
          $('<a href="#"></a>').text(label).attr('title', 'Show node in the editor').appendTo(li)
            .on('click', function (e) { e.preventDefault(); RED.view.reveal(c.nodeId); });
        } else {
          $('<span></span>').text(label).appendTo(li);
        }
      } else if (c.source === 'httpStatic') {
        $('<span></span>').text('File ').appendTo(li);
        $('<code></code>').text(c.path).appendTo(li);
        $('<span></span>').text(' is served by httpStatic').appendTo(li);
      } else if (c.source === 'middleware') {
        $('<span></span>').text('Path ').appendTo(li);
        $('<code></code>').text(c.path).appendTo(li);
        $('<span></span>').text(' is already handled by other middleware (' + (c.layer || 'unknown') + ')').appendTo(li);
      } else {
        $('<span></span>').text('Route ').appendTo(li);
        $('<code></code>').text(c.path).appendTo(li);
        $('<span></span>').text(' is already registered by another node or plugin').appendTo(li);
      }
      $('<span></span>').text(effect).appendTo(li);
      return li;
    }

    // Only shown when real conflicts exist (spec: sidebar item 3).
    function renderRouteWarning(status) {
      var box = $('#ai-access-oauth-route-warning').empty();
      var details = status.details;
      if (!details) {
        details = [];
        (status.authorization || []).forEach(function (t) { details.push({ kind: 'authorization', source: 'text', text: t }); });
        (status.metadata || []).forEach(function (t) { details.push({ kind: 'metadata', source: 'text', text: t }); });
      }
      if (details.length) {
        var intro = $('<p></p>').appendTo(box);
        $('<strong></strong>').text('OAuth route conflict').appendTo(intro);
        $('<span></span>').text(': these paths are already in use, so AI Access will not serve them. Remove or change the conflicting routes, then deploy.').appendTo(intro);
        var ul = $('<ul></ul>').appendTo(box);
        details.forEach(function (c) {
          if (c.source === 'text') $('<li></li>').text(c.text).appendTo(ul);
          else collisionItem(c).appendTo(ul);
        });
      }
      box.toggle(!!details.length);
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

    function loadSettings() {
      setFlash($('#ai-access-flash'), '', true);
      api('/settings')
        .then(function (data) {
          applyForm(data);
          refreshOAuth();
        })
        .catch(function (err) {
          setFlash($('#ai-access-flash'), err.message || String(err), false);
        });
    }

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

    // Partial PUT: only the toggles the sidebar owns (server merges the rest).
    function saveSettings() {
      if (!CAN_EDIT || saving || dialogOpen) return;
      var sources = (LAST && LAST.sources) || {};
      var payload = {};
      if (sources.enabled !== 'settings.js') payload.enabled = $('#ai-access-enabled').is(':checked');
      if (sources.allowWithoutAdminAuth !== 'settings.js') payload.allowWithoutAdminAuth = $('#ai-access-allow-without').is(':checked');
      if (sources.oauth !== 'settings.js') payload.oauth = { enabled: $('#ai-access-oauth-enabled').is(':checked') };
      if (LAST && LAST.settings && !(LAST.settings.oauth && LAST.settings.oauth.enabled) && payload.oauth && payload.oauth.enabled) {
        var warning = oauthPublicUrlWarning(LAST.settings.publicBaseUrl);
        if (warning) {
          openConfirmDialog(warning + '\\n\\nEnable OAuth anyway? (Set the Public URL on the AI Access dashboard.)').then(function (accepted) {
            if (accepted) persistSettings(payload);
            else $('#ai-access-oauth-enabled').prop('checked', false);
          });
          return;
        }
      }
      persistSettings(payload);
    }

    function persistSettings(payload) {
      saving = true;
      api('/settings', { method: 'PUT', body: JSON.stringify(payload) })
        .then(function (data) {
          applyForm(data);
          showSavedToast();
          refreshOAuth();
        })
        .catch(function (err) {
          setFlash($('#ai-access-flash'), err.message || String(err), false);
          loadSettings();
        })
        .then(function () {
          saving = false;
        });
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
      var dialog = $('<div id="ai-access-dialog" class="ai-access-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-access-dialog-title" style="display:none"></div>').appendTo(content);
      $('<h3 id="ai-access-dialog-title"></h3>').text('Confirm OAuth action').appendTo(dialog);
      $('<p id="ai-access-dialog-message"></p>').appendTo(dialog);
      var dialogActions = $('<div class="ai-access-dialog-actions"></div>').appendTo(dialog);
      $('<button type="button" id="ai-access-dialog-cancel" class="red-ui-button"></button>').text('Cancel').appendTo(dialogActions);
      $('<button type="button" id="ai-access-dialog-allow" class="red-ui-button"></button>').text('Continue').appendTo(dialogActions);

      $('<div class="red-ui-settings-section-description"></div>')
        .text('Changes apply immediately. Tokens, proposals, and all other settings are on the AI Access dashboard.')
        .appendTo(body);

      $('<p id="ai-access-readonly-note" class="form-tips" style="display:none;"></p>')
        .text('Read-only: full admin permission (*) is required to change these settings.')
        .appendTo(body);

      var row;

      // (1) Enable AI Access features (with adminAuth) / local-only opt-in (without).
      row = $('<div class="red-ui-settings-row" id="ai-access-adminauth-row"></div>').appendTo(body);
      $('<input id="ai-access-enabled" type="checkbox">').appendTo(row);
      $('<label for="ai-access-enabled"></label>')
        .html(
          '<p>Enable AI Access features</p>When off, access tokens, proposals, and AI tools are disabled.'
        )
        .appendTo(row);
      $('<span id="ai-access-lock-enabled" class="form-tips" style="display:none"></span>')
        .text('🔒 settings.js').appendTo(row);

      row = $(
        '<div class="red-ui-settings-row" id="ai-access-local-row" style="display:none;"></div>'
      ).appendTo(body);
      $('<input id="ai-access-allow-without" type="checkbox">').appendTo(row);
      $('<label for="ai-access-allow-without"></label>')
        .html(
          '<p>Enable AI Access features without adminAuth (local-only)</p>Not for production. Anyone who can reach the editor admin port can use AI features.'
        )
        .appendTo(row);
      $('<span id="ai-access-lock-allow-without" class="form-tips" style="display:none"></span>')
        .text('🔒 settings.js').appendTo(row);

      // (2) Enable MCP OAuth.
      row = $('<div class="red-ui-settings-row"></div>').appendTo(body);
      $('<input id="ai-access-oauth-enabled" type="checkbox">').appendTo(row);
      $('<label for="ai-access-oauth-enabled"></label>')
        .html('<p>Enable MCP OAuth</p>MCP clients (ChatGPT, Claude, …) sign in at &lt;Public URL&gt;/mcp.')
        .appendTo(row);
      $('<span id="ai-access-oauth-lock" class="form-tips" style="display:none"></span>')
        .text('🔒 settings.js').appendTo(row);

      // (3) OAuth route conflict warning — only rendered when conflicts exist.
      $('<div id="ai-access-oauth-route-warning" class="form-tips ai-access-oauth-warning" role="status" style="display:none"></div>').appendTo(body);

      content.find('#ai-access-enabled, #ai-access-allow-without, #ai-access-oauth-enabled').on(
        'change',
        saveSettings
      );

      // (4) Open the dashboard.
      row = $('<div class="ai-access-actions"></div>').appendTo(body);
      $('<button type="button" id="ai-access-open-mcp" class="red-ui-button"></button>')
        .text('Open AI Access dashboard')
        .appendTo(row)
        .on('click', function () {
          window.open(dashboardUrl(), '_blank');
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

/**
 * Editor-side reveal listener for dashboard jump links. Same-origin only
 * (BroadcastChannel). Reveals a node/group (RED.view.reveal) or shows a
 * flow/subflow tab (RED.workspaces.show) and acks so the dashboard does not
 * open another editor tab. Ids are looked up in RED.nodes; nothing else runs.
 */
export function editorRevealListenerScript(): string {
  return `(function () {
  if (typeof RED === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  if (window.__com55AiAccessRevealListener) return;
  window.__com55AiAccessRevealListener = true;
  try { if (!window.name) window.name = 'node-red-editor'; } catch (e) {}
  var ch = new BroadcastChannel('node-red-ai-access');
  ch.onmessage = function (ev) {
    var m = ev && ev.data;
    if (!m || m.type !== 'reveal' || typeof m.id !== 'string' || m.id.length > 200) return;
    var ok = false;
    try {
      if (m.kind === 'flow') {
        if ((RED.nodes.workspace && RED.nodes.workspace(m.id)) || (RED.nodes.subflow && RED.nodes.subflow(m.id))) {
          RED.workspaces.show(m.id);
          ok = true;
        }
      } else if (RED.nodes.node(m.id) || (RED.nodes.group && RED.nodes.group(m.id))) {
        RED.view.reveal(m.id);
        ok = true;
      }
    } catch (e) { ok = false; }
    ch.postMessage({ type: 'reveal-ack', reqId: m.reqId, ok: ok });
    if (ok) { try { window.focus(); } catch (e) {} }
  };
})();`;
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
    editorRevealListenerScript(),
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
