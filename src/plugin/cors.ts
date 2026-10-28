/**
 * CORS policy for the AI-facing surfaces (`/mcp/a/*`, `/mcp/api/*`, `/mcp/rpc`, `/mcp`).
 *
 * Node-RED's admin app sends `Access-Control-Allow-Origin: *` for every admin
 * route. For AI-facing routes the plugin replaces that with an explicit
 * allow-list (`settings.aiAccess.corsAllowedOrigins`): no CORS headers by
 * default, and the request `Origin` echoed back only when it is listed.
 * CORS only affects code running in a browser; server-side HTTP clients are
 * unaffected either way.
 */

import type { NextFunction, Request, Response } from 'express';

/** Paths (relative to httpAdminRoot) covered by this policy. */
export const AI_CORS_PATH = /^\/mcp(?:\/?$|\/(?:a(?:\/|$)|api(?:\/|$)|rpc\/?$))/;

export const CORS_ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
export const CORS_ALLOWED_HEADERS =
  'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID';
export const CORS_EXPOSED_HEADERS =
  'Mcp-Session-Id, WWW-Authenticate, Retry-After, RateLimit, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset';
export const CORS_MAX_AGE_SECONDS = 600;

/**
 * Normalize configured origins to `scheme://host[:port]` (lower-case, no path).
 * Invalid entries are dropped; `*` is not supported.
 */
export function normalizeCorsOrigins(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out = new Set<string>();
  for (const entry of list) {
    const canonical = canonicalOrigin(entry);
    if (canonical) out.add(canonical);
  }
  return [...out];
}

/**
 * Canonical `scheme://host[:port]` (lower-case, default port dropped) for an
 * Origin header value. Malformed values, `null`, and values carrying a path,
 * query, fragment, or credentials return undefined.
 */
export function canonicalOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== '/' || /^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i.test(value)) return undefined;
  return url.origin.toLowerCase();
}

function appendVary(res: Response, value: string): void {
  const existing = res.getHeader('Vary');
  const parts = String(existing ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  if (!parts.some(p => p.toLowerCase() === value.toLowerCase())) {
    parts.push(value);
  }
  res.setHeader('Vary', parts.join(', '));
}

/**
 * Middleware enforcing the allow-list on AI-facing paths. Must run before any
 * other CORS middleware (see {@link installAiCorsMiddleware}).
 */
export function aiCorsMiddleware(getAllowedOrigins: () => string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!AI_CORS_PATH.test(req.path)) {
      next();
      return;
    }

    // Drop CORS headers set by other middleware (Node-RED core sends `*`).
    for (const name of res.getHeaderNames()) {
      if (name.startsWith('access-control-')) res.removeHeader(name);
    }
    const originalSetHeader = res.setHeader.bind(res);
    let owned = false;
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (!owned && /^access-control-/i.test(name)) {
        return res;
      }
      return originalSetHeader(name, value);
    }) as Response['setHeader'];

    const requestOrigin = canonicalOrigin(req.get('origin'));
    const origin =
      requestOrigin === undefined
        ? undefined
        : getAllowedOrigins().find(entry => entry === requestOrigin);
    const allowed = origin !== undefined;

    appendVary(res, 'Origin');
    if (!allowed) {
      if (req.method === 'OPTIONS' && req.get('access-control-request-method')) {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    owned = true;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
    if (req.method === 'OPTIONS' && req.get('access-control-request-method')) {
      res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS));
      res.status(204).end();
      return;
    }
    owned = false;
    next();
  };
}

interface RouterLike {
  stack: unknown[];
}

/**
 * Register the middleware so it runs before Node-RED's built-in
 * `cors({ origin: '*' })`. Plugins receive the runtime admin app, which
 * Node-RED mounts inside the editor-api admin app *after* that CORS handler,
 * so the middleware goes on the parent app (when mounted) and is moved to the
 * front of its router stack. Express 4 keeps the router on `app._router`,
 * Express 5 on `app.router`.
 */
export function installAiCorsMiddleware(
  app: { use: (fn: ReturnType<typeof aiCorsMiddleware>) => unknown },
  middleware: ReturnType<typeof aiCorsMiddleware>
): void {
  const parent = (app as unknown as { parent?: typeof app }).parent;
  const target = parent && typeof parent.use === 'function' ? parent : app;
  target.use(middleware);
  const holder = target as unknown as { _router?: RouterLike; router?: RouterLike };
  const router = holder._router ?? holder.router;
  const stack = router?.stack;
  if (!Array.isArray(stack) || stack.length < 2) return;
  const layer = stack.pop();
  // Keep Express's own init layers (query parser / expressInit) first.
  let index = 0;
  while (index < stack.length) {
    const name = (stack[index] as { name?: string }).name;
    if (name !== 'query' && name !== 'expressInit') break;
    index += 1;
  }
  stack.splice(index, 0, layer);
}
