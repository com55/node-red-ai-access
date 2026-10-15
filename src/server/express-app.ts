/**
 * Express application setup for HTTP transport and SSE endpoints
 */

import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { NodeRedEventListener } from '../services/nodered-event-listener.js';
import type { ApiResponse } from '../types/mcp-extensions.js';
import type { NodeRedCredentials } from '../types/oauth.js';
import type { SSEEventFilter } from '../types/sse.js';
import {
  authenticate,
  authenticateAPIKey,
  authenticateBasic,
  verifyToken,
  getRateLimitKey,
} from '../utils/auth.js';
import type { AuthRequest } from '../utils/auth.js';
import {
  errorHandler,
  requestIdMiddleware,
  asyncHandler,
  ValidationError,
} from '../utils/error-handling.js';

import { McpNodeRedServer } from './mcp-server.js';
import { OAuthServer } from './oauth-server.js';
import { SessionManager } from './session-manager.js';
import { SSEHandler } from './sse-handler.js';

/** JSON-RPC 2.0 request body shape used by MCP endpoints. */
interface JsonRpcRequestBody {
  jsonrpc?: string;
  method?: string;
  params?: {
    name?: string;
    uri?: string;
    arguments?: Record<string, unknown>;
  };
  id?: string | number | null;
}

interface SubscribeRequestBody {
  connectionId?: string;
  eventTypes?: string[];
  eventType?: string;
  filter?: SSEEventFilter;
}

interface TriggerDeployBody {
  flowId?: string;
}

interface HealthDetails {
  flowCount?: number;
  nodeCount?: number;
}

// Mirrors package.json's "version" field. Other endpoints in this file
// (`/.well-known/mcp.json`, `/api/info`) already hardcode their own stale
// copies of this value rather than importing package.json — kept consistent
// with that existing pattern rather than introducing a new import mechanism.
const packageVersion = '2.0.0';

/**
 * Value accepted by Express's `trust proxy` setting.
 */
export type TrustProxySetting = boolean | number | string | string[];

/**
 * Parse the `TRUST_PROXY` environment variable into an Express `trust proxy`
 * value.
 *
 * Left unset, Express does not trust `X-Forwarded-For`, so every request behind
 * a reverse proxy is attributed to the proxy's own address: one shared
 * rate-limit bucket for all clients, and `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`
 * from express-rate-limit on the first proxied request.
 *
 * Accepted values:
 *   - a number    — hop count, e.g. `1` for a single proxy in front (recommended)
 *   - `false`     — no proxy; use the socket address (the default)
 *   - `true`      — trust every hop. Accepted, but warned about on startup: it
 *                   lets a client spoof its address by sending its own
 *                   `X-Forwarded-For`, and express-rate-limit reports it as
 *                   ERR_ERL_PERMISSIVE_TRUST_PROXY
 *   - anything else — passed through to Express as a trust list, e.g.
 *                   `loopback`, `10.0.0.0/8`, or a comma-separated combination
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim();
  if (!value) return false;

  const normalized = value.toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'true') {
    console.warn(
      'TRUST_PROXY=true is not recommended: it trusts every hop, so any client can spoof its ' +
        'address — and its rate-limit bucket — by sending its own X-Forwarded-For header. ' +
        'Set the number of proxies in front of this server instead (e.g. TRUST_PROXY=1), ' +
        'or list the trusted addresses (e.g. TRUST_PROXY=loopback,10.0.0.0/8).'
    );
    return true;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const entries = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  if (entries.length > 1) return entries;
  const [single] = entries;
  return single ?? value;
}

/**
 * Single source of truth for `CLAUDE_AUTH_REQUIRED`.
 *
 * This used to be read inline with two different fallbacks (`=== 'true'` in the
 * enforcement path, `!== 'false'` in the discovery/debug reporting paths), so an
 * unset variable made the server report one thing and do another. Auth is
 * required unless the variable is explicitly set to `false`, which matches the
 * unconditional `requireAuth` gate on the MCP/SSE endpoints.
 *
 * Read lazily (not captured at module load) so tests and runtime code that
 * mutate `process.env` still see the current value.
 */
export function isClaudeAuthRequired(): boolean {
  return process.env.CLAUDE_AUTH_REQUIRED?.trim().toLowerCase() !== 'false';
}

export interface ExpressAppConfig {
  port: number;
  host: string;
  cors: {
    origin: string | string[];
    credentials: boolean;
  };
  rateLimit: {
    windowMs: number;
    max: number;
  };
  helmet: boolean;
  /**
   * Express `trust proxy` setting. Defaults to `TRUST_PROXY`, or `false` when
   * that is unset.
   */
  trustProxy: TrustProxySetting;
}

export class ExpressApp {
  private app: express.Application;
  private mcpServer: McpNodeRedServer;
  private sseHandler: SSEHandler;
  private eventListener: NodeRedEventListener;
  private oauthServer: OAuthServer;
  private sessionManager: SessionManager;
  private config: ExpressAppConfig;
  private monitoringInterval: ReturnType<typeof setInterval> | null = null;

  constructor(mcpServer: McpNodeRedServer, config: Partial<ExpressAppConfig> = {}) {
    this.mcpServer = mcpServer;
    this.sseHandler = mcpServer.getSSEHandler();
    this.eventListener = new NodeRedEventListener(this.sseHandler, mcpServer.getNodeRedClient());
    this.oauthServer = new OAuthServer();
    this.sessionManager = new SessionManager();

    this.config = {
      port: parseInt(process.env.PORT ?? '3000'),
      host: process.env.HOST ?? '0.0.0.0',
      cors: {
        origin: process.env.CORS_ORIGIN?.split(',') ?? [
          'https://claude.ai',
          'https://www.claude.ai',
        ],
        credentials: process.env.CORS_CREDENTIALS === 'true',
      },
      rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '900000'), // 15 minutes
        max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '100'),
      },
      helmet: process.env.DISABLE_HELMET !== 'true',
      trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
      ...config,
    };

    this.app = express();
    // Must be set before the rate limiters read req.ip.
    this.app.set('trust proxy', this.config.trustProxy);
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  /**
   * Middleware that validates OAuth Bearer tokens (from OAuthServer) or falls
   * back to API key auth. Used on MCP/SSE endpoints.
   */
  private requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey) {
      return authenticateAPIKey(req as AuthRequest, res, next);
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      return authenticateBasic(req as AuthRequest, res, next);
    }

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Try OAuth opaque token first
      const oauthToken = this.oauthServer.validateToken(token);
      if (oauthToken) {
        (req as AuthRequest).auth = {
          userId: oauthToken.userId,
          permissions: oauthToken.scopes,
          isAuthenticated: true,
        };
        return next();
      }

      // Fall back to JWT
      const payload = verifyToken(token);
      if (payload) {
        (req as AuthRequest).auth = {
          userId: payload.userId,
          permissions: payload.permissions,
          isAuthenticated: true,
          ...(payload.exp !== undefined ? { tokenExpiry: new Date(payload.exp * 1000) } : {}),
        };
        return next();
      }
    }

    res.status(401).json({ error: 'Authentication required' });
  };

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Request ID middleware
    this.app.use(requestIdMiddleware);

    // Security middleware
    if (this.config.helmet) {
      this.app.use(
        helmet({
          contentSecurityPolicy: {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              connectSrc: ["'self'"],
            },
          },
          crossOriginOpenerPolicy: false,
        })
      );
    }

    // CORS middleware with Claude compatibility
    this.app.use(
      cors({
        origin: (origin, callback) => {
          const debugConnections = process.env.DEBUG_CLAUDE_CONNECTIONS === 'true';

          if (debugConnections) {
            // CORS origin check completed
          }

          // Allow Claude.ai domains and configured origins
          const configuredOrigins = Array.isArray(this.config.cors.origin)
            ? this.config.cors.origin
            : [this.config.cors.origin];
          const allowedOrigins = [
            'https://claude.ai',
            'https://www.claude.ai',
            'https://app.claude.ai',
            ...configuredOrigins,
          ].filter(Boolean);

          // Also allow the server's own public URL (form is served from our domain)
          const publicUrl = process.env.PUBLIC_URL;
          if (publicUrl) allowedOrigins.push(publicUrl);

          // Allow: no origin (same-origin/server-side), whitelisted origins, wildcard config
          if (!origin || allowedOrigins.some(o => typeof o === 'string' && origin.startsWith(o))) {
            callback(null, true);
          } else if (this.config.cors.origin === '*') {
            callback(null, true);
          } else {
            callback(null, false);
          }
        },
        credentials: this.config.cors.credentials,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'X-API-Key',
          'Cache-Control',
          'X-Requested-With',
          'Accept',
          'Origin',
          'Mcp-Session-Id',
        ],
      })
    );

    // Rate limiting — applied broadly
    const limiter = rateLimit({
      windowMs: this.config.rateLimit.windowMs,
      max: this.config.rateLimit.max,
      message: {
        error: 'Too many requests from this IP',
        retryAfter: Math.ceil(this.config.rateLimit.windowMs / 1000),
      },
      keyGenerator: getRateLimitKey,
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use('/api/', limiter);

    // Stricter rate limiting for OAuth and MCP endpoints
    const mcpLimiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 60,
      message: { error: 'Too many MCP requests' },
      standardHeaders: true,
      legacyHeaders: false,
    });
    const oauthLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 30,
      message: { error: 'Too many OAuth requests' },
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use('/mcp', mcpLimiter);
    this.app.use('/sse', mcpLimiter);
    this.app.use('/messages', mcpLimiter);
    // oauth-server.ts registers both '/oauth/*' and unprefixed ('/register',
    // '/authorize', '/token') routes for backward compatibility — both must
    // be rate-limited, or the unprefixed variants bypass it entirely.
    this.app.use(['/oauth/', '/register', '/authorize', '/token'], oauthLimiter);

    // Body parsing middleware
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    // Request logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // Request logged silently
      next();
    });
  }

  /**
   * Resolve tool/prompt arguments from a JSON-RPC params object.
   */
  private asArgumentRecord(value: unknown): Record<string, unknown> {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  /**
   * Dispatch a JSON-RPC MCP method to the underlying MCP server.
   * Shared by Streamable HTTP (/mcp) and legacy JSON-RPC endpoints.
   */
  private async dispatchJsonRpcMethod(
    method: string,
    params: JsonRpcRequestBody['params'] | undefined,
    options: {
      nodeRedCredentials?: NodeRedCredentials | null;
      onInitialize?: () => void;
      allowNotificationAck?: boolean;
      /** Legacy endpoints use "… is required"; Streamable HTTP uses "… required". */
      verboseRequired?: boolean;
    } = {}
  ): Promise<{ kind: 'result'; result: unknown } | { kind: 'ack' } | { kind: 'method-not-found' }> {
    const requiredMsg = (label: string): string =>
      options.verboseRequired ? `${label} is required` : `${label} required`;

    switch (method) {
      case 'initialize': {
        options.onInitialize?.();
        return {
          kind: 'result',
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
            serverInfo: { name: 'nodered-mcp-server', version: '1.0.0' },
          },
        };
      }
      case 'notifications/initialized':
        if (options.allowNotificationAck) {
          return { kind: 'ack' };
        }
        throw new Error(`Unknown method: ${method}`);
      case 'tools/list':
        return { kind: 'result', result: await this.mcpServer.listTools() };
      case 'tools/call': {
        if (!params?.name) throw new Error(requiredMsg('Tool name'));
        const result = await this.mcpServer.callToolPublic(
          params.name,
          this.asArgumentRecord(params.arguments),
          options.nodeRedCredentials ?? undefined
        );
        return { kind: 'result', result };
      }
      case 'resources/list':
        return { kind: 'result', result: await this.mcpServer.listResources() };
      case 'resources/read': {
        if (!params?.uri) throw new Error(requiredMsg('Resource URI'));
        return { kind: 'result', result: await this.mcpServer.readResource(params.uri) };
      }
      case 'prompts/list':
        return { kind: 'result', result: await this.mcpServer.listPrompts() };
      case 'prompts/get': {
        if (!params?.name) throw new Error(requiredMsg('Prompt name'));
        const result = await this.mcpServer.getPromptPublic(
          params.name,
          this.asArgumentRecord(params.arguments)
        );
        return { kind: 'result', result };
      }
      default:
        return { kind: 'method-not-found' };
    }
  }

  private resourceMetadataUrl(): string {
    const resourceUrl = process.env.PUBLIC_URL ?? `http://${this.config.host}:${this.config.port}`;
    return resourceUrl;
  }

  /**
   * Enforce Bearer token when Claude auth is required and the request was not
   * already authenticated via API key / Basic. Returns true when the response
   * was already sent (caller should stop).
   */
  private rejectIfClaudeBearerMissing(req: Request, res: Response): boolean {
    const authReq = req as AuthRequest;
    if (!(isClaudeAuthRequired() && !authReq.auth?.isAuthenticated)) {
      return false;
    }

    const auth = req.headers.authorization;
    const resourceUrl = this.resourceMetadataUrl();
    if (!auth?.startsWith('Bearer ')) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource"`
      );
      res.status(401).json({ error: 'unauthorized', error_description: 'Bearer token required' });
      return true;
    }

    const tokenData = this.oauthServer.validateToken(auth.slice(7));
    if (!tokenData) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource", error="invalid_token"`
      );
      res
        .status(401)
        .json({ error: 'invalid_token', error_description: 'Token is invalid or expired' });
      return true;
    }

    return false;
  }

  private credentialsFromBearer(req: Request): {
    userId?: string;
    nodeRedCredentials?: NodeRedCredentials | null;
  } {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return {};
    }
    const tokenData = this.oauthServer.validateToken(auth.slice(7));
    if (!tokenData) {
      return {};
    }
    return {
      userId: tokenData.userId,
      ...(tokenData.credentialId
        ? {
            nodeRedCredentials: this.oauthServer.getNodeRedCredentials(tokenData.credentialId),
          }
        : {}),
    };
  }

  private resolveMcpSession(req: Request): {
    session: { id: string };
    isNewSession: boolean;
    nodeRedCredentials?: NodeRedCredentials | null;
  } {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const authReq = req as AuthRequest;

    let session = sessionId ? this.sessionManager.get(sessionId) : undefined;
    if (session && authReq.auth?.userId && session.userId !== authReq.auth.userId) {
      session = undefined;
    }

    if (!session) {
      const { userId, nodeRedCredentials } = this.credentialsFromBearer(req);
      return {
        session: this.sessionManager.create(userId),
        isNewSession: true,
        ...(nodeRedCredentials !== undefined ? { nodeRedCredentials } : {}),
      };
    }

    const { nodeRedCredentials } = this.credentialsFromBearer(req);
    return {
      session,
      isNewSession: false,
      ...(nodeRedCredentials !== undefined ? { nodeRedCredentials } : {}),
    };
  }

  /**
   * Handle POST /mcp (Streamable HTTP transport).
   */
  private async handleMcpPost(req: Request, res: Response): Promise<void> {
    if (this.rejectIfClaudeBearerMissing(req, res)) {
      return;
    }

    const { session, isNewSession, nodeRedCredentials } = this.resolveMcpSession(req);
    const { method, params, id, jsonrpc } = req.body as JsonRpcRequestBody;

    if (jsonrpc !== '2.0') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32600, message: 'Invalid Request — jsonrpc must be 2.0' },
      });
      return;
    }

    res.setHeader('Mcp-Session-Id', session.id);
    if (isNewSession) {
      res.setHeader('X-Mcp-Session-Created', 'true');
    }

    try {
      const outcome = await this.dispatchJsonRpcMethod(method ?? '', params, {
        ...(nodeRedCredentials !== undefined ? { nodeRedCredentials } : {}),
        onInitialize: () => {
          this.sessionManager.markInitialized(session.id);
        },
        allowNotificationAck: true,
      });

      if (outcome.kind === 'ack') {
        res.status(202).end();
        return;
      }
      if (outcome.kind === 'method-not-found') {
        res.status(200).json({
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32601, message: `Method not found: ${method ?? ''}` },
        });
        return;
      }
      res.json({ jsonrpc: '2.0', id: id ?? null, result: outcome.result });
    } catch (err) {
      res.status(200).json({
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : 'Internal error',
        },
      });
    }
  }

  /**
   * Handle legacy JSON-RPC MCP endpoints (/messages, /api/events).
   */
  private async handleLegacyJsonRpc(
    req: Request,
    res: Response,
    options: { logErrors?: boolean } = {}
  ): Promise<void> {
    try {
      const { method, params, id, jsonrpc } = req.body as JsonRpcRequestBody;

      if (jsonrpc !== '2.0') {
        res.status(400).json({
          jsonrpc: '2.0',
          id: id ?? null,
          error: {
            code: -32600,
            message: 'Invalid Request - jsonrpc must be 2.0',
          },
        });
        return;
      }

      const outcome = await this.dispatchJsonRpcMethod(method ?? '', params, {
        verboseRequired: true,
      });

      if (outcome.kind === 'method-not-found') {
        throw new Error(`Unknown method: ${method ?? ''}`);
      }
      if (outcome.kind === 'ack') {
        res.status(202).end();
        return;
      }

      res.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: outcome.result,
      });
    } catch (error) {
      const body = req.body as JsonRpcRequestBody;
      const errorResponse = {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        },
      };
      if (options.logErrors) {
        console.error('MCP JSON-RPC error:', errorResponse);
      }
      res.status(500).json(errorResponse);
    }
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    this.setupOAuthAndMcpTransportRoutes();
    this.setupPublicInfoRoutes();
    this.setupPublicApiRoutes();
    this.setupClaudeSseRoutes();
    this.setupSseManagementRoutes();
    this.setupSseAdminRoutes();
    this.setupNodeRedProxyRoutes();
    this.setupDebugAndFallbackRoutes();
  }

  private setupOAuthAndMcpTransportRoutes(): void {
    // ── OAuth 2.0 routes (must be before auth middleware) ─────────────────────
    const baseUrl = process.env.PUBLIC_URL ?? `http://${this.config.host}:${this.config.port}`;
    this.app.use(this.oauthServer.createRouter(baseUrl));

    // ── Root URL rewrite — Claude.ai POSTs to the bare domain the user registered ──
    // Rewrite POST / (with JSON-RPC body) to POST /mcp so the MCP handler picks it up
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (req.path === '/' && req.method === 'POST' && req.body?.jsonrpc) {
        req.url = '/mcp';
      }
      next();
    });

    // ── MCP Streamable HTTP Transport (spec 2025-03-26) ─────────────────────
    // GET /mcp — used by Claude.ai for endpoint discovery / SSE stream
    this.app.get('/mcp', (req: Request, res: Response) => {
      // If client wants SSE, open a stream; otherwise return server info
      if (req.headers.accept?.includes('text/event-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        // Send server info as first event
        const info = {
          name: 'nodered-mcp-server',
          version: '1.0.0',
          protocolVersion: '2025-03-26',
        };
        res.write(`data: ${JSON.stringify(info)}\n\n`);
        req.on('close', () => res.end());
      } else {
        const baseUrl = process.env.PUBLIC_URL ?? `http://${this.config.host}:${this.config.port}`;
        res.json({
          name: 'nodered-mcp-server',
          version: '1.0.0',
          protocolVersion: '2025-03-26',
          endpoint: `${baseUrl}/mcp`,
          transport: 'streamable-http',
        });
      }
    });

    // POST /mcp — Single endpoint handles initialize, tools/list, tools/call etc.
    this.app.post(
      '/mcp',
      this.requireAuth,
      asyncHandler(async (req: Request, res: Response) => {
        await this.handleMcpPost(req, res);
      })
    );

    // DELETE /mcp — session teardown
    this.app.delete('/mcp', (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId) this.sessionManager.delete(sessionId);
      res.status(204).end();
    });
  }

  private setupPublicInfoRoutes(): void {
    // Health check endpoint (public — minimal info only)
    this.app.get(
      '/health',
      asyncHandler(async (_req: Request, res: Response) => {
        const health = await this.mcpServer.getNodeRedClient().healthCheck();

        res.json({
          status: 'ok',
          nodeRed: health.healthy ? 'connected' : 'unreachable',
          timestamp: new Date().toISOString(),
        });
      })
    );

    // Version/build info endpoint (public — minimal info only).
    // GIT_SHA and BUILD_TIME are injected at Docker build time (see
    // docker/Dockerfile and .github/workflows/ci.yml); they read back as
    // 'unknown' for any build that doesn't set them (e.g. a local `yarn dev`
    // run), which is expected and not an error.
    this.app.get('/version', (_req: Request, res: Response) => {
      res.json({
        version: packageVersion,
        commitSha: process.env.GIT_SHA ?? 'unknown',
        buildTime: process.env.BUILD_TIME ?? 'unknown',
      });
    });

    // MCP Server Discovery endpoint (.well-known/mcp.json)
    // As per MCP November 2025 spec for server discovery
    this.app.get('/.well-known/mcp.json', (req: Request, res: Response) => {
      res.json({
        name: 'nodered-mcp-server',
        version: '1.0.0',
        description:
          'Model Context Protocol server for Node-RED integration with real-time SSE support',
        protocolVersion: '2025-03-26',
        capabilities: {
          tools: {
            listChanged: false,
          },
          resources: {
            subscribe: false,
            listChanged: false,
          },
          prompts: {
            listChanged: false,
          },
          logging: {},
        },
        endpoints: {
          http: {
            url: `http://${this.config.host}:${this.config.port}`,
            methods: ['POST'],
          },
          sse: {
            url: `http://${this.config.host}:${this.config.port}/sse`,
            methods: ['GET'],
          },
        },
        vendor: {
          author: 'com55',
          repository: 'https://github.com/com55/node-red-ai-access',
          documentation: 'https://github.com/com55/node-red-ai-access#readme',
        },
        tools: {
          count: 9,
          categories: ['flow-management', 'node-management', 'runtime-monitoring'],
        },
        resources: {
          types: ['flow', 'system'],
        },
        prompts: {
          count: 4,
          categories: ['flow-creation', 'debugging', 'optimization', 'documentation'],
        },
      });
    });

    // OAuth Protected Resource Metadata (RFC 9728)
    // Required by Claude.ai to discover the authorization server
    this.app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
      const resourceUrl =
        process.env.PUBLIC_URL ?? `http://${this.config.host}:${this.config.port}`;
      res.json({
        resource: resourceUrl,
        authorization_servers: [resourceUrl],
        scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
      });
    });

    // Simple ping endpoint for Claude website
    this.app.get('/ping', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        server: 'Node-RED AI Access',
      });
    });
  }

  private setupPublicApiRoutes(): void {
    // MCP initialization endpoint
    this.app.post(
      '/api/mcp/initialize',
      asyncHandler(async (req: Request, res: Response) => {
        const body = req.body as { jsonrpc?: string; id?: string | number };
        const jsonrpc = body.jsonrpc ?? '2.0';
        const id = body.id ?? 1;

        try {
          const tools = await this.mcpServer.listTools();
          const resources = await this.mcpServer.listResources();
          const prompts = await this.mcpServer.listPrompts();

          const response = {
            jsonrpc,
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {
                tools: {},
                resources: {},
                prompts: {},
                logging: {},
              },
              serverInfo: {
                name: 'nodered-mcp-server',
                version: '1.0.0',
              },
              tools: tools.tools,
              resources: resources.resources,
              prompts: prompts.prompts,
            },
          };

          res.json(response);
        } catch (error) {
          // MCP initialization failed silently
          res.status(500).json({
            jsonrpc,
            id,
            error: {
              code: -32603,
              message: 'Internal error during initialization',
              data: error instanceof Error ? error.message : String(error),
            },
          });
        }
      })
    );

    // API info endpoint
    this.app.get('/api/info', (req: Request, res: Response) => {
      const response: ApiResponse = {
        success: true,
        data: {
          name: 'Node-RED AI Access',
          version: '1.0.0',
          description: 'Model Context Protocol server for Node-RED integration',
          capabilities: {
            tools: true,
            resources: true,
            prompts: true,
            sse: true,
          },
        },
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    });
  }

  private setupClaudeSseRoutes(): void {
    // CORS preflight for SSE — handled by the global cors() middleware above

    // Claude website expects /sse endpoint (standard MCP SSE format)
    this.app.get(
      '/sse',
      this.requireAuth,
      asyncHandler(async (req: AuthRequest, res: Response) => {
        try {
          const debugConnections = process.env.DEBUG_CLAUDE_CONNECTIONS === 'true';

          if (debugConnections) {
            console.log('Claude SSE connection established:', {
              userAgent: req.get('User-Agent'),
              origin: req.get('Origin'),
              authenticated: req.auth?.isAuthenticated ?? false,
              userId: req.auth?.userId,
            });
          }

          // Set proper SSE headers for MCP
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-MCP-Server': 'nodered-mcp-server',
            'X-MCP-Version': '1.0.0',
            'X-MCP-Protocol': '2025-03-26',
          });

          // Do not log userId/token subjects — CodeQL treats oauth subjects as sensitive.
          console.log(
            `MCP SSE client connected (authenticated=${Boolean(req.auth?.isAuthenticated)})`
          );

          // Send initial MCP server capabilities immediately
          const serverInfo = {
            jsonrpc: '2.0',
            method: 'server/info',
            params: {
              name: 'nodered-mcp-server',
              version: '1.0.0',
              protocolVersion: '2025-03-26',
              capabilities: {
                tools: {},
                resources: {},
                prompts: {},
                logging: {},
              },
            },
          };

          // Send server info as initial SSE event
          res.write(`event: server-info\n`);
          res.write(`data: ${JSON.stringify(serverInfo)}\n\n`);

          // Send available tools list
          try {
            const tools = await this.mcpServer.listTools();
            const toolsEvent = {
              jsonrpc: '2.0',
              method: 'tools/list',
              result: tools,
            };
            res.write(`event: tools-list\n`);
            res.write(`data: ${JSON.stringify(toolsEvent)}\n\n`);
          } catch (error) {
            console.error('Failed to get tools list:', error);
          }

          // Send connection status
          res.write(`event: connection-status\n`);
          res.write(
            `data: {"status": "connected", "timestamp": "${new Date().toISOString()}"}\n\n`
          );

          // Keep connection alive with periodic heartbeat
          const heartbeatInterval = setInterval(() => {
            try {
              res.write(`event: heartbeat\n`);
              res.write(`data: {"timestamp": "${new Date().toISOString()}"}\n\n`);
            } catch {
              clearInterval(heartbeatInterval);
            }
          }, 30000);

          // Handle client disconnect
          req.on('close', () => {
            clearInterval(heartbeatInterval);
            console.log('MCP SSE client disconnected');
          });

          res.on('close', () => {
            clearInterval(heartbeatInterval);
          });

          res.on('error', () => {
            clearInterval(heartbeatInterval);
          });

          // Keep connection open for SSE
          return;
        } catch (error) {
          const debugConnections = process.env.DEBUG_CLAUDE_CONNECTIONS === 'true';

          if (debugConnections) {
            console.error('MCP SSE connection failed:', {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
              userAgent: req.get('User-Agent'),
              origin: req.get('Origin'),
            });
          } else {
            console.error('MCP SSE connection failed:', error);
          }

          if (!res.headersSent) {
            res.status(500).json({
              error: 'Failed to establish MCP SSE connection',
              details: debugConnections
                ? error instanceof Error
                  ? error.message
                  : String(error)
                : undefined,
              hint: 'Enable DEBUG_CLAUDE_CONNECTIONS=true for more details',
            });
          }
        }
      })
    );

    // MCP JSON-RPC endpoint for Claude website (standard MCP format)
    this.app.post(
      '/messages',
      this.requireAuth,
      asyncHandler(async (req: Request, res: Response) => {
        await this.handleLegacyJsonRpc(req, res, { logErrors: true });
      })
    );

    // MCP JSON-RPC endpoint for tool calls (POST requests) - legacy endpoint
    this.app.post(
      '/api/events',
      this.requireAuth,
      asyncHandler(async (req: Request, res: Response) => {
        await this.handleLegacyJsonRpc(req, res);
      })
    );
  }

  private setupSseManagementRoutes(): void {
    // Authenticated SSE connection endpoint (for secure access)
    this.app.get(
      '/api/events/secure',
      authenticate,
      asyncHandler((req: AuthRequest, res: Response) => {
        try {
          const connectionId = this.sseHandler.connect(req, res);

          // Subscribe to default events
          const defaultSubscriptions = ['heartbeat', 'system-info', 'connection-status'];
          this.sseHandler.subscribe(connectionId, defaultSubscriptions);

          console.log(`SSE client connected: ${connectionId} (authenticated)`);

          // Keep connection open for SSE
          return;
        } catch (error) {
          console.error('SSE connection failed:', error);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to establish SSE connection' });
          }
        }
      })
    );

    // SSE subscription management
    this.app.post(
      '/api/events/subscribe',
      authenticate,
      asyncHandler((req: AuthRequest, res: Response) => {
        const { connectionId, eventTypes } = req.body as SubscribeRequestBody;

        if (!connectionId || !Array.isArray(eventTypes)) {
          throw new ValidationError('connectionId and eventTypes array are required');
        }

        this.sseHandler.subscribe(connectionId, eventTypes);

        const response: ApiResponse = {
          success: true,
          data: { message: 'Subscribed successfully', eventTypes },
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );

    // Advanced subscription management with filters
    this.app.post(
      '/api/events/subscribe/filtered',
      authenticate,
      asyncHandler((req: AuthRequest, res: Response) => {
        const { connectionId, eventType, filter } = req.body as SubscribeRequestBody;

        if (!connectionId || !eventType) {
          throw new ValidationError('connectionId and eventType are required');
        }

        this.sseHandler.subscribeWithFilter(connectionId, eventType, filter);

        const response: ApiResponse = {
          success: true,
          data: { message: 'Subscribed with filter successfully', eventType, filter },
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );

    // Get subscription details
    this.app.get(
      '/api/events/subscriptions/:connectionId',
      authenticate,
      asyncHandler((req: AuthRequest, res: Response) => {
        const connectionId = req.params.connectionId;

        if (!connectionId) {
          throw new ValidationError('Connection ID is required');
        }

        const subscriptions = this.sseHandler.getSubscriptions(connectionId);

        const response: ApiResponse = {
          success: true,
          data: subscriptions,
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );

    this.app.post(
      '/api/events/unsubscribe',
      authenticate,
      asyncHandler((req: AuthRequest, res: Response) => {
        const { connectionId, eventTypes } = req.body as SubscribeRequestBody;

        if (!connectionId || !Array.isArray(eventTypes)) {
          throw new ValidationError('connectionId and eventTypes array are required');
        }

        this.sseHandler.unsubscribe(connectionId, eventTypes);

        const response: ApiResponse = {
          success: true,
          data: { message: 'Unsubscribed successfully', eventTypes },
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );
  }

  private setupSseAdminRoutes(): void {
    // SSE statistics endpoint
    this.app.get('/api/events/stats', authenticate, (req: Request, res: Response) => {
      const stats = this.sseHandler.getStats();

      const response: ApiResponse = {
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    });

    // SSE clients endpoint
    this.app.get('/api/events/clients', authenticate, (req: Request, res: Response) => {
      const clients = this.sseHandler.getClients();

      const response: ApiResponse = {
        success: true,
        data: clients,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    });

    // Disconnect SSE client
    this.app.delete(
      '/api/events/clients/:connectionId',
      authenticate,
      (req: Request, res: Response) => {
        const connectionId = req.params.connectionId;
        if (!connectionId) {
          const response: ApiResponse = {
            success: false,
            error: {
              code: 'INVALID_REQUEST',
              message: 'Connection ID is required',
            },
            timestamp: new Date().toISOString(),
          };
          return res.status(400).json(response);
        }
        const disconnected = this.sseHandler.forceDisconnect(connectionId);

        const response: ApiResponse = {
          success: disconnected,
          data: {
            message: disconnected
              ? 'Client disconnected successfully'
              : 'Client not found or already disconnected',
          },
          timestamp: new Date().toISOString(),
        };

        return res.status(disconnected ? 200 : 404).json(response);
      }
    );

    // Event monitoring status
    this.app.get('/api/events/monitoring', authenticate, (req: Request, res: Response) => {
      const status = this.eventListener.getStatus();

      const response: ApiResponse = {
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      };

      res.json(response);
    });

    // Manually trigger flow deploy event
    this.app.post(
      '/api/events/trigger/deploy',
      authenticate,
      asyncHandler((req: AuthRequest, res: Response) => {
        const { flowId } = req.body as TriggerDeployBody;

        this.eventListener.onFlowDeploy(flowId);

        const response: ApiResponse = {
          success: true,
          data: { message: 'Flow deploy event triggered', flowId },
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );
  }

  private setupNodeRedProxyRoutes(): void {
    // Node-RED proxy endpoints (optional - for direct API access)
    this.app.get(
      '/api/nodered/flows',
      authenticate,
      asyncHandler(async (req: AuthRequest, res: Response) => {
        const flows = await this.mcpServer.getNodeRedClient().getFlows();

        const response: ApiResponse = {
          success: true,
          data: flows,
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );

    this.app.get(
      '/api/nodered/nodes',
      authenticate,
      asyncHandler(async (req: AuthRequest, res: Response) => {
        const nodes = await this.mcpServer.getNodeRedClient().getNodeTypes();

        const response: ApiResponse = {
          success: true,
          data: nodes,
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );

    this.app.get(
      '/api/nodered/runtime',
      authenticate,
      asyncHandler(async (req: AuthRequest, res: Response) => {
        const runtime = await this.mcpServer.getNodeRedClient().getRuntimeInfo();

        const response: ApiResponse = {
          success: true,
          data: runtime,
          timestamp: new Date().toISOString(),
        };

        res.json(response);
      })
    );
  }

  private setupDebugAndFallbackRoutes(): void {
    // MCP Server Discovery endpoint (for Claude.ai integration)
    this.app.get(
      '/.well-known/mcp-server',
      asyncHandler((req: Request, res: Response) => {
        const isClaudeMode = process.env.CLAUDE_COMPATIBLE_MODE === 'true';
        const authRequired = isClaudeAuthRequired();

        const serverInfo = {
          name: 'nodered-mcp-server',
          version: '1.0.0',
          description: 'Node-RED MCP Server for flow and node management',
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            logging: {},
          },
          endpoints: {
            sse: `${req.protocol}://${req.get('host')}/sse`,
            jsonrpc: `${req.protocol}://${req.get('host')}/messages`,
            health: `${req.protocol}://${req.get('host')}/health`,
          },
          auth: {
            type: authRequired ? 'bearer' : 'none',
            required: authRequired,
            modes: isClaudeMode ? ['none', 'bearer', 'api-key'] : ['bearer', 'api-key'],
          },
          transport: {
            type: 'sse',
            version: '2025-03-26',
          },
          server: {
            vendor: 'nodered-mcp-sse',
            version: '1.0.0',
            features: ['tools', 'resources', 'prompts', 'logging', 'streaming'],
          },
        };

        res.json(serverInfo);
      })
    );

    // MCP Server Info endpoint (alternative discovery)
    this.app.get(
      '/api/mcp/info',
      asyncHandler((_req: Request, res: Response) => {
        const serverInfo = {
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
              logging: {},
            },
            serverInfo: {
              name: 'nodered-mcp-server',
              version: '1.0.0',
              description: 'Node-RED MCP Server for flow and node management',
            },
          },
        };

        res.json(serverInfo);
      })
    );

    // Debugging endpoint for Claude connection testing
    this.app.get(
      '/debug/claude-connection',
      asyncHandler(async (req: Request, res: Response) => {
        const debugInfo: {
          server: Record<string, unknown>;
          request: Record<string, unknown>;
          endpoints: Record<string, unknown>;
          nodeRed: Record<string, unknown>;
        } = {
          server: {
            claudeMode: process.env.CLAUDE_COMPATIBLE_MODE === 'true',
            authRequired: isClaudeAuthRequired(),
            acceptAnyToken: process.env.ACCEPT_ANY_BEARER_TOKEN === 'true',
            fallbackEnabled: process.env.AUTH_FALLBACK_ENABLED === 'true',
            debugConnections: process.env.DEBUG_CLAUDE_CONNECTIONS === 'true',
          },
          request: {
            userAgent: req.get('User-Agent'),
            origin: req.get('Origin'),
            authorization: req.headers.authorization ? 'present' : 'missing',
            apiKey: req.headers['x-api-key'] ? 'present' : 'missing',
            headers: Object.keys(req.headers),
          },
          endpoints: {
            sse: `${req.protocol}://${req.get('host')}/sse`,
            health: `${req.protocol}://${req.get('host')}/health`,
            discovery: `${req.protocol}://${req.get('host')}/.well-known/mcp-server`,
          },
          nodeRed: {
            status: 'checking...',
          },
        };

        // Test Node-RED connection
        try {
          const healthResult = await this.mcpServer.getNodeRedClient().healthCheck();
          debugInfo.nodeRed = {
            status: 'connected',
            health: healthResult,
          };
        } catch (error) {
          debugInfo.nodeRed = {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
        }

        res.json(debugInfo);
      })
    );

    // Catch-all for undefined routes

    // Catch-all for undefined routes (Express 5 with path-to-regexp v8 requires named wildcard)
    this.app.use('/{*splat}', (req: Request, res: Response) => {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Route ${req.method} ${req.originalUrl} not found`,
        },
        timestamp: new Date().toISOString(),
      };

      res.status(404).json(response);
    });
  }

  /**
   * Setup error handling middleware
   */
  private setupErrorHandling(): void {
    this.app.use(errorHandler);
  }

  /**
   * Start the Express server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const server = this.app.listen(this.config.port, this.config.host, () => {
          console.log(`Express server listening on http://${this.config.host}:${this.config.port}`);
          console.log(`Available endpoints:`);
          console.log(`  - Health: GET /health`);
          console.log(`  - API Info: GET /api/info`);
          console.log(`  - SSE Events: GET /api/events`);
          console.log(`  - SSE Stats: GET /api/events/stats`);
          console.log(`  - Node-RED Flows: GET /api/nodered/flows`);
          console.log(`  - Node-RED Nodes: GET /api/nodered/nodes`);
          console.log(`  - Node-RED Runtime: GET /api/nodered/runtime`);
          resolve();
        });

        server.on('error', error => {
          reject(error);
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
          console.log('SIGTERM received, shutting down gracefully');
          server.close(() => {
            console.log('Express server closed');
            this.sseHandler.destroy();
            process.exit(0);
          });
        });

        process.on('SIGINT', () => {
          console.log('SIGINT received, shutting down gracefully');
          server.close(() => {
            console.log('Express server closed');
            this.sseHandler.destroy();
            process.exit(0);
          });
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Get Express app instance
   */
  getApp(): express.Application {
    return this.app;
  }

  /**
   * Send system information via SSE
   */
  sendSystemInfo(): void {
    this.mcpServer
      .getNodeRedClient()
      .healthCheck()
      .then(health => {
        const details = health.details as HealthDetails;
        this.sseHandler.sendSystemInfo({
          nodeRedStatus: health.healthy ? 'connected' : 'error',
          activeFlows: details.flowCount ?? 0,
          totalNodes: details.nodeCount ?? 0,
        });
      })
      .catch(error => {
        console.error('Failed to get Node-RED health for SSE:', error);
        this.sseHandler.sendError('Failed to get Node-RED status', undefined, 'system-monitor');
      });
  }

  /**
   * Start system monitoring (send periodic updates via SSE)
   */
  startSystemMonitoring(intervalMs = 30000): void {
    this.monitoringInterval = setInterval(() => {
      this.sendSystemInfo();
    }, intervalMs);
    this.eventListener.startEventMonitoring();
  }

  /**
   * Stop system monitoring
   */
  stopSystemMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.eventListener.stopEventMonitoring();
  }

  /**
   * Get event listener status
   */
  getEventListenerStatus(): { isMonitoring: boolean; lastEventTimestamp: number } {
    return this.eventListener.getStatus();
  }
}
