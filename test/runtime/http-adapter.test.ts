/**
 * Unit tests for HttpAdapter against a mock Admin API server.
 */

import type { Server } from 'node:http';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FlowRevisionConflictError } from '../../src/runtime/errors.js';
import { HttpAdapter } from '../../src/runtime/http-adapter.js';
import type { FlowNode } from '../../src/runtime/types.js';

interface MockState {
  rev: string;
  flows: FlowNode[];
}

function createMockAdminApi(state: MockState): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/flows', (req, res) => {
    if (req.get('Node-RED-API-Version') !== 'v2') {
      res.status(400).json({ code: 'invalid_api_version' });
      return;
    }
    res.json({ rev: state.rev, flows: state.flows });
  });

  app.get('/flow/:id', (req, res) => {
    const id = req.params.id;
    const tab = state.flows.find(n => n.id === id && (n.type === 'tab' || n.type === 'subflow'));
    if (!tab) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    const nodes = state.flows.filter(n => n.z === id);
    res.json({
      id: tab.id,
      type: tab.type,
      label: tab.label,
      nodes,
    });
  });

  app.post('/flows', (req, res) => {
    if (req.get('Node-RED-API-Version') !== 'v2') {
      res.status(400).json({ code: 'invalid_api_version' });
      return;
    }
    const body = req.body as { flows?: FlowNode[]; rev?: string };
    if (body.rev !== undefined && body.rev !== state.rev) {
      res.status(409).json({
        code: 'version_mismatch',
        current_rev: state.rev,
      });
      return;
    }
    state.flows = body.flows ?? state.flows;
    state.rev = `rev-${Date.now()}`;
    res.json({ rev: state.rev });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind mock admin API'));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

describe('HttpAdapter', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let state: MockState;

  beforeEach(async () => {
    state = {
      rev: 'rev-1',
      flows: [
        { id: 'tab-1', type: 'tab', label: 'Main' },
        { id: 'n1', type: 'inject', z: 'tab-1', name: 'kick' },
        { id: 'tab-2', type: 'tab', label: 'Other' },
      ],
    };
    const mock = await createMockAdminApi(state);
    server = mock.server;
    baseUrl = mock.baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(err => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  it('getFlows reads Admin API v2 { rev, flows }', async () => {
    const adapter = new HttpAdapter({ baseUrl });
    await expect(adapter.getFlows()).resolves.toEqual({
      rev: 'rev-1',
      flows: state.flows,
    });
    expect(adapter.kind).toBe('http');
  });

  it('getFlow returns nested tab plus live rev', async () => {
    const adapter = new HttpAdapter({ baseUrl });
    const result = await adapter.getFlow('tab-1');
    expect(result.rev).toBe('rev-1');
    expect(result.flow).toMatchObject({
      id: 'tab-1',
      label: 'Main',
      nodes: [expect.objectContaining({ id: 'n1' })],
    });
  });

  it('updateFlow defaults to deployment type nodes and returns new rev', async () => {
    const adapter = new HttpAdapter({ baseUrl });
    const result = await adapter.updateFlow({
      flowId: 'tab-1',
      expectedRev: 'rev-1',
      flow: {
        label: 'Main',
        nodes: [{ id: 'n2', type: 'debug', name: 'out' }],
      },
    });

    expect(result.flowId).toBe('tab-1');
    expect(result.rev).not.toBe('rev-1');
    expect(state.flows.find(n => n.id === 'n2')).toMatchObject({ z: 'tab-1', type: 'debug' });
    expect(state.flows.find(n => n.id === 'n1')).toBeUndefined();
    expect(state.flows.find(n => n.id === 'tab-2')).toBeDefined();
  });

  it('updateFlow throws FlowRevisionConflictError on stale expectedRev', async () => {
    const adapter = new HttpAdapter({ baseUrl });

    await expect(
      adapter.updateFlow({
        flowId: 'tab-1',
        expectedRev: 'stale',
        flow: { nodes: [{ id: 'n1', type: 'inject' }] },
      })
    ).rejects.toBeInstanceOf(FlowRevisionConflictError);

    await expect(
      adapter.updateFlow({
        flowId: 'tab-1',
        expectedRev: 'stale',
        flow: { nodes: [{ id: 'n1', type: 'inject' }] },
      })
    ).rejects.toMatchObject({
      code: 'version_mismatch',
      statusCode: 409,
      expectedRev: 'stale',
      currentRev: 'rev-1',
    });

    expect(state.rev).toBe('rev-1');
  });

  it('sends Bearer token when accessToken is configured', async () => {
    let sawAuth = false;
    const app = express();
    app.get('/flows', (req, res) => {
      sawAuth = req.get('authorization') === 'Bearer secret-token';
      res.json({ rev: 'r', flows: [] });
    });
    const tokenServer = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const address = tokenServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('no port');
    }

    try {
      const adapter = new HttpAdapter({
        baseUrl: `http://127.0.0.1:${address.port}`,
        accessToken: 'secret-token',
      });
      await adapter.getFlows();
      expect(sawAuth).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        tokenServer.close(err => (err ? reject(err) : resolve()))
      );
    }
  });
});
