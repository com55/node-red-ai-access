/**
 * JSON / JSON-RPC error middleware for /mcp* (no HTML stack leaks).
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { mcpJsonErrorHandler } from '../../src/plugin/json-errors.js';
import { MAX_PROPOSAL_JSON_BYTES } from '../../src/storage/trusted-write.js';

describe('mcpJsonErrorHandler', () => {
  it('returns JSON-RPC -32700 for malformed JSON on /mcp/rpc', async () => {
    const app = express();
    app.use(express.json());
    app.post('/mcp/rpc', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(mcpJsonErrorHandler());
    // Fallback HTML error handler (simulates Express default)
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res
          .status(400)
          .type('html')
          .send(`<html>${String(err)}</html>`);
      }
    );

    const res = await request(app)
      .post('/mcp/rpc')
      .set('Content-Type', 'application/json')
      .send('{not-json');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
    expect(res.text).not.toMatch(/<html/i);
    expect(res.text).not.toMatch(/node_modules/);
  });

  it('returns JSON invalid_json for malformed JSON on REST /mcp/api', async () => {
    const app = express();
    app.use(express.json());
    app.post('/mcp/api/v1/proposals', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.use(mcpJsonErrorHandler());

    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Content-Type', 'application/json')
      .send('{"type":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON body', code: 'invalid_json' });
  });

  it('returns 413 JSON when body parser reports entity too large on /mcp', async () => {
    const app = express();
    app.use(express.json({ limit: '100b' }));
    app.post('/mcp/api/v1/proposals', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.use(mcpJsonErrorHandler());

    const res = await request(app)
      .post('/mcp/api/v1/proposals')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(200) }));

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('storage_payload_too_large');
    expect(res.body.error).toContain(String(MAX_PROPOSAL_JSON_BYTES));
  });
});
