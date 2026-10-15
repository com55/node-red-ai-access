/**
 * Rate limiting for AI Access admin routes (CodeQL / missing-rate-limiting).
 */

import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';

/** Shared limiter for `/mcp` and `/mcp/api/v1/*` (per IP). */
export function createAiAccessRateLimiter(): RateLimitRequestHandler {
  return rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
}
