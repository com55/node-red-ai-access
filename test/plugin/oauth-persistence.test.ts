import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { LocalOAuthProvider, OAuthStore } from '../../src/plugin/oauth.js';
import { resolveAiAccessPaths } from '../../src/storage/paths.js';

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
    writes.count = 0;
    for (let i = 0; i < 5; i++) store.getClient(client.client_id);
    expect(writes.count).toBe(0);
    for (let i = 0; i < 5; i++) await provider.verifyAccessToken(tokens.access_token);
    expect(writes.count).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes.count).toBe(1);
  });
});
