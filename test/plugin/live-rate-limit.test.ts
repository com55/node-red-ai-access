import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLiveAiAccessDualRateLimiters } from '../../src/plugin/rate-limit.js';
import type { AiAccessSettings } from '../../src/plugin/types.js';

function makeApp(getSettings: () => AiAccessSettings) {
  const { ip, token } = createLiveAiAccessDualRateLimiters(getSettings);
  const app = express();
  app.get('/x', ip, token, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createLiveAiAccessDualRateLimiters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accumulates counts across requests and returns 429, without request-time limiter creation', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errors.push(a));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => errors.push(a));
    const app = makeApp(() => ({ rateLimitWindowMs: 60_000, rateLimitMaxPerIp: 3 }));
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/x')).status).toBe(200);
    }
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(JSON.stringify(errors)).not.toContain('ERR_ERL_CREATED_IN_REQUEST_HANDLER');
  });

  it('applies settings changes without restart', async () => {
    let max = 1;
    const app = makeApp(() => ({ rateLimitWindowMs: 60_000, rateLimitMaxPerIp: max }));
    expect((await request(app).get('/x')).status).toBe(200);
    expect((await request(app).get('/x')).status).toBe(429);
    max = 5;
    expect((await request(app).get('/x')).status).toBe(200);
  });
});
