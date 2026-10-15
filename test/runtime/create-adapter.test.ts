/**
 * Factory tests: prefer RED.runtime, fall back to HTTP Admin API.
 */

import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createFlowAdapter } from '../../src/runtime/create-adapter.js';
import { AdapterUnavailableError } from '../../src/runtime/errors.js';
import type { FlowsSnapshot, RedRuntimeHost } from '../../src/runtime/types.js';

describe('createFlowAdapter', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close(err => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  it('returns RedAdapter when runtime methods are present', () => {
    const RED: RedRuntimeHost = {
      runtime: {
        flows: {
          getFlows: () => Promise.resolve({ rev: '1', flows: [] }),
          getFlow: () => Promise.resolve({ id: 't', type: 'tab', nodes: [] }),
          setFlows: () => Promise.resolve({ rev: '2' }),
        },
      },
    };

    const adapter = createFlowAdapter({
      RED,
      http: { baseUrl: 'http://127.0.0.1:9' },
    });
    expect(adapter.kind).toBe('red');
  });

  it('falls back to HttpAdapter when runtime methods are missing', async () => {
    const app = express();
    app.get('/flows', (_req, res) => {
      res.json({ rev: 'http-rev', flows: [{ id: 'tab-1', type: 'tab' }] });
    });
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('no port');
    }

    const incomplete: RedRuntimeHost = {
      runtime: {
        flows: {
          getFlows: (): Promise<FlowsSnapshot> => Promise.resolve({ rev: '1', flows: [] }),
          // getFlow / setFlows missing → force HTTP fallback
        },
      },
    };

    const adapter = createFlowAdapter({
      RED: incomplete,
      http: { baseUrl: `http://127.0.0.1:${address.port}` },
    });
    expect(adapter.kind).toBe('http');
    await expect(adapter.getFlows()).resolves.toMatchObject({ rev: 'http-rev' });
  });

  it('throws AdapterUnavailableError when neither path works', () => {
    expect(() => createFlowAdapter({ RED: {} })).toThrow(AdapterUnavailableError);
    expect(() => createFlowAdapter({})).toThrow(/No usable Node-RED flow adapter/);
  });
});
