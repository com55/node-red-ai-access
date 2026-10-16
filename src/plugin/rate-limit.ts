/**
 * In-memory rate limiting for `/mcp/api/*` and `/mcp/a/*`
 * (CodeQL missing-rate-limiting + consistent 429 JSON).
 *
 * Dual buckets: per IP and per access-link token (whichever trips first).
 */

import type { NextFunction, Request, Response } from 'express';
import rateLimit, {
  ipKeyGenerator,
  type Options,
  type RateLimitRequestHandler,
} from 'express-rate-limit';

import type { AiAccessSettings, AuthenticatedRequest } from './types.js';

/** Generous defaults — AI clients often poll status/flows while drafting. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_PER_IP = 600;
export const DEFAULT_RATE_LIMIT_MAX_PER_TOKEN = 300;

export interface RateLimitConfig {
  windowMs: number;
  maxPerIp: number;
  maxPerToken: number;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/** Resolve limits from `aiAccess` settings (or explicit RateLimitConfig overrides). */
export function resolveRateLimitConfig(
  settings?: AiAccessSettings | Partial<RateLimitConfig> | null
): RateLimitConfig {
  if (!settings) {
    return {
      windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
      maxPerIp: DEFAULT_RATE_LIMIT_MAX_PER_IP,
      maxPerToken: DEFAULT_RATE_LIMIT_MAX_PER_TOKEN,
    };
  }
  const asCfg = settings as Partial<RateLimitConfig> & AiAccessSettings;
  return {
    windowMs: positiveInt(asCfg.windowMs ?? asCfg.rateLimitWindowMs, DEFAULT_RATE_LIMIT_WINDOW_MS),
    maxPerIp: positiveInt(asCfg.maxPerIp ?? asCfg.rateLimitMaxPerIp, DEFAULT_RATE_LIMIT_MAX_PER_IP),
    maxPerToken: positiveInt(
      asCfg.maxPerToken ?? asCfg.rateLimitMaxPerToken,
      DEFAULT_RATE_LIMIT_MAX_PER_TOKEN
    ),
  };
}

function retryAfterSeconds(req: Request, windowMs: number): number {
  const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
  const reset = info?.resetTime;
  if (reset instanceof Date && !Number.isNaN(reset.getTime())) {
    return Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000));
  }
  return Math.max(1, Math.ceil(windowMs / 1000));
}

/** Shared 429 body + Retry-After for API and GET-link surfaces. */
export function sendRateLimited(
  req: Request,
  res: Response,
  windowMs: number = DEFAULT_RATE_LIMIT_WINDOW_MS
): void {
  const retryAfter = retryAfterSeconds(req, windowMs);
  res.setHeader('Retry-After', String(retryAfter));
  res.setHeader('Cache-Control', 'no-store');
  res.status(429).json({
    error: 'Too many requests. Slow down and retry.',
    code: 'rate_limited',
    retryAfter,
    hint: 'Wait for retryAfter seconds, then continue. Prefer draft chunking for large content.',
  });
}

function rateLimitedHandler(windowMs: number): Options['handler'] {
  return (req: Request, res: Response, _next: NextFunction, _options: Options) => {
    sendRateLimited(req, res, windowMs);
  };
}

function clientIpKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

/**
 * Shared per-token key across GET `/mcp/a/<token>`, REST Bearer, and MCP.
 * Prefer the raw token (path or Authorization) so the same link hits one bucket
 * regardless of surface. Fall back to validated `accessLink.id` only when the
 * raw token is not on the request.
 * Keys use a short prefix of the token (not logged elsewhere).
 */
export function accessTokenRateLimitKey(req: Request): string | null {
  const pathToken = req.params.token;
  if (typeof pathToken === 'string' && pathToken.length > 0) {
    return `token:${pathToken.slice(0, 48)}`;
  }
  const header = req.get('authorization') ?? req.headers.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(\S+)/i.exec(header.trim());
    const raw = m?.[1];
    if (raw && (raw.startsWith('aia_') || raw.length >= 24)) {
      return `token:${raw.slice(0, 48)}`;
    }
  }
  const authReq = req as AuthenticatedRequest;
  if (authReq.accessLink?.id) {
    return `token:link:${authReq.accessLink.id}`;
  }
  return null;
}

function createLimiter(
  max: number,
  windowMs: number,
  keyGenerator: (req: Request) => string,
  skip?: (req: Request) => boolean
): RateLimitRequestHandler {
  const options: Parameters<typeof rateLimit>[0] = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: rateLimitedHandler(windowMs),
  };
  if (skip) {
    options.skip = skip;
  }
  return rateLimit(options);
}

/** Per-IP limiter for `/mcp` and `/mcp/api/v1/*`. */
export function createAiAccessRateLimiter(
  settings?: AiAccessSettings | Partial<RateLimitConfig> | null
): RateLimitRequestHandler {
  const cfg = resolveRateLimitConfig(settings);
  return createLimiter(cfg.maxPerIp, cfg.windowMs, clientIpKey);
}

/** Per-access-token limiter (skips when no token/link is present on the request). */
export function createAiAccessTokenRateLimiter(
  settings?: AiAccessSettings | Partial<RateLimitConfig> | null
): RateLimitRequestHandler {
  const cfg = resolveRateLimitConfig(settings);
  return createLimiter(
    cfg.maxPerToken,
    cfg.windowMs,
    (req: Request) => accessTokenRateLimitKey(req) ?? clientIpKey(req),
    (req: Request) => accessTokenRateLimitKey(req) == null
  );
}

/** Dual stack: IP then token. */
export function createAiAccessDualRateLimiters(
  settings?: AiAccessSettings | Partial<RateLimitConfig> | null
): {
  ip: RateLimitRequestHandler;
  token: RateLimitRequestHandler;
  stack: RateLimitRequestHandler[];
  config: RateLimitConfig;
} {
  const cfg = resolveRateLimitConfig(settings);
  const ip = createAiAccessRateLimiter(cfg);
  const token = createAiAccessTokenRateLimiter(cfg);
  return { ip, token, stack: [ip, token], config: cfg };
}

/**
 * GET-link single middleware (token key when present, else IP).
 * Prefer {@link createAiAccessDualRateLimiters} for explicit IP+token stacks.
 */
export function createGetLinkRateLimiter(
  settings?: AiAccessSettings | Partial<RateLimitConfig> | null
): RateLimitRequestHandler {
  const cfg = resolveRateLimitConfig(settings);
  return createLimiter(
    cfg.maxPerToken,
    cfg.windowMs,
    (req: Request) => accessTokenRateLimitKey(req) ?? clientIpKey(req)
  );
}
