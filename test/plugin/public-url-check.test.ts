import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyPublicUrlAddress,
  preparePublicUrlCheck,
  requestPublicUrlCheck,
} from '../../src/plugin/public-url-check.js';

describe('classifyPublicUrlAddress', () => {
  it.each(['3fff::1', '3fff:0fff:ffff::1', '3fff:0:0:0:0:0:0:1'])(
    'blocks the RFC 9637 documentation range 3fff::/20: %s',
    address => {
      expect(classifyPublicUrlAddress(address)).toBe('blocked');
    }
  );

  it('still treats addresses just outside 3fff::/20 as public', () => {
    expect(classifyPublicUrlAddress('3fff:1000::1')).toBe('public');
  });
});

describe('localhost resolving to ::1 first', () => {
  afterEach(() => vi.restoreAllMocks());

  it('orders vetted loopback addresses IPv4 first and keeps all of them', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (err: null, results: dns.LookupAddress[]) => void
    ) => {
      callback(null, [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ]);
    }) as unknown as typeof dns.lookup);
    const target = await preparePublicUrlCheck(
      'http://LOCALHOST:1880',
      1880,
      new AbortController().signal
    );
    expect(target).toMatchObject({ address: '127.0.0.1', family: 4 });
    expect(target.addresses).toEqual([
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 },
    ]);
  });

  it('falls through to the next pinned address when one refuses the connection', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const lookups = vi.spyOn(dns, 'lookup');
    try {
      const status = await requestPublicUrlCheck(
        {
          origin: `http://localhost:${port}`,
          address: '::1',
          family: 6,
          // IPv6 first on purpose: nothing listens on [::1]:port.
          addresses: [
            { address: '::1', family: 6 },
            { address: '127.0.0.1', family: 4 },
          ],
        },
        '/mcp/api/v1',
        new AbortController().signal
      );
      expect(status).toBe(204);
      expect(lookups).not.toHaveBeenCalled();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
