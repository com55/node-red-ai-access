/** OAuth 2.1 authorization server and protected-resource support for MCP. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import express, { type RequestHandler, type Response } from 'express';

import type { AiAccessPaths } from '../storage/paths.js';
import { encodeTrustedJson, writeTrustedAtomic } from '../storage/trusted-write.js';

import { editorAuthTokenKey } from './auth-token-key.js';
import { requireAdminSession, resolvePermission } from './auth.js';
import { consentScript } from './oauth-consent-script.js';
import { isAdminAuthEnabled } from './settings.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

interface OAuthDb {
  clients: (OAuthClientInformationFull & { lastUsedAt?: number; approved?: boolean })[];
  codes: Code[];
  tokens: Token[];
}
interface Code {
  hash: string;
  clientId: string;
  challenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  expires: number;
  user: string;
}
interface Token {
  hash: string;
  type: 'access' | 'refresh';
  clientId: string;
  family: string;
  scopes: string[];
  resource: string;
  expires: number;
  user: string;
  rotated: boolean;
  /** When the refresh family was first issued (ms); used by the optional max lifetime. */
  familyStart?: number;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
/** Registered clients that never got consent are dropped after this long. */
const UNCONSENTED_CLIENT_TTL_MS = 3_600_000;
/** Hard bound on clients awaiting consent (registration is also rate limited per IP). */
const MAX_UNCONSENTED_CLIENTS = 100;
const emptyDb = (): OAuthDb => ({ clients: [], codes: [], tokens: [] });

export class OAuthStore implements OAuthRegisteredClientsStore {
  private db: OAuthDb;
  private readonly path: string;
  constructor(
    paths: AiAccessPaths,
    private readonly maxClients: () => number
  ) {
    this.path = join(paths.root, 'oauth.json');
    try {
      const parsed: unknown = existsSync(this.path)
        ? JSON.parse(readFileSync(this.path, 'utf8'))
        : emptyDb();
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('clients' in parsed) ||
        !('codes' in parsed) ||
        !('tokens' in parsed) ||
        !Array.isArray(parsed.clients) ||
        !Array.isArray(parsed.codes) ||
        !Array.isArray(parsed.tokens)
      )
        throw new Error('Invalid OAuth store');
      this.db = parsed as OAuthDb;
    } catch {
      this.db = emptyDb();
    }
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    this.prune();
  }
  private save(): void {
    writeTrustedAtomic(
      join(this.path, '..'),
      this.path,
      encodeTrustedJson(this.db, 8_000_000, { kind: 'oauth', pretty: true })
    );
  }
  prune(now = Date.now()): void {
    const before = this.db.clients.length + this.db.codes.length + this.db.tokens.length;
    const active = new Set(
      this.db.clients
        .filter(c =>
          c.approved
            ? (c.lastUsedAt ?? (c.client_id_issued_at ?? 0) * 1000) > now - 30 * 86400_000
            : (c.client_id_issued_at ?? 0) * 1000 > now - UNCONSENTED_CLIENT_TTL_MS
        )
        .map(c => c.client_id)
    );
    this.db.clients = this.db.clients.filter(c => active.has(c.client_id));
    this.db.codes = this.db.codes.filter(c => c.expires > now && active.has(c.clientId));
    this.db.tokens = this.db.tokens.filter(t => active.has(t.clientId) && t.expires > now);
    if (this.db.clients.length + this.db.codes.length + this.db.tokens.length !== before)
      this.save();
  }
  getClient(id: string): OAuthClientInformationFull | undefined {
    this.prune();
    return this.db.clients.find(c => c.client_id === id);
  }
  registerClient(
    input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): OAuthClientInformationFull {
    this.prune();
    if (this.approvedCount() >= this.maxClients())
      throw new InvalidClientMetadataError('Maximum active OAuth clients reached');
    if (this.db.clients.length - this.approvedCount() >= MAX_UNCONSENTED_CLIENTS)
      throw new InvalidClientMetadataError('Too many OAuth clients awaiting consent');
    if (
      !Array.isArray(input.redirect_uris) ||
      !input.redirect_uris.length ||
      input.redirect_uris.some(v => {
        try {
          const u = new URL(v);
          return (
            !!u.username ||
            !!u.password ||
            !!u.hash ||
            (u.protocol !== 'https:' &&
              !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
          );
        } catch {
          return true;
        }
      })
    )
      throw new InvalidClientMetadataError('Redirect URIs must use HTTPS or loopback HTTP');
    if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none')
      throw new InvalidClientMetadataError('Only public clients are supported');
    const client = {
      ...input,
      client_secret: undefined,
      client_secret_expires_at: undefined,
      client_id: secret(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none' as const,
      lastUsedAt: Date.now(),
    };
    this.db.clients.push(client);
    this.save();
    return client;
  }
  private approvedCount(): number {
    return this.db.clients.filter(c => c.approved).length;
  }
  /** Marks a client as consented; only approved clients count toward the cap. */
  approve(id: string): void {
    const client = this.db.clients.find(c => c.client_id === id);
    if (!client || client.approved) return;
    if (this.approvedCount() >= this.maxClients())
      throw new InvalidClientMetadataError('Maximum active OAuth clients reached');
    client.approved = true;
    this.save();
  }
  get data(): OAuthDb {
    return this.db;
  }
  persist(): void {
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this.touchTimer = undefined;
    }
    this.save();
  }
  private touchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Coalesces lastUsedAt-only changes into one write per few seconds. */
  touch(): void {
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = undefined;
      this.save();
    }, 5_000);
    this.touchTimer.unref?.();
  }
  revokeClient(id: string): boolean {
    const before = this.db.clients.length;
    this.db.clients = this.db.clients.filter(c => c.client_id !== id);
    this.db.tokens = this.db.tokens.filter(t => t.clientId !== id);
    this.db.codes = this.db.codes.filter(c => c.clientId !== id);
    this.save();
    return this.db.clients.length !== before;
  }
}

export function detectOAuthRouteCollisions(
  app: unknown,
  routes: string[] = ['/.well-known/oauth-', '/mcp/oauth/']
): string[] {
  const found: string[] = [];
  interface Layer {
    route?: { path?: string | string[] };
    name?: string;
    handle?: { stack?: Layer[]; oauthOwned?: boolean };
    matchers?: ((path: string) => unknown)[];
    regexp?: RegExp;
  }
  // Express 4 throws from the deprecated `app.router` getter and creates
  // `_router` lazily; Express 5 only exposes `router`. Read both defensively.
  const read = (key: '_router' | 'router'): { stack?: Layer[] } | undefined => {
    try {
      return (app as Record<string, { stack?: Layer[] } | undefined> | undefined)?.[key];
    } catch {
      return undefined;
    }
  };
  const layers = read('_router')?.stack ?? read('router')?.stack ?? [];
  for (const layer of layers) {
    if (layer.handle?.oauthOwned) continue;
    const paths = layer.route?.path
      ? Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path]
      : [];
    for (const path of paths)
      if (routes.some(prefix => String(path).startsWith(prefix)))
        found.push(`${String(path)} (${layer.name ?? 'route'})`);
    const matchers =
      layer.matchers ?? (layer.regexp ? [(path: string) => layer.regexp?.test(path)] : undefined);
    if (!paths.length && matchers?.length && layer.name !== 'router') {
      const matches = (path: string) => matchers.some(matcher => Boolean(matcher(path)));
      const broad = matches('/unrelated-ai-access-collision-probe');
      if (!broad && routes.some(prefix => matches(`${prefix}token`) || matches(`${prefix}mcp`)))
        found.push(`mounted middleware (${layer.name ?? 'route'})`);
    }
    if (layer.handle?.stack)
      found.push(...detectOAuthRouteCollisions({ router: { stack: layer.handle.stack } }, routes));
  }
  return found;
}

export class LocalOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = false;
  private readonly inflight = new Map<string, Code>();
  constructor(
    readonly clientsStore: OAuthStore,
    private readonly resource: () => string,
    private readonly accessTtl: () => number,
    private readonly refreshTtl: () => number,
    private readonly refreshMax: () => number = () => 0
  ) {}
  async authorize(
    _client: OAuthClientInformationFull,
    _params: AuthorizationParams,
    _res: Response
  ): Promise<void> {
    throw new InvalidGrantError('Admin consent is required');
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string
  ): Promise<string> {
    // Single attempt: the code leaves the store before PKCE is checked, so a failed
    // verifier or redirect_uri burns it. The exchange step reads the in-flight copy.
    const found = this.findCode(client, code);
    this.clientsStore.data.codes = this.clientsStore.data.codes.filter(c => c !== found);
    this.clientsStore.persist();
    this.inflight.set(found.hash, found);
    setTimeout(() => this.inflight.delete(found.hash), 30_000).unref?.();
    return found.challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const item = this.inflight.get(hash(code)) ?? this.findCode(client, code);
    this.inflight.delete(item.hash);
    this.clientsStore.data.codes = this.clientsStore.data.codes.filter(c => c !== item);
    this.clientsStore.persist();
    if (
      item.clientId !== client.client_id ||
      item.expires <= Date.now() ||
      redirectUri !== item.redirectUri ||
      (resource && canonicalResource(resource.href) !== item.resource)
    )
      throw new InvalidGrantError('Invalid authorization code');
    return this.issue(client.client_id, item.scopes, item.resource, item.user);
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const item = this.clientsStore.data.tokens.find(
      t => t.hash === hash(token) && t.type === 'refresh' && t.clientId === client.client_id
    );
    if (!item || item.expires <= Date.now()) throw new InvalidGrantError('Invalid refresh token');
    if (item.rotated) {
      this.clientsStore.data.tokens = this.clientsStore.data.tokens.filter(
        t => t.family !== item.family
      );
      this.clientsStore.persist();
      throw new InvalidGrantError('Refresh token reuse detected');
    }
    const max = this.refreshMax() * 1000;
    // Families issued before this setting existed start their clock at first refresh.
    const familyStart = item.familyStart ?? Date.now();
    if (max > 0 && familyStart + max <= Date.now())
      throw new InvalidGrantError('Refresh token family reached its maximum lifetime');
    if (resource && canonicalResource(resource.href) !== item.resource)
      throw new InvalidGrantError('Resource mismatch');
    if (scopes?.some(s => !item.scopes.includes(s))) throw new InvalidGrantError('Invalid scope');
    item.rotated = true;
    return this.issue(
      client.client_id,
      scopes ?? item.scopes,
      item.resource,
      item.user,
      item.family,
      familyStart
    );
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const item = this.clientsStore.data.tokens.find(
      t => t.hash === hash(token) && t.type === 'access' && t.expires > Date.now()
    );
    if (!item || item.resource !== canonicalResource(this.resource()))
      throw new InvalidTokenError('Invalid access token');
    const client = this.clientsStore.data.clients.find(c => c.client_id === item.clientId);
    if (!client) throw new InvalidTokenError('Invalid client');
    client.lastUsedAt = Date.now();
    this.clientsStore.touch();
    return {
      token,
      clientId: item.clientId,
      scopes: item.scopes,
      expiresAt: Math.floor(item.expires / 1000),
      resource: new URL(item.resource),
      extra: { user: item.user },
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const item = this.clientsStore.data.tokens.find(
      t => t.hash === hash(request.token) && t.clientId === client.client_id
    );
    if (item)
      this.clientsStore.data.tokens = this.clientsStore.data.tokens.filter(
        t => t.family !== item.family
      );
    this.clientsStore.persist();
  }
  createCode(client: OAuthClientInformationFull, p: AuthorizationParams, user: string): string {
    const code = secret();
    this.clientsStore.data.codes.push({
      hash: hash(code),
      clientId: client.client_id,
      challenge: p.codeChallenge,
      redirectUri: p.redirectUri,
      scopes: p.scopes ?? ['read'],
      resource: this.validateResource(p.resource),
      expires: Date.now() + 60_000,
      user,
    });
    this.clientsStore.persist();
    return code;
  }
  private validateResource(resource?: URL): string {
    const expected = canonicalResource(this.resource());
    if (resource && canonicalResource(resource.href) !== expected)
      throw new InvalidGrantError('Resource mismatch');
    return expected;
  }
  private findCode(client: OAuthClientInformationFull, code: string): Code {
    const item = this.clientsStore.data.codes.find(
      c => c.hash === hash(code) && c.clientId === client.client_id
    );
    if (!item || item.expires <= Date.now())
      throw new InvalidGrantError('Invalid or expired authorization code');
    return item;
  }
  private issue(
    clientId: string,
    scopes: string[],
    resource: string,
    user: string,
    family = secret(),
    familyStart = Date.now()
  ): OAuthTokens {
    const access = secret(),
      refresh = secret(),
      now = Date.now();
    const max = this.refreshMax() * 1000;
    const refreshExpires = Math.min(
      now + this.refreshTtl() * 1000,
      max > 0 ? familyStart + max : Infinity
    );
    const db = this.clientsStore.data;
    const client = db.clients.find(c => c.client_id === clientId);
    if (client) client.lastUsedAt = now;
    db.tokens.push(
      {
        hash: hash(access),
        type: 'access',
        clientId,
        family,
        scopes,
        resource,
        expires: now + this.accessTtl() * 1000,
        user,
        rotated: false,
      },
      {
        hash: hash(refresh),
        type: 'refresh',
        clientId,
        family,
        scopes,
        resource,
        expires: refreshExpires,
        user,
        rotated: false,
        familyStart,
      }
    );
    this.clientsStore.persist();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.accessTtl(),
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }
}
export function canonicalResource(value: string): string {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error('Invalid resource URL');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

const oauthScopes = ['read', 'propose'];
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}
function value(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

export function makeOAuthHandlers(
  RED: NodeRedPluginAPI,
  provider: LocalOAuthProvider,
  issuer: () => string,
  resource: () => string
) {
  const abs = (path: string) => `${issuer().replace(/\/$/, '')}${path}`;
  const atRoot = (
    handler: RequestHandler,
    req: AuthenticatedRequest,
    res: Response,
    next: Parameters<RequestHandler>[2]
  ) => {
    const originalUrl = req.url;
    req.url = '/';
    handler(req, res, error => {
      req.url = originalUrl;
      next(error);
    });
  };
  // Node-RED keeps the editor session token in localStorage (`auth-tokens` + path
  // suffix), not a cookie, so a top-level redirect to this page carries no Bearer.
  // GET /authorize validates the request and renders a static shell; its script
  // reads the editor token and calls /consent/:id with Bearer to fetch details
  // and post the decision. Pending requests live in memory and are single use.
  interface Pending {
    clientId: string;
    redirect: string;
    challenge: string;
    scopes: string[];
    resource: string;
    state: string;
    csrf: string;
    approver?: string;
    expires: number;
  }
  const pending = new Map<string, Pending>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expires <= now) pending.delete(id);
    while (pending.size > 500) pending.delete(pending.keys().next().value!);
  };
  const securityHeaders = (res: Response, nonce?: string) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ''}style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
    );
  };
  const tokenKey = editorAuthTokenKey(RED.settings.httpAdminRoot);
  const grantableFor = (req: AuthenticatedRequest): string[] => {
    if (!isAdminAuthEnabled(RED.settings)) return [...oauthScopes];
    const permission = resolvePermission(req);
    return permission === '*' ? [...oauthScopes] : permission === 'read' ? ['read'] : [];
  };
  const sameOrigin = (req: AuthenticatedRequest): boolean => {
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin') return false;
    const origin = req.get('origin');
    if (!origin) return true;
    const allowed = new Set<string>();
    try {
      allowed.add(new URL(issuer()).origin);
    } catch {
      // no public URL configured
    }
    const host = req.get('host');
    if (host) {
      allowed.add(`http://${host}`);
      allowed.add(`https://${host}`);
    }
    return allowed.has(origin);
  };
  const authorizePage: RequestHandler = (req, res) => {
    sweep();
    const q = req.query;
    const client = provider.clientsStore.getClient(value(q.client_id));
    if (!client) {
      res.status(400).send('Unknown OAuth client');
      return;
    }
    const redirect =
      value(q.redirect_uri) || (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : '');
    if (!client.redirect_uris.some(uri => redirectUriMatches(redirect, uri))) {
      res.status(400).send('Unregistered redirect URI');
      return;
    }
    if (
      q.response_type !== 'code' ||
      q.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(value(q.code_challenge))
    ) {
      res.status(400).send('Authorization code with PKCE S256 is required');
      return;
    }
    const scopes = [...new Set((value(q.scope) || 'read').split(' ').filter(Boolean))];
    if (scopes.some(scope => !oauthScopes.includes(scope))) {
      res.status(400).send('Unsupported scope');
      return;
    }
    const requested = value(q.resource) || resource();
    let canonical: string;
    try {
      canonical = canonicalResource(requested);
    } catch {
      res.status(400).send('Invalid resource');
      return;
    }
    if (canonical !== canonicalResource(resource())) {
      res.status(400).send('Resource mismatch');
      return;
    }
    const id = secret();
    pending.set(id, {
      clientId: client.client_id,
      redirect,
      challenge: value(q.code_challenge),
      scopes,
      resource: requested,
      state: value(q.state),
      csrf: secret(),
      expires: Date.now() + 10 * 60_000,
    });
    const redirectHost = new URL(redirect).host;
    const nonce = randomBytes(16).toString('base64');
    securityHeaders(res, nonce);
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize MCP client</title>` +
          `<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px}h1{font-size:1.4em;word-break:break-all}.warn{color:#9b2c2c}.muted{color:#555}button{margin-right:8px;padding:6px 14px}</style>` +
          `<main data-request="${escapeHtml(id)}" data-token-key="${escapeHtml(tokenKey)}">` +
          `<p class="muted">An MCP client wants to access Node-RED and will receive tokens at:</p>` +
          `<h1>${escapeHtml(redirectHost)}</h1>${
            loopback.has(new URL(redirect).hostname)
              ? '<p class="warn">Warning: this redirect URI is reachable only on this machine.</p>'
              : ''
          }<p class="muted">Client-provided name (unverified): ${escapeHtml(client.client_name || 'Unnamed client')}</p>` +
          `<p>Requested permissions: ${escapeHtml(scopes.join(', '))}</p>` +
          `<p id="status">Checking your Node-RED editor session…</p>` +
          `<p id="grant" hidden></p>` +
          `<p><button id="allow" type="button" hidden>Allow</button><button id="deny" type="button" hidden>Deny</button><button id="retry" type="button" hidden>Retry</button></p>` +
          `</main><script nonce="${nonce}">${consentScript}</script></html>`
      );
  };
  const consentApi: RequestHandler = (req: AuthenticatedRequest, res, next) => {
    securityHeaders(res);
    express.json({ limit: '4kb' })(req, res, () =>
      requireAdminSession(RED, 'api')(req, res, () => {
        try {
          sweep();
          const id = /^\/mcp\/oauth\/consent\/([A-Za-z0-9_-]+)\/?$/.exec(req.path)?.[1] ?? '';
          const item = pending.get(id);
          const client = item && provider.clientsStore.getClient(item.clientId);
          if (!item || !client) {
            res.status(404).json({ error: 'Consent request expired or unknown' });
            return;
          }
          const user = (isAdminAuthEnabled(RED.settings) && req.user?.username) || 'owner';
          const grantable = item.scopes.filter(scope => grantableFor(req).includes(scope));
          if (!grantable.length) {
            res.status(403).json({
              error: 'Your Node-RED permissions do not allow granting the requested scopes',
              grantable,
            });
            return;
          }
          if (req.method === 'GET') {
            item.approver = user;
            res.json({
              client_name: client.client_name ?? null,
              redirect_host: new URL(item.redirect).host,
              requested: item.scopes,
              grantable,
              user,
              csrf: item.csrf,
            });
            return;
          }
          if (req.method !== 'POST') {
            res.status(405).end();
            return;
          }
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (!sameOrigin(req) || body.csrf !== item.csrf || item.approver !== user) {
            res.status(403).json({ error: 'Consent request verification failed' });
            return;
          }
          pending.delete(id);
          const target = new URL(item.redirect);
          if (body.decision !== 'allow') {
            target.searchParams.set('error', 'access_denied');
          } else {
            try {
              provider.clientsStore.approve(client.client_id);
            } catch {
              res.status(409).json({ error: 'Maximum active OAuth clients reached' });
              return;
            }
            const code = provider.createCode(
              client,
              {
                redirectUri: item.redirect,
                codeChallenge: item.challenge,
                scopes: grantable,
                resource: new URL(item.resource),
              },
              user
            );
            target.searchParams.set('code', code);
          }
          if (item.state) target.searchParams.set('state', item.state);
          res.json({ redirect: target.href });
        } catch (error) {
          next(error);
        }
      })
    );
  };
  const register = clientRegistrationHandler({
    clientsStore: provider.clientsStore,
    rateLimit: { windowMs: 3_600_000, max: 10, standardHeaders: true, legacyHeaders: false },
  });
  const token = tokenHandler({ provider });
  const revoke = revocationHandler({ provider });
  // The SDK router provides the standard AS paths and metadata when the issuer is HTTPS.
  // A custom consent gate is installed ahead of its authorization route.
  let sdkRouter: RequestHandler | undefined;
  let sdkIssuer = '';
  const server: RequestHandler = (req, res, next) => {
    const path = req.path;
    const normalizedPath = path.replace(/\/+$/, '').toLowerCase();
    if (normalizedPath === '/mcp/oauth/authorize') {
      if (req.method === 'GET') authorizePage(req, res, next);
      else res.status(405).set('Allow', 'GET').end();
      return;
    }
    if (normalizedPath.startsWith('/mcp/oauth/consent/')) {
      consentApi(req, res, next);
      return;
    }
    if (
      !['/mcp/oauth/token', '/mcp/oauth/register', '/mcp/oauth/revoke'].includes(normalizedPath)
    ) {
      next();
      return;
    }
    const base = issuer();
    if (base.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) {
      if (sdkIssuer !== base) {
        try {
          sdkRouter = mcpAuthRouter({
            provider,
            issuerUrl: new URL(base),
            baseUrl: new URL(`${base.replace(/\/$/, '')}/mcp/oauth/`),
            resourceServerUrl: new URL(resource()),
            scopesSupported: oauthScopes,
            clientRegistrationOptions: { rateLimit: { windowMs: 3_600_000, max: 10 } },
          });
          sdkIssuer = base;
        } catch {
          sdkRouter = undefined;
        }
      }
      if (sdkRouter) {
        const originalUrl = req.url;
        req.url = req.url.slice('/mcp/oauth'.length) || '/';
        sdkRouter(req, res, error => {
          req.url = originalUrl;
          next(error);
        });
        return;
      }
    }
    if (path === '/mcp/oauth/token') {
      atRoot(token, req, res, next);
      return;
    }
    if (path === '/mcp/oauth/register') {
      atRoot(register, req, res, next);
      return;
    }
    if (path === '/mcp/oauth/revoke') {
      atRoot(revoke, req, res, next);
      return;
    }
    next();
  };
  const metadata: RequestHandler = (req, res, next) => {
    const path = req.path;
    if (path === '/.well-known/oauth-authorization-server') {
      atRoot(
        metadataHandler({
          issuer: issuer(),
          authorization_endpoint: abs('/mcp/oauth/authorize'),
          token_endpoint: abs('/mcp/oauth/token'),
          registration_endpoint: abs('/mcp/oauth/register'),
          revocation_endpoint: abs('/mcp/oauth/revoke'),
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: oauthScopes,
        }),
        req,
        res,
        next
      );
      return;
    }
    if (
      path === '/.well-known/oauth-protected-resource/mcp' ||
      path === '/.well-known/oauth-protected-resource'
    ) {
      atRoot(
        metadataHandler({
          resource: canonicalResource(resource()),
          authorization_servers: [issuer()],
          scopes_supported: oauthScopes,
        }),
        req,
        res,
        next
      );
      return;
    }
    next();
  };
  const auth: RequestHandler = (req, res, next) => {
    try {
      const originalSet = res.set.bind(res);
      res.set = ((field: string | Record<string, string>, val?: string) => {
        if (field === 'WWW-Authenticate' && typeof val === 'string')
          val = val.replace('scope="read"', 'scope="read propose"');
        return typeof field === 'string' ? originalSet(field, val ?? '') : originalSet(field);
      }) as typeof res.set;
      requireBearerAuth({
        verifier: provider,
        requiredScopes: ['read'],
        resourceMetadataUrl: abs(
          RED.settings.httpNodeRoot === false || !RED.httpNode
            ? '/mcp/.well-known/oauth-protected-resource/mcp'
            : '/.well-known/oauth-protected-resource/mcp'
        ),
        expectedResource: new URL(resource()),
      })(req, res, error => {
        res.set = originalSet;
        next(error);
      });
    } catch (error) {
      next(error);
    }
  };
  return { server, metadata, auth };
}
