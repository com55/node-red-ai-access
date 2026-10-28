/**
 * Browser helpers shared by the OAuth consent page and the AI Access dashboard
 * sign-in card: read Node-RED's login type and obtain an editor token with
 * username/password exactly like the editor does (POST `<adminRoot>/auth/token`,
 * client `node-red-editor`), storing it under the editor's localStorage key so
 * the editor itself stays signed in too.
 */
export const editorSignInHelpers = `
  function nrLoginType(adminRootHref) {
    return fetch(new URL('auth/login', adminRootHref).href, {
      headers: { 'Node-RED-API-Version': 'v2' }, credentials: 'same-origin'
    })
      .then(function (r) { return r.json(); })
      .then(function (cfg) { return cfg && typeof cfg.type === 'string' ? cfg.type : null; })
      .catch(function () { return null; });
  }
  function nrPasswordSignIn(adminRootHref, tokenKey, username, password) {
    var body = new URLSearchParams({
      client_id: 'node-red-editor', grant_type: 'password', scope: '*',
      username: username, password: password
    });
    return fetch(new URL('auth/token', adminRootHref).href, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Node-RED-API-Version': 'v2' },
      body: body.toString()
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { r: r, b: b }; }); })
      .then(function (x) {
        if (!x.r.ok || !x.b.access_token) return { ok: false };
        try { localStorage.setItem(tokenKey, JSON.stringify(x.b)); } catch (e) {}
        return { ok: true };
      });
  }
`;
