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

    function hoursFromSeconds(seconds) {
      var s = Number(seconds);
      if (!Number.isFinite(s) || s <= 0) return 4;
      return Math.max(1, Math.round(s / 3600));
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
      if ([1, 4, 24].indexOf(h) < 0) h = 4;
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

    function loadSettings() {
      setFlash($('#ai-access-flash'), '', true);
      api('/settings')
        .then(function (data) {
          applyForm(data);
          refreshPending();
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
      if (!CAN_EDIT || saving) return;
      var payload = {
        enabled: $('#ai-access-enabled').is(':checked'),
        allowWithoutAdminAuth: $('#ai-access-allow-without').is(':checked'),
        defaultLinkTtlSeconds: Math.max(1, Math.floor(selectedTtlHours() * 3600)),
        defaultDeploymentType: $('#ai-access-deploy').val(),
      };
      saving = true;
      api('/settings', { method: 'PUT', body: JSON.stringify(payload) })
        .then(function (data) {
          applyForm(data);
          if (silent) showSavedToast();
          else setFlash($('#ai-access-flash'), 'Settings saved.', true);
          refreshPending();
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

      $('#ai-access-enabled, #ai-access-allow-without, #ai-access-deploy').on(
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
