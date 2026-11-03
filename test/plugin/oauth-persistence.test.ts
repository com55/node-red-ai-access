import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import registerPlugin from '../../src/plugin/index.js';
import { LocalOAuthProvider, OAuthStore } from '../../src/plugin/oauth.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import { resolveAiAccessPaths } from '../../src/storage/paths.js';

const writes = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/storage/trusted-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/storage/trusted-write.js')>();
  return {
    ...actual,
    writeTrustedAtomic: (...args: Parameters<typeof actual.writeTrustedAtomic>) => {
      writes.count++;
      return actual.writeTrustedAtomic(...args);
    },
  };
});

describe('OAuth store persistence', () => {
  let userDir: string;
  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-oauth-persist-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('flushes on removal and never lets the old store overwrite a replacement', () => {
    const events = new EventEmitter();
    const server = new EventEmitter();
    let definition: Record<string, unknown>;
    const RED = {
      settings: { userDir },
      httpAdmin: express(),
      events,
      server,
      auth: { needsPermission: () => (_req, _res, next) => next() },
      plugins: {
        registerPlugin: (_id, def) => {
          definition = def;
        },
      },
    } as NodeRedPluginAPI;
    const prune = vi.spyOn(OAuthStore.prototype, 'prune');
    const exitCount = process.listenerCount('exit');
    const signalCount = process.listenerCount('SIGTERM');
    registerPlugin(RED);
    const add = () => (definition.onadd as () => void)();
    const remove = () => (definition.onremove as () => void)();
    try {
      add();
      const old = prune.mock.contexts.at(-1)!;
      const client = old.registerClient({ redirect_uris: ['https://example.com/cb'] });
      old.data.clients[0]!.lastUsedAt = Date.now();
      old.touch();
      remove();
      const path = join(resolveAiAccessPaths(userDir).root, 'oauth.json');
      expect(JSON.parse(readFileSync(path, 'utf8')).clients[0].lastUsedAt).toBe(Date.now());
      add();
      const replacement = prune.mock.contexts.at(-1)!;
      const fresh = replacement.registerClient({ redirect_uris: ['https://new.example/cb'] });
      const saved = readFileSync(path, 'utf8');
      old.revokeClient(client.client_id);
      old.registerClient({ redirect_uris: ['https://stale.example/cb'] });
      old.persist();
      old.touch();
      old.flush();
      old.dispose();
      vi.advanceTimersByTime(5 * 60_000);
      expect(readFileSync(path, 'utf8')).toBe(saved);
      expect(JSON.parse(saved).clients.map(c => c.client_id)).toContain(fresh.client_id);
      replacement.data.clients[0]!.lastUsedAt = Date.now();
      replacement.touch();
      server.emit('close');
      expect(JSON.parse(readFileSync(path, 'utf8')).clients[0].lastUsedAt).toBe(Date.now());
      expect(process.listenerCount('exit')).toBe(exitCount);
      expect(process.listenerCount('SIGTERM')).toBe(signalCount);
      expect(events.listenerCount('close')).toBe(0);
      expect(server.listenerCount('close')).toBe(0);
    } finally {
      remove();
      prune.mockRestore();
    }
  });

  it('persists missing issue timestamps so legacy clients eventually expire', () => {
    const paths = resolveAiAccessPaths(userDir);
    const initial = new OAuthStore(paths, () => 20);
    for (let i = 0; i < 25; i++) {
      initial.registerClient({ redirect_uris: ['https://example.com/cb'] });
    }
    initial.data.clients.forEach(c => {
      delete c.client_id_issued_at;
    });
    initial.data.clients[0]!.approved = true;
    const path = join(paths.root, 'oauth.json');
    writeFileSync(path, JSON.stringify(initial.data));
    initial.dispose();
    const restored = new OAuthStore(paths, () => 20);
    const issuedAt = Math.floor(Date.now() / 1000);
    expect(
      JSON.parse(readFileSync(path, 'utf8')).clients.every(c => c.client_id_issued_at === issuedAt)
    ).toBe(true);
    vi.advanceTimersByTime(3_600_000);
    const reloaded = new OAuthStore(paths, () => 20);
    expect(reloaded.data.clients).toHaveLength(1);
    expect(() =>
      reloaded.registerClient({ redirect_uris: ['https://example.com/cb'] })
    ).not.toThrow();
    vi.advanceTimersByTime(30 * 86400_000);
    reloaded.prune();
    expect(reloaded.data.clients).toHaveLength(0);
    restored.dispose();
    reloaded.dispose();
  });

  it('skips disk writes when pruning removes nothing and debounces lastUsedAt', async () => {
    const store = new OAuthStore(resolveAiAccessPaths(userDir), () => 20);
    const provider = new LocalOAuthProvider(
      store,
      () => 'https://node.example/mcp',
      () => 3600,
      () => 86400
    );
    const client = store.registerClient({
      client_name: 'x',
      redirect_uris: ['http://127.0.0.1:1/cb'],
      token_endpoint_auth_method: 'none',
    });
    expect(store.data.clients[0]?.lastUsedAt).toBeUndefined();
    expect(client.client_id_issued_at).toBe(Math.floor(Date.now() / 1000));
    store.approve(client.client_id);
    const code = provider.createCode(
      client,
      { redirectUri: 'http://127.0.0.1:1/cb', codeChallenge: 'c', scopes: ['read'] },
      'owner'
    );
    await provider.challengeForAuthorizationCode(client, code);
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      'http://127.0.0.1:1/cb'
    );
    expect(store.data.clients[0]?.lastUsedAt).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(1_000);
    await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(store.data.clients[0]?.lastUsedAt).toBe(Date.now());
    writes.count = 0;
    for (let i = 0; i < 5; i++) store.getClient(client.client_id);
    expect(writes.count).toBe(0);
    for (let i = 0; i < 5; i++) await provider.verifyAccessToken(tokens.access_token);
    expect(writes.count).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await provider.verifyAccessToken(tokens.access_token);
    expect(store.data.clients[0]?.lastUsedAt).toBe(Date.now());
    expect(writes.count).toBe(0);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(writes.count).toBe(1);
    const saved = JSON.parse(
      readFileSync(join(resolveAiAccessPaths(userDir).root, 'oauth.json'), 'utf8')
    );
    expect(saved.clients[0].lastUsedAt).toBe(store.data.clients[0]?.lastUsedAt);
    delete store.data.clients[0]!.client_id_issued_at;
    delete store.data.clients[0]!.lastUsedAt;
    store.persist();
    const restored = new OAuthStore(resolveAiAccessPaths(userDir), () => 20);
    expect(restored.getClient(client.client_id)).toBeDefined();
  });
});
