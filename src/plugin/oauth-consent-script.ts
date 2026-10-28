/**
 * Browser script for the OAuth consent shell (served with a CSP nonce).
 * Reads the Node-RED editor token from localStorage (same origin as the editor)
 * and talks to `consent/:id` with Bearer auth.
 */
export const consentScript = `(function () {
  var main = document.querySelector('main');
  var id = main.getAttribute('data-request');
  var key = main.getAttribute('data-token-key');
  var status = document.getElementById('status');
  var grant = document.getElementById('grant');
  var allow = document.getElementById('allow');
  var deny = document.getElementById('deny');
  var retry = document.getElementById('retry');
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
  function load() {
    show(retry, false);
    status.textContent = 'Checking your Node-RED editor session…';
    fetch('consent/' + encodeURIComponent(id), { headers: headers(), credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        if (x.r.status === 401) {
          status.innerHTML = '';
          status.append('Sign in to the ');
          var a = document.createElement('a');
          a.href = '../../'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Node-RED editor';
          status.append(a, ' in this browser, then press Retry.');
          show(retry, true);
          return;
        }
        if (!x.r.ok) { status.textContent = x.b.error || ('Error ' + x.r.status); return; }
        csrf = x.b.csrf;
        status.textContent = 'Signed in as ' + x.b.user + '.';
        var dropped = x.b.requested.filter(function (s) { return x.b.grantable.indexOf(s) < 0; });
        grant.textContent = 'Will grant: ' + x.b.grantable.join(', ') +
          (dropped.length ? ' (not granted, your permission is too low: ' + dropped.join(', ') + ')' : '');
        show(grant, true); show(allow, true); show(deny, true);
      })
      .catch(function (e) { status.textContent = 'Error: ' + e.message; show(retry, true); });
  }
  function decide(decision) {
    allow.disabled = deny.disabled = true;
    fetch('consent/' + encodeURIComponent(id), {
      method: 'POST', headers: headers(), credentials: 'same-origin',
      body: JSON.stringify({ csrf: csrf, decision: decision })
    })
      .then(function (r) { return r.json().then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        if (x.r.ok && x.b.redirect) { status.textContent = 'Redirecting…'; window.location.assign(x.b.redirect); }
        else status.textContent = x.b.error || ('Error ' + x.r.status);
      })
      .catch(function (e) { status.textContent = 'Error: ' + e.message; });
  }
  allow.addEventListener('click', function () { decide('allow'); });
  deny.addEventListener('click', function () { decide('deny'); });
  retry.addEventListener('click', load);
  load();
})();`;
