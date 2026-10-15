/**
 * OAuth 2.0 Authorization Server
 * Implements RFC 6749 (Authorization Code flow) + RFC 7636 (PKCE)
 * Required for Claude.ai web connector integration
 */

import { createHash, randomBytes } from 'crypto';

import axios from 'axios';
import type { Request, Response, Router } from 'express';
import { Router as createRouter } from 'express';

import type {
  OAuthClient,
  AuthorizationCode,
  AccessToken,
  RefreshToken,
  NodeRedCredentials,
  OAuthAuthorizationServerMetadata,
} from '../types/oauth.js';

import { buildAuthorizeLoginHtml } from './oauth-authorize-html.js';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Allowed redirect URI prefixes for dynamically registered clients
const ALLOWED_REDIRECT_ORIGINS = [
  'https://claude.ai',
  'https://app.claude.ai',
  'https://www.claude.ai',
];

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    // Allow localhost for development/testing only (not in production)
    if (process.env.NODE_ENV !== 'production') {
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        return true;
      }
    }
    return ALLOWED_REDIRECT_ORIGINS.some(origin => uri.startsWith(origin));
  } catch {
    return false;
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export class OAuthServer {
  private clients = new Map<string, OAuthClient>();
  private codes = new Map<string, AuthorizationCode>();
  private tokens = new Map<string, AccessToken>();
  private refreshTokens = new Map<string, RefreshToken>();
  private credentialStore = new Map<
    string,
    { credentials: NodeRedCredentials; expiresAt: number }
  >();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.registerDefaultClients();
    // Purge expired tokens and codes every 10 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [k, v] of this.tokens) {
      if (now > v.expiresAt) this.tokens.delete(k);
    }
    for (const [k, v] of this.refreshTokens) {
      if (now > v.expiresAt) this.refreshTokens.delete(k);
    }
    for (const [k, v] of this.codes) {
      if (now > v.expiresAt) this.codes.delete(k);
    }
    for (const [k, v] of this.credentialStore) {
      if (now > v.expiresAt) this.credentialStore.delete(k);
    }
  }

  private storeCredentials(credentials: NodeRedCredentials): string {
    const credentialId = randomBytes(20).toString('hex');
    this.credentialStore.set(credentialId, {
      credentials,
      expiresAt: Date.now() + TOKEN_TTL_MS * 2,
    });
    return credentialId;
  }

  private retrieveCredentials(credentialId: string): NodeRedCredentials | null {
    const entry = this.credentialStore.get(credentialId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.credentialStore.delete(credentialId);
      return null;
    }
    return entry.credentials;
  }

  getNodeRedCredentials(credentialId: string): NodeRedCredentials | null {
    return this.retrieveCredentials(credentialId);
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  /**
   * Pre-register Claude.ai as a known client.
   * Claude uses dynamic registration, but having a fallback client avoids
   * requiring it.
   */
  private registerDefaultClients(): void {
    const claudeClientId = process.env.OAUTH_CLAUDE_CLIENT_ID ?? 'claude-ai-client';

    this.clients.set(claudeClientId, {
      clientId: claudeClientId,
      redirectUris: [
        // Claude.ai actual callback URIs (RFC-compliant paths)
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
        // Legacy / fallback paths
        'https://claude.ai/oauth/callback',
        'https://app.claude.ai/oauth/callback',
        // Allow localhost redirect for testing
        'http://localhost:3000/oauth/callback',
        'http://localhost:8080/oauth/callback',
      ],
      name: 'Claude.ai',
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    });
  }

  /**
   * Register a new client (Dynamic Client Registration — RFC 7591)
   */
  registerClient(client: Omit<OAuthClient, 'clientId'>): OAuthClient {
    const clientId = randomBytes(16).toString('hex');
    const full: OAuthClient = { ...client, clientId };
    this.clients.set(clientId, full);
    return full;
  }

  getClient(clientId: string): OAuthClient | undefined {
    return this.clients.get(clientId);
  }

  // ── Authorization Code ────────────────────────────────────────────────────

  createAuthorizationCode(
    params: Omit<AuthorizationCode, 'code' | 'expiresAt' | 'credentialId'> & {
      nodeRedCredentials?: NodeRedCredentials;
    }
  ): AuthorizationCode {
    const { nodeRedCredentials, ...rest } = params;
    const credentialId = nodeRedCredentials ? this.storeCredentials(nodeRedCredentials) : undefined;
    const code: AuthorizationCode = {
      ...rest,
      ...(credentialId && { credentialId }),
      code: randomBytes(32).toString('hex'),
      expiresAt: Date.now() + CODE_TTL_MS,
    };
    this.codes.set(code.code, code);
    return code;
  }

  consumeAuthorizationCode(code: string): AuthorizationCode | null {
    const entry = this.codes.get(code);
    this.codes.delete(code); // single-use
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }

  // ── Access Token ─────────────────────────────────────────────────────────

  createAccessToken(
    params: Omit<AccessToken, 'token' | 'expiresAt' | 'credentialId'> & {
      nodeRedCredentials?: NodeRedCredentials;
      credentialId?: string;
    }
  ): AccessToken {
    const { nodeRedCredentials, credentialId: incomingCredentialId, ...rest } = params;
    // Prefer an already-stored credentialId; otherwise store fresh credentials if provided
    const credentialId =
      incomingCredentialId ??
      (nodeRedCredentials ? this.storeCredentials(nodeRedCredentials) : undefined);
    const token: AccessToken = {
      ...rest,
      ...(credentialId && { credentialId }),
      token: randomBytes(40).toString('hex'),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  validateToken(token: string): AccessToken | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return entry;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  // ── Refresh Token ─────────────────────────────────────────────────────────

  createRefreshToken(params: Omit<RefreshToken, 'token' | 'expiresAt'>): RefreshToken {
    const refreshToken: RefreshToken = {
      ...params,
      token: randomBytes(40).toString('hex'),
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    };
    this.refreshTokens.set(refreshToken.token, refreshToken);
    return refreshToken;
  }

  consumeRefreshToken(token: string): RefreshToken | null {
    const entry = this.refreshTokens.get(token);
    this.refreshTokens.delete(token); // single-use — rotate on refresh
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }

  revokeRefreshToken(token: string): void {
    this.refreshTokens.delete(token);
  }

  private withCredentialId(id?: string): { credentialId: string } | Record<never, never> {
    return id ? { credentialId: id } : {};
  }

  // ── PKCE ─────────────────────────────────────────────────────────────────

  verifyCodeChallenge(verifier: string, challenge: string, _method: 'S256'): boolean {
    // RFC 7636: verifier must be 43-128 chars, unreserved characters only
    if (verifier.length < 43 || verifier.length > 128) return false;
    if (!/^[A-Za-z0-9\-._~]*$/.test(verifier)) return false;
    const computed = createHash('sha256').update(verifier).digest('base64url');
    return computed === challenge;
  }

  // ── Express Router ────────────────────────────────────────────────────────

  // ── Authorization / token handlers ───────────────────────────────────
  private registerPublicClient(clientId: string): OAuthClient {
    const newClient: OAuthClient = {
      clientId,
      redirectUris: [],
      name: clientId,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    };
    this.clients.set(clientId, newClient);
    return newClient;
  }

  /**
   * Resolve an OAuth client for /authorize, supporting Client ID Metadata Documents.
   * Returns null when an error response has already been sent.
   */
  private async resolveAuthorizeClient(
    clientId: string,
    res: Response
  ): Promise<OAuthClient | null> {
    const existing = this.clients.get(clientId);
    if (existing) return existing;

    // If the client_id is a URL from a trusted origin, auto-register the client.
    // We skip fetching the metadata document itself because it may be behind
    // Cloudflare or other auth (e.g. claude.ai). Instead we trust the origin
    // and validate redirect_uri against ALLOWED_REDIRECT_ORIGINS later.
    const trustedOrigin = ALLOWED_REDIRECT_ORIGINS.find(origin =>
      clientId.startsWith(`${origin}/`)
    );
    if (trustedOrigin) {
      return this.registerPublicClient(clientId);
    }

    if (!clientId.startsWith('https://') && !clientId.startsWith('http://')) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return null;
    }

    // Only allow known trusted origins (Claude.ai, localhost for dev)
    const allowedClientMetadataHosts = ['claude.ai', 'www.claude.ai', 'localhost', '127.0.0.1'];
    const parsedClientId = new URL(clientId);
    const hostAllowed = allowedClientMetadataHosts.some(
      h => parsedClientId.hostname === h || parsedClientId.hostname.endsWith('.claude.ai')
    );

    if (!hostAllowed) {
      // Skip metadata fetch silently — treat as public client without metadata
      return this.registerPublicClient(clientId);
    }

    // Trusted origin — try fetching the metadata document.
    // Host was allowlisted above; client_id is an OAuth Client ID Metadata Document URL.
    try {
      // codeql[js/request-forgery] host allowlisted to claude.ai / localhost only
      const metaResp = await axios.get<{
        redirect_uris?: string[];
        client_name?: string;
        scope?: string;
      }>(clientId, { timeout: 5000 });
      const meta = metaResp.data;
      const redirectUris: string[] = meta.redirect_uris ?? [];
      const allowed = redirectUris.some(uri =>
        ALLOWED_REDIRECT_ORIGINS.some(origin => uri.startsWith(origin))
      );
      if (!allowed && redirectUris.length > 0) {
        res.status(400).json({
          error: 'invalid_client',
          error_description: 'Client redirect URIs not from allowed origins',
        });
        return null;
      }
      const newClient: OAuthClient = {
        clientId,
        redirectUris,
        name: meta.client_name ?? clientId,
        scopes: (meta.scope ?? 'mcp:read mcp:write mcp:admin').split(' '),
      };
      this.clients.set(clientId, newClient);
      return newClient;
    } catch {
      res.status(400).json({
        error: 'invalid_client',
        error_description: 'Could not fetch client metadata document',
      });
      return null;
    }
  }

  private async handleAuthorizeGet(req: Request, res: Response): Promise<void> {
    const {
      client_id,
      redirect_uri,
      response_type,
      state,
      scope,
      code_challenge,
      code_challenge_method,
    } = req.query as Record<string, string | undefined>;

    if (!client_id || response_type !== 'code' || !code_challenge) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const client = await this.resolveAuthorizeClient(client_id, res);
    if (!client) return;

    // Validate redirect_uri against the client's registered URIs
    if (!redirect_uri) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'redirect_uri required' });
      return;
    }
    // Allow if listed in registered URIs, or if client has no redirect_uris registered
    // (metadata document clients may have empty list — fallback to origin check)
    const redirectOk =
      client.redirectUris.length === 0
        ? ALLOWED_REDIRECT_ORIGINS.some(origin => redirect_uri.startsWith(origin))
        : client.redirectUris.includes(redirect_uri);
    if (!redirectOk) {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'redirect_uri does not match registered URIs',
      });
      return;
    }

    // code_challenge already required by the guard at the top of this handler.

    // Only S256 PKCE is supported
    if (code_challenge_method && code_challenge_method !== 'S256') {
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'Only S256 code_challenge_method is supported',
      });
      return;
    }

    // Show the Node-RED credential form — user must submit credentials
    const defaultUrl = process.env.NODERED_URL ?? '';
    const errorRaw = req.query.error;
    const errorMsg = typeof errorRaw === 'string' ? errorRaw : '';
    // Allow embedding from claude.ai (removes frame restrictions)
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Values rendered into HTML are escaped inside buildAuthorizeLoginHtml via escHtml.
    // codeql[js/xss] authorize form HTML escapes user/query fields through escHtml
    res.status(200).send(
      buildAuthorizeLoginHtml({
        errorMsg,
        defaultUrl,
        clientId: client_id,
        redirectUri: redirect_uri,
        state,
        scope,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        escHtml,
      })
    );
  }

  private async handleAuthorizePost(req: Request, res: Response): Promise<void> {
    // OAuth params may arrive via hidden form fields (body) or query string — check both
    const merged = {
      ...(req.query as Record<string, string>),
      ...(req.body as Record<string, string>),
    };
    const {
      client_id,
      redirect_uri,
      state,
      scope,
      code_challenge,
      code_challenge_method,
      nr_url,
      auth_type,
      nr_token,
      nr_username,
      nr_password,
    } = merged;

    // Basic param validation
    if (!client_id || !redirect_uri || !code_challenge || !nr_url) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'Missing required fields' });
      return;
    }

    // Whether the client wants JSON response (JS fetch) or classic 302 redirect
    const wantsJson = merged._json === '1';

    const sendError = (msg: string): void => {
      if (wantsJson) {
        res.status(400).json({ error: msg });
      } else {
        const params = new URLSearchParams({
          client_id,
          redirect_uri,
          response_type: 'code',
          state: state ?? '',
          scope: scope ?? '',
          code_challenge,
          code_challenge_method: code_challenge_method ?? 'S256',
          error: msg,
        });
        res.redirect(302, `/authorize?${params.toString()}`);
      }
    };

    // Require S256 explicitly
    if (!code_challenge_method || code_challenge_method !== 'S256') {
      sendError('code_challenge_method must be S256');
      return;
    }

    // Sanitise the Node-RED URL (http/https origin only — product connects to caller NR)
    let nodeRedUrl: string;
    try {
      const u = new URL(nr_url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
      nodeRedUrl = u.origin; // strip trailing path/query
    } catch {
      const params = new URLSearchParams(req.body as Record<string, string>);
      params.set('error', 'כתובת URL לא תקינה');
      res.redirect(302, `/authorize?${params.toString()}`);
      return;
    }

    // Validate redirect_uri (re-check after POST)
    const redirectOk =
      ALLOWED_REDIRECT_ORIGINS.some(o => redirect_uri.startsWith(o)) ||
      (this.clients.get(client_id)?.redirectUris ?? []).includes(redirect_uri);
    if (!redirectOk) {
      res
        .status(400)
        .json({ error: 'invalid_request', error_description: 'redirect_uri mismatch' });
      return;
    }

    // Build credentials object
    const credentials: NodeRedCredentials =
      auth_type === 'basic'
        ? {
            url: nodeRedUrl,
            authType: 'basic',
            ...(nr_username && { username: nr_username }),
            ...(nr_password && { password: nr_password }),
          }
        : {
            url: nodeRedUrl,
            authType: 'bearer',
            ...(nr_token && { token: nr_token }),
          };

    // Validate that the Node-RED URL is reachable (any HTTP response means the server is up).
    // We do NOT validate the credentials here — basic-auth and token auth use different
    // mechanisms, so a 401 simply means the server responded (credentials will be
    // verified on the first real API call).

    if (process.env.NODERED_SKIP_CREDENTIAL_VALIDATION !== 'true') {
      try {
        // Reachability probe of the user-chosen Node-RED origin (http/https only above).
        // codeql[js/request-forgery] intentional OAuth connect-to-user-NR probe; origin-only URL
        await axios.get(`${nodeRedUrl}/`, {
          timeout: 5000,
          validateStatus: () => true, // accept any HTTP status — 401 means server is up
          httpsAgent: new (await import('https')).default.Agent({ rejectUnauthorized: false }),
        });
      } catch {
        sendError('כתובת ה-Node-RED אינה נגישה — בדוק שה-URL נכון');
        return;
      }
    }

    // Issue authorization code with embedded Node-RED credentials
    const authCode = this.createAuthorizationCode({
      clientId: client_id,
      redirectUri: redirect_uri,
      userId: 'mcp-user',
      scopes: scope ? scope.split(' ') : ['mcp:read', 'mcp:write'],
      codeChallenge: code_challenge,
      codeChallengeMethod: 'S256',
      nodeRedCredentials: credentials,
    });

    const callbackParams = new URLSearchParams({ code: authCode.code });
    if (state) callbackParams.set('state', state);
    const callbackUrl = `${redirect_uri}?${callbackParams.toString()}`;
    console.log('[AUTH POST] success');

    if (wantsJson) {
      res.json({ redirect_to: callbackUrl });
    } else {
      // redirect_uri validated against ALLOWED_REDIRECT_ORIGINS / registered URIs above
      // codeql[js/server-side-unvalidated-url-redirection] redirect_uri allowlisted before redirect
      res.redirect(302, callbackUrl);
    }
  }
  private handleToken(req: Request, res: Response): void {
    const body = req.body as Record<string, string>;
    const { grant_type, client_id } = body;

    // ── Refresh Token grant (RFC 6749 §6) ──────────────────────────────────
    // grant_type selects the OAuth grant; refresh path still validates the token.
    // codeql[js/user-controlled-bypass] grant_type is an OAuth dispatch key, not an auth bypass
    if (grant_type === 'refresh_token') {
      const { refresh_token } = body;
      if (!refresh_token) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'refresh_token required' });
        return;
      }
      const rt = this.consumeRefreshToken(refresh_token);
      if (!rt) {
        res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Refresh token invalid or expired',
        });
        return;
      }
      if (client_id && rt.clientId !== client_id) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
        return;
      }
      const newAccess = this.createAccessToken({
        clientId: rt.clientId,
        userId: rt.userId,
        scopes: rt.scopes,
        ...this.withCredentialId(rt.credentialId),
      });
      const newRefresh = this.createRefreshToken({
        clientId: rt.clientId,
        userId: rt.userId,
        scopes: rt.scopes,
        ...this.withCredentialId(rt.credentialId),
      });
      console.log('[TOKEN] refresh — new tokens issued');
      res.json({
        access_token: newAccess.token,
        token_type: 'Bearer',
        expires_in: Math.floor(TOKEN_TTL_MS / 1000),
        refresh_token: newRefresh.token,
        refresh_token_expires_in: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
        scope: newAccess.scopes.join(' '),
      });
      return;
    }

    // ── Authorization Code grant (RFC 6749 §4.1) ───────────────────────────
    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    const { code, redirect_uri, code_verifier } = body;

    if (!code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code required' });
      return;
    }

    const authCode = this.consumeAuthorizationCode(code);
    if (!authCode) {
      res
        .status(400)
        .json({ error: 'invalid_grant', error_description: 'Code invalid or expired' });
      return;
    }

    // Only check client_id if provided — public clients (auth method: none) may omit it
    if (client_id && authCode.clientId !== client_id) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      return;
    }

    // PKCE verification (required)
    if (!code_verifier) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
      return;
    }

    const valid = this.verifyCodeChallenge(code_verifier, authCode.codeChallenge, 'S256');
    if (!valid) {
      res
        .status(400)
        .json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    if (redirect_uri && authCode.redirectUri && authCode.redirectUri !== redirect_uri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }

    const accessToken = this.createAccessToken({
      clientId: authCode.clientId,
      userId: authCode.userId,
      scopes: authCode.scopes,
      ...this.withCredentialId(authCode.credentialId),
    });
    const refreshToken = this.createRefreshToken({
      clientId: authCode.clientId,
      userId: authCode.userId,
      scopes: authCode.scopes,
      ...this.withCredentialId(authCode.credentialId),
    });

    console.log('[TOKEN] success — tokens issued');
    res.json({
      access_token: accessToken.token,
      token_type: 'Bearer',
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken.token,
      refresh_token_expires_in: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
      scope: accessToken.scopes.join(' '),
    });
  }
  createRouter(baseUrl: string): Router {
    const router = createRouter();

    // ── Discovery ────────────────────────────────────────────────────────
    router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
      const meta: OAuthAuthorizationServerMetadata = {
        issuer: baseUrl,
        // Advertise root paths — Claude.ai web ignores these and hardcodes /authorize /token /register,
        // but Claude Code and compliant clients will use these correctly.
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        revocation_endpoint: `${baseUrl}/oauth/revoke`,
        scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      };
      res.json(meta);
    });

    // ── Dynamic Client Registration (RFC 7591) ────────────────────────────
    // Claude.ai web hardcodes /register at root, so we expose it there.
    // Keep /oauth/register as well for compliant clients that read the metadata.
    const handleRegister = (req: Request, res: Response): void => {
      const { client_name, redirect_uris, scope } = req.body as {
        client_name?: string;
        redirect_uris?: string[];
        scope?: string;
      };

      if (!redirect_uris?.length) {
        res
          .status(400)
          .json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
        return;
      }

      // Validate all redirect URIs against allowlist
      const invalidUris = redirect_uris.filter(uri => !isAllowedRedirectUri(uri));
      if (invalidUris.length > 0) {
        res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'One or more redirect_uris are not allowed',
        });
        return;
      }

      const client = this.registerClient({
        name: client_name ?? 'Unknown Client',
        redirectUris: redirect_uris,
        scopes: scope ? scope.split(' ') : ['mcp:read', 'mcp:write'],
      });

      res.status(201).json({
        client_id: client.clientId,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    };

    router.post('/register', handleRegister);
    router.post('/oauth/register', handleRegister);

    // ── Authorization Endpoint ────────────────────────────────────────────
    router.get('/authorize', (req, res) => void this.handleAuthorizeGet(req, res));
    router.get('/oauth/authorize', (req, res) => void this.handleAuthorizeGet(req, res));
    router.post('/authorize', (req, res) => void this.handleAuthorizePost(req, res));
    router.post('/oauth/authorize', (req, res) => void this.handleAuthorizePost(req, res));

    // ── Token Endpoint ────────────────────────────────────────────────────
    // Claude.ai web hardcodes /token, compliant clients use path from metadata.
    router.post('/token', (req, res) => this.handleToken(req, res));
    router.post('/oauth/token', (req, res) => this.handleToken(req, res));

    // ── Token Revocation (RFC 7009) ───────────────────────────────────────
    router.post('/oauth/revoke', (req: Request, res: Response) => {
      const { token, token_type_hint } = req.body as { token?: string; token_type_hint?: string };
      if (token) {
        if (token_type_hint === 'refresh_token') {
          this.revokeRefreshToken(token);
        } else if (token_type_hint === 'access_token') {
          this.revokeToken(token);
        } else {
          // RFC 7009 §2.1: try both when hint is absent
          this.revokeToken(token);
          this.revokeRefreshToken(token);
        }
      }
      // RFC 7009: always respond 200 regardless of whether token existed
      res.status(200).end();
    });

    return router;
  }
}
