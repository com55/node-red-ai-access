import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  aiCorsMiddleware,
  CORS_ALLOWED_HEADERS,
  installAiCorsMiddleware,
  normalizeCorsOrigins,
} from '../../src/plugin/cors.js';

/** Mimic Node-RED's admin app, which sends `Access-Control-Allow-Origin: *` first. */
function nodeRedLikeApp(allowed: string[]): express.Express {
  const app = express();
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
      res.status(204).end();
      return;
    }
    next();
  });
  const origins = normalizeCorsOrigins(allowed);
  installAiCorsMiddleware(
    app,
    aiCorsMiddleware(() => origins)
  );
  app.get('/mcp/api/v1/status', (_req, res) => res.json({ ok: true }));
  app.get('/mcp/a/aia_x/status', (_req, res) => res.json({ ok: true }));
  app.post('/mcp/rpc', (_req, res) => res.json({ ok: true }));
  app.get('/editor-thing', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('AI-facing CORS', () => {
  it('sends no CORS headers by default on GET link, REST, and MCP', async () => {
    const app = nodeRedLikeApp([]);
    for (const [method, path] of [
      ['get', '/mcp/api/v1/status'],
      ['get', '/mcp/a/aia_x/status'],
      ['post', '/mcp/rpc'],
    ] as const) {
      const res = await request(app)[method](path).set('Origin', 'https://site.example');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers.vary).toMatch(/Origin/);
    }
  });

  it('leaves non-AI admin routes untouched', async () => {
    const res = await request(nodeRedLikeApp([]))
      .get('/editor-thing')
      .set('Origin', 'https://site.example');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('echoes an allow-listed origin with Vary: Origin', async () => {
    const app = nodeRedLikeApp(['https://App.example/']);
    const res = await request(app).get('/mcp/api/v1/status').set('Origin', 'https://app.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(res.headers.vary).toMatch(/Origin/);
    expect(res.headers['access-control-expose-headers']).toMatch(/Mcp-Session-Id/);
  });

  it('answers preflight for an allowed origin with methods and headers', async () => {
    const res = await request(nodeRedLikeApp(['https://app.example']))
      .options('/mcp/rpc')
      .set('Origin', 'https://app.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type, mcp-session-id');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(res.headers['access-control-allow-headers']).toBe(CORS_ALLOWED_HEADERS);
    expect(res.headers['access-control-allow-headers']).toMatch(/Mcp-Session-Id/);
  });

  it('gives no CORS headers to origins not on the list (actual and preflight)', async () => {
    const app = nodeRedLikeApp(['https://app.example']);
    const res = await request(app).get('/mcp/a/aia_x/status').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(app)
      .options('/mcp/api/v1/status')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    expect(pre.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('normalizeCorsOrigins keeps valid http(s) origins only', () => {
    expect(
      normalizeCorsOrigins(['https://a.example/path', '*', 'ftp://x', 'nope', 'http://b:8080'])
    ).toEqual(['https://a.example', 'http://b:8080']);
    expect(normalizeCorsOrigins(undefined)).toEqual([]);
  });
});
