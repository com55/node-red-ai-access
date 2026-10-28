/**
 * Browser script for the OAuth consent page (served with a CSP nonce).
 * Reads the Node-RED editor token from localStorage (same origin as the editor)
 * and talks to `consent/:id` with Bearer auth. When signed out and Node-RED uses
 * credentials login, it shows an inline sign-in form that obtains an editor token
 * from `<httpAdminRoot>/auth/token` (same flow as the editor) via fetch.
 * All dynamic text is set with textContent.
 */
export const consentScript = `(function () {
  var main = document.querySelector('main');
  var id = main.getAttribute('data-request');
  var key = main.getAttribute('data-token-key');
  var $ = function (x) { return document.getElementById(x); };
  var status = $('status'), grant = $('grant'), allow = $('allow'), deny = $('deny'), retry = $('retry');
  var login = $('login'), user = $('user');
  var adminRoot = new URL('../../', window.location.href);
  var csrf = null;
  function headers() {
    var h = { 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2' };
    try {
      var t = JSON.parse(localStorage.getItem(key) || 'null');
      if (t && t.access_token) h.Authorization = 'Bearer ' + t.access_token;
    } catch (e) {}
    return h;
  }
  function show(el, on) { el.hidden = !on; }
  function setStatus(text, isError) {
    status.textContent = text;
    status.className = 'status' + (isError ? ' error' : '');
    show(status, !!text);
  }
  function editorLink(prefix, suffix) {
    status.textContent = '';
    status.className = 'status';
    status.append(prefix);
    var a = document.createElement('a');
    a.href = adminRoot.href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Node-RED editor';
    status.append(a, suffix);
    show(status, true);
  }
  function showSignIn() {
    show(allow, false); show(deny, false); show(user, false); show(grant, false);
    fetch(new URL('auth/login', adminRoot).href, { headers: { 'Node-RED-API-Version': 'v2' }, credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (cfg && cfg.type === 'credentials') {
          setStatus('Sign in with your Node-RED account to continue.');
          show(login, true);
          $('username').focus();
        } else {
          editorLink('Sign in to the ', ' in this browser, then press Retry.');
          show(retry, true);
        }
      })
      .catch(function () {
        editorLink('Sign in to the ', ' in this browser, then press Retry.');
        show(retry, true);
      });
  }
  function load() {
    show(retry, false); show(login, false);
    setStatus('Checking your Node-RED session…');
    fetch('consent/' + encodeURIComponent(id), { headers: headers(), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        if (x.r.status === 401) { showSignIn(); return; }
        if (!x.r.ok) { setStatus(x.b.error || ('Error ' + x.r.status), true); return; }
        csrf = x.b.csrf;
        setStatus('');
        $('username-label').textContent = String(x.b.user);
        $('avatar').textContent = String(x.b.user || '?').charAt(0);
        show(user, true);
        var dropped = x.b.requested.filter(function (s) { return x.b.grantable.indexOf(s) < 0; });
        document.querySelectorAll('.perms li').forEach(function (li) {
          li.classList.toggle('dropped', dropped.indexOf(li.getAttribute('data-scope')) >= 0);
        });
        grant.textContent = 'Will grant: ' + x.b.grantable.join(', ') +
          (dropped.length ? ' (your Node-RED permission does not allow: ' + dropped.join(', ') + ')' : '');
        show(grant, true); show(allow, true); show(deny, true);
        allow.focus();
      })
      .catch(function (e) { setStatus('Error: ' + e.message, true); show(retry, true); });
  }
  login.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('login-submit');
    btn.disabled = true;
    setStatus('Signing in…');
    var body = new URLSearchParams({
      client_id: 'node-red-editor', grant_type: 'password', scope: '*',
      username: $('username').value, password: $('password').value
    });
    fetch(new URL('auth/token', adminRoot).href, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Node-RED-API-Version': 'v2' },
      body: body.toString()
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        btn.disabled = false;
        $('password').value = '';
        if (!x.r.ok || !x.b.access_token) { setStatus('Sign in failed. Check your username and password.', true); return; }
        try { localStorage.setItem(key, JSON.stringify(x.b)); } catch (e) {}
        load();
      })
      .catch(function (e) { btn.disabled = false; setStatus('Error: ' + e.message, true); });
  });
  function decide(decision) {
    allow.disabled = deny.disabled = true;
    fetch('consent/' + encodeURIComponent(id), {
      method: 'POST', headers: headers(), credentials: 'same-origin',
      body: JSON.stringify({ csrf: csrf, decision: decision })
    })
      .then(function (r) { return r.json().then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        if (x.r.ok && x.b.redirect) { setStatus(decision === 'allow' ? 'Access allowed. Returning to the app…' : 'Access denied. Returning to the app…'); window.location.assign(x.b.redirect); }
        else { setStatus(x.b.error || ('Error ' + x.r.status), true); allow.disabled = deny.disabled = false; }
      })
      .catch(function (e) { setStatus('Error: ' + e.message, true); allow.disabled = deny.disabled = false; });
  }
  allow.addEventListener('click', function () { decide('allow'); });
  deny.addEventListener('click', function () { decide('deny'); });
  retry.addEventListener('click', load);
  load();
})();`;
