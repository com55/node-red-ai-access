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

import { requireAdminSession } from './auth.js';
import type { AuthenticatedRequest, NodeRedPluginAPI } from './types.js';

interface OAuthDb {
  clients: (OAuthClientInformationFull & { lastUsedAt?: number })[];
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
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
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
    const active = new Set(
      this.db.clients
        .filter(c => (c.lastUsedAt ?? (c.client_id_issued_at ?? 0) * 1000) > now - 30 * 86400_000)
        .map(c => c.client_id)
    );
    this.db.clients = this.db.clients.filter(c => active.has(c.client_id));
    this.db.codes = this.db.codes.filter(c => c.expires > now && active.has(c.clientId));
    this.db.tokens = this.db.tokens.filter(
      t => active.has(t.clientId) && (t.expires > now || t.rotated)
    );
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
    if (this.db.clients.length >= this.maxClients())
      throw new InvalidClientMetadataError('Maximum active OAuth clients reached');
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
  get data(): OAuthDb {
    return this.db;
  }
  persist(): void {
    this.save();
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
  }
  const expressApp = app as
    { _router?: { stack?: Layer[] }; router?: { stack?: Layer[] } } | undefined;
  const layers = expressApp?._router?.stack ?? expressApp?.router?.stack ?? [];
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
    if (!paths.length && layer.matchers?.length && layer.name !== 'router') {
      const matches = (path: string) => layer.matchers?.some(matcher => Boolean(matcher(path)));
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
  constructor(
    readonly clientsStore: OAuthStore,
    private readonly resource: () => string,
    private readonly accessTtl: () => number,
    private readonly refreshTtl: () => number
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
    const found = this.findCode(client, code);
    return found.challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const item = this.findCode(client, code);
    if (
      item.expires <= Date.now() ||
      redirectUri !== item.redirectUri ||
      (resource && canonicalResource(resource.href) !== item.resource)
    )
      throw new InvalidGrantError('Invalid authorization code');
    this.clientsStore.data.codes = this.clientsStore.data.codes.filter(c => c !== item);
    this.clientsStore.persist();
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
    if (resource && canonicalResource(resource.href) !== item.resource)
      throw new InvalidGrantError('Resource mismatch');
    if (scopes?.some(s => !item.scopes.includes(s))) throw new InvalidGrantError('Invalid scope');
    item.rotated = true;
    return this.issue(
      client.client_id,
      scopes ?? item.scopes,
      item.resource,
      item.user,
      item.family
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
    this.clientsStore.persist();
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
    family = secret()
  ): OAuthTokens {
    const access = secret(),
      refresh = secret(),
      now = Date.now();
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
        expires: now + this.refreshTtl() * 1000,
        user,
        rotated: false,
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
  const consent: RequestHandler = (req: AuthenticatedRequest, res, next) => {
    express.urlencoded({ extended: false })(req, res, () =>
      requireAdminSession(RED, 'page')(req, res, () => {
        try {
          const q =
            req.method === 'POST' ? (req.body as Record<string, unknown> | undefined) : req.query;
          if (!q) {
            res.status(400).send('Invalid authorization request');
            return;
          }
          const client = provider.clientsStore.getClient(value(q.client_id));
          if (!client) {
            res.status(400).send('Unknown OAuth client');
            return;
          }
          const redirect =
            value(q.redirect_uri) ||
            (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : '');
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
          const scopes = (value(q.scope) || 'read').split(' ').filter(Boolean);
          if (scopes.some(scope => !oauthScopes.includes(scope))) {
            res.status(400).send('Unsupported scope');
            return;
          }
          const requested = value(q.resource) || resource();
          if (canonicalResource(requested) !== canonicalResource(resource())) {
            res.status(400).send('Resource mismatch');
            return;
          }
          const redirectHost = new URL(redirect).hostname;
          if (req.method !== 'POST' || q.accept !== '1') {
            const hidden = Object.entries({
              client_id: client.client_id,
              redirect_uri: redirect,
              response_type: 'code',
              code_challenge: value(q.code_challenge),
              code_challenge_method: 'S256',
              scope: scopes.join(' '),
              state: value(q.state),
              resource: requested,
            })
              .map(
                ([name, field]) =>
                  `<input type="hidden" name="${name}" value="${escapeHtml(field)}">`
              )
              .join('');
            res.setHeader('Cache-Control', 'no-store');
            res
              .status(200)
              .type('html')
              .send(
                `<!doctype html><html lang="en"><meta charset="utf-8"><title>OAuth consent</title><h1>Authorize ${escapeHtml(client.client_name || 'OAuth client')}</h1><p>Redirect URI host: ${escapeHtml(redirectHost)}</p>${loopback.has(redirectHost) ? '<p>Warning: this redirect URI is reachable only on this machine.</p>' : ''}<p>Permissions: ${escapeHtml(scopes.join(', '))}</p><form method="post">${hidden}<button name="accept" value="1">Allow</button></form></html>`
              );
            return;
          }
          const user = RED.settings.adminAuth ? req.user?.username : 'owner';
          const code = provider.createCode(
            client,
            {
              redirectUri: redirect,
              codeChallenge: value(q.code_challenge),
              scopes,
              resource: new URL(requested),
            },
            user || 'owner'
          );
          const target = new URL(redirect);
          target.searchParams.set('code', code);
          if (q.state) target.searchParams.set('state', value(q.state));
          res.redirect(302, target.href);
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
      consent(req, res, next);
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
