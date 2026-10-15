/**
 * Authorize login form HTML for OAuth GET /authorize.
 */
export function buildAuthorizeLoginHtml(opts: {
  errorMsg: string;
  defaultUrl: string;
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  scope: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: string | undefined;
  escHtml: (s: string) => string;
}): string {
  const {
    errorMsg,
    defaultUrl,
    clientId,
    redirectUri,
    state,
    scope,
    codeChallenge,
    codeChallengeMethod,
    escHtml,
  } = opts;
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>חיבור ל-Node-RED</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f0f2f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.1); padding: 2rem; width: 100%; max-width: 440px; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: .25rem; color: #111; }
    .subtitle { font-size: .85rem; color: #666; margin-bottom: 1.5rem; }
    label { display: block; font-size: .85rem; font-weight: 600; color: #333; margin-bottom: .3rem; }
    input[type=text], input[type=password], input[type=url] { width: 100%; padding: .6rem .75rem; border: 1px solid #ddd; border-radius: 7px; font-size: .9rem; margin-bottom: 1rem; outline: none; transition: border .15s; }
    input:focus { border-color: #7c3aed; box-shadow: 0 0 0 3px rgba(124,58,237,.15); }
    .tabs { display: flex; gap: .5rem; margin-bottom: 1rem; }
    .tab { flex: 1; padding: .5rem; border: 1px solid #ddd; border-radius: 7px; background: #f9f9f9; cursor: pointer; font-size: .85rem; text-align: center; transition: all .15s; }
    .tab.active { background: #7c3aed; color: #fff; border-color: #7c3aed; font-weight: 600; }
    .panel { display: none; }
    .panel.active { display: block; }
    .error { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; border-radius: 7px; padding: .7rem 1rem; font-size: .85rem; margin-bottom: 1rem; }
    .success { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; border-radius: 7px; padding: .7rem 1rem; font-size: .85rem; margin-bottom: 1rem; }
    #submit-btn { width: 100%; padding: .75rem; background: #7c3aed; color: #fff; border: none; border-radius: 7px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background .15s; }
    #submit-btn:hover:not(:disabled) { background: #6d28d9; }
    #submit-btn:disabled { background: #a78bfa; cursor: not-allowed; }
    .lock { text-align: center; font-size: .75rem; color: #999; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔌 חיבור ל-Node-RED</h1>
    <p class="subtitle">הזן את פרטי ה-Node-RED שאליו Claude יתחבר</p>
    <div id="msg-box">${errorMsg ? `<div class="error">⚠️ ${escHtml(errorMsg)}</div>` : ''}</div>

    <label for="nr_url">כתובת Node-RED</label>
    <input type="url" id="nr_url" value="${defaultUrl}" placeholder="https://nodered.example.com">

    <label>סוג הזדהות</label>
    <div class="tabs">
      <div class="tab active" data-tab="bearer">Bearer Token</div>
      <div class="tab" data-tab="basic">שם משתמש + סיסמה</div>
    </div>

    <div id="panel-bearer" class="panel active">
      <label for="nr_token">API Token</label>
      <input type="password" id="nr_token" placeholder="הכנס Bearer token">
    </div>
    <div id="panel-basic" class="panel">
      <label for="nr_username">שם משתמש</label>
      <input type="text" id="nr_username" placeholder="admin">
      <label for="nr_password">סיסמה</label>
      <input type="password" id="nr_password" placeholder="••••••••">
    </div>

    <button id="submit-btn" type="button">התחבר</button>
    <p class="lock">🔒 הפרטים מוצפנים ב-JWT ולא נשמרים בשרת</p>
  </div>
  <script>
    var authType = 'bearer';
    document.querySelectorAll('.tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        authType = this.dataset.tab;
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
        this.classList.add('active');
        document.getElementById('panel-' + authType).classList.add('active');
      });
    });

    document.getElementById('submit-btn').addEventListener('click', function() {
      var btn = this;
      var msgBox = document.getElementById('msg-box');
      var nr_url = document.getElementById('nr_url').value.trim();
      if (!nr_url) { msgBox.innerHTML = '<div class="error">⚠️ יש להזין כתובת Node-RED</div>'; return; }

      btn.disabled = true;
      btn.textContent = '⏳ מתחבר...';
      msgBox.innerHTML = '';

      var body = new URLSearchParams({
        _json: '1',
        client_id: ${JSON.stringify(clientId)},
        redirect_uri: ${JSON.stringify(redirectUri)},
        response_type: 'code',
        state: ${JSON.stringify(state ?? '')},
        scope: ${JSON.stringify(scope ?? '')},
        code_challenge: ${JSON.stringify(codeChallenge)},
        code_challenge_method: ${JSON.stringify(codeChallengeMethod ?? 'S256')},
        nr_url: nr_url,
        auth_type: authType,
        nr_token: document.getElementById('nr_token').value,
        nr_username: document.getElementById('nr_username') ? document.getElementById('nr_username').value : '',
        nr_password: document.getElementById('nr_password') ? document.getElementById('nr_password').value : ''
      });

      fetch('/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.redirect_to) {
          msgBox.innerHTML = '<div class="success">✅ מתחבר ל-Claude...</div>';
          // Navigate top window (works in popup, iframe, and direct tab)
          try { window.top.location.href = data.redirect_to; } catch(e) { window.location.href = data.redirect_to; }
        } else {
          var err = data.error_description || data.error || 'שגיאה לא ידועה';
          msgBox.innerHTML = '<div class="error">⚠️ ' + err + '</div>';
          btn.disabled = false;
          btn.textContent = 'התחבר';
        }
      }).catch(function(e) {
        msgBox.innerHTML = '<div class="error">⚠️ שגיאת רשת: ' + e.message + '</div>';
        btn.disabled = false;
        btn.textContent = 'התחבר';
      });
    });
  </script>
</body>
</html>`;
}
