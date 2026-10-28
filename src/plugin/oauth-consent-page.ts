/**
 * HTML for the MCP OAuth consent / sign-in page. Self-contained (no external
 * assets), served with a nonce-based CSP. Every dynamic value is HTML-escaped.
 */

export interface ConsentPageInput {
  requestId: string;
  tokenKey: string;
  /** httpAdminRoot with exactly one trailing slash (e.g. `/` or `/admin/`). */
  adminRoot: string;
  nonce: string;
  redirectHost: string;
  loopbackRedirect: boolean;
  clientName: string;
  scopes: string[];
  script: string;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

const ICONS: Record<string, string> = {
  read: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"/></svg>',
  propose:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8L4 17.2Zm13.7-7.6a1 1 0 0 0 0-1.4l-1.9-1.9a1 1 0 0 0-1.4 0l-1.4 1.4 2.8 2.8 1.9-1.9Z"/></svg>',
};

const SCOPE_TEXT: Record<string, [string, string]> = {
  read: ['Read your flows', 'View flows, nodes, node types and AI Access logs.'],
  propose: [
    'Propose flow changes',
    'Submit change proposals. Nothing is deployed until you approve it in Node-RED.',
  ],
};

const LOGO =
  '<svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="11" fill="#8f0000"/>' +
  '<path d="M11 15h9a4 4 0 0 1 4 4v10a4 4 0 0 0 4 4h9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
  '<rect x="6" y="11" width="9" height="8" rx="2.5" fill="#fff"/><rect x="33" y="29" width="9" height="8" rx="2.5" fill="#fff"/>' +
  '<circle cx="37.5" cy="16" r="5" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M37.5 13.5v5M35 16h5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';

export const CONSENT_PAGE_STYLES = `
:root{color-scheme:light dark;--bg:#f3f4f6;--card:#fff;--text:#111827;--muted:#4b5563;--line:#e5e7eb;--soft:#f9fafb;--brand:#8f0000;--brand-2:#b91c1c;--ok:#0f766e;--warn-bg:#fff7ed;--warn:#9a3412;--focus:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f14;--card:#151b23;--text:#e5e7eb;--muted:#9ca3af;--line:#273140;--soft:#1b2330;--brand:#c0262d;--brand-2:#ef4444;--warn-bg:#2a1a0e;--warn:#fdba74;--focus:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);overflow:hidden}
.head{display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid var(--line)}
.logo{width:40px;height:40px;flex:none}
.brand b{display:block;font-size:15px}.brand span{font-size:13px;color:var(--muted)}
.body{padding:20px 22px 22px}
h1{font-size:19px;line-height:1.3;margin:0 0 6px}
.app{font-weight:700;overflow-wrap:anywhere}
.sub{margin:0 0 14px;color:var(--muted);font-size:14px}
.host{display:inline-block;font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere}
.warn{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:8px 10px;font-size:13px;margin:0 0 14px}
.perms{list-style:none;margin:0 0 14px;padding:0;border:1px solid var(--line);border-radius:12px}
.perms li{display:flex;gap:12px;padding:12px 14px}.perms li+li{border-top:1px solid var(--line)}
.perms svg{width:22px;height:22px;flex:none;fill:var(--brand-2);margin-top:2px}
.perms b{display:block;font-size:14px}.perms span{color:var(--muted);font-size:13px}
.perms li.dropped{opacity:.55}.perms li.dropped b::after{content:" — not granted";font-weight:400;color:var(--warn)}
.user{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);margin:0 0 16px}
.avatar{width:26px;height:26px;border-radius:50%;background:var(--soft);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--text);text-transform:uppercase}
.status{font-size:14px;color:var(--muted);margin:0 0 14px}.status.error{color:var(--brand-2)}
.actions{display:flex;gap:10px}
button{font:inherit;border-radius:10px;padding:10px 16px;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--text)}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
button[disabled]{opacity:.6;cursor:default}
.primary{flex:1;background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
.primary:hover:not([disabled]){background:var(--brand-2)}
.secondary{flex:none}
form.login{display:grid;gap:10px;margin:0 0 4px}
form.login label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
form.login input{font:inherit;padding:9px 11px;border-radius:10px;border:1px solid var(--line);background:var(--soft);color:var(--text)}
.foot{padding:12px 22px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);background:var(--soft)}
a{color:var(--focus)}
[hidden]{display:none!important}
@media (max-width:420px){.actions{flex-direction:column-reverse}.secondary{flex:1}}
`;

export function renderConsentPage(input: ConsentPageInput): string {
  const perms = input.scopes
    .map(scope => {
      const [title, desc] = SCOPE_TEXT[scope] ?? [scope, ''];
      return (
        `<li data-scope="${esc(scope)}">${ICONS[scope] ?? ICONS.read}` +
        `<div><b>${esc(title)}</b><span>${esc(desc)}</span></div></li>`
      );
    })
    .join('');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>Authorize MCP client · Node-RED AI Access</title>` +
    `<style>${CONSENT_PAGE_STYLES}</style></head><body>` +
    `<main class="card" data-request="${esc(input.requestId)}" data-token-key="${esc(input.tokenKey)}" data-admin-root="${esc(input.adminRoot)}">` +
    `<div class="head">${LOGO}<div class="brand"><b>Node-RED AI Access</b><span>Authorization request</span></div></div>` +
    `<div class="body">` +
    // The redirect host is what really receives tokens, so it leads; the client name is unverified.
    `<h1><span class="app">${esc(input.redirectHost)}</span> wants to access your Node-RED</h1>` +
    `<p class="sub">Access tokens will be sent to <span class="host">${esc(input.redirectHost)}</span>. ` +
    `App name (provided by the client, unverified): <b>${esc(input.clientName)}</b></p>${
      input.loopbackRedirect
        ? '<p class="warn">Warning: this redirect address is reachable only on this machine.</p>'
        : ''
    }<ul class="perms" aria-label="Requested permissions">${perms}</ul>` +
    `<p id="status" class="status" role="status" aria-live="polite">Checking your Node-RED session…</p>` +
    `<form id="login" class="login" hidden autocomplete="on">` +
    `<label>Username<input id="username" name="username" autocomplete="username" required></label>` +
    `<label>Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>` +
    `<div class="actions"><button id="login-submit" class="primary" type="submit">Sign in</button></div>` +
    `</form>` +
    `<p id="grant" class="sub" hidden></p>` +
    `<p id="user" class="user" hidden><span class="avatar" id="avatar" aria-hidden="true"></span><span>Signed in as <b id="username-label"></b></span></p>` +
    `<div class="actions"><button id="deny" class="secondary" type="button" hidden>Deny</button>` +
    `<button id="allow" class="primary" type="button" hidden>Allow access</button>` +
    `<button id="retry" class="secondary" type="button" hidden>Retry</button></div>` +
    `</div>` +
    `<div class="foot">You can revoke this app at any time from the AI Access dashboard (OAuth tab) in Node-RED.</div>` +
    `</main><script nonce="${esc(input.nonce)}">${input.script}</script></body></html>`
  );
}
