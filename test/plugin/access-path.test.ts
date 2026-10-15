import express, { type Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  absolutizePath,
  buildAccessLinkUrl,
  isTrustProxyEnabled,
  requestPublicOrigin,
} from '../../src/plugin/access-path.js';

function mockReq(options: {
  trustProxy?: boolean | number;
  host?: string;
  forwardedHost?: string;
  protocol?: string;
}): Request {
  const app = express();
  if (options.trustProxy !== undefined) {
    app.set('trust proxy', options.trustProxy);
  }
  return {
    app,
    protocol: options.protocol ?? 'http',
    get(name: string) {
      const key = name.toLowerCase();
      if (key === 'host') return options.host;
      if (key === 'x-forwarded-host') return options.forwardedHost;
      return undefined;
    },
  } as unknown as Request;
}

describe('requestPublicOrigin / trust proxy', () => {
  it('reports trust proxy from the Express app', () => {
    expect(isTrustProxyEnabled(mockReq({}))).toBe(false);
    expect(isTrustProxyEnabled(mockReq({ trustProxy: 1 }))).toBe(true);
  });

  it('ignores X-Forwarded-Host when trust proxy is off', () => {
    const req = mockReq({
      host: 'local:1880',
      forwardedHost: 'public.example',
      protocol: 'http',
    });
    expect(requestPublicOrigin(req)).toBe('http://local:1880');
    expect(absolutizePath(req, '/mcp')).toBe('http://local:1880/mcp');
  });

  it('uses X-Forwarded-Host when trust proxy is on', () => {
    const req = mockReq({
      trustProxy: 1,
      host: '127.0.0.1:1880',
      forwardedHost: 'public.example',
      protocol: 'https',
    });
    expect(requestPublicOrigin(req)).toBe('https://public.example');
  });

  it('falls back to relative path when Host is missing', () => {
    const req = mockReq({});
    expect(requestPublicOrigin(req)).toBeUndefined();
    expect(absolutizePath(req, '/mcp/a/aia_x')).toBe('/mcp/a/aia_x');
  });

  it('buildAccessLinkUrl respects trust proxy', () => {
    const noTrust = mockReq({
      host: 'local:1880',
      forwardedHost: 'evil.example',
      protocol: 'http',
    });
    expect(buildAccessLinkUrl(noTrust, '/', 'aia_tok')).toBe('http://local:1880/mcp/a/aia_tok');

    const trusted = mockReq({
      trustProxy: true,
      host: '127.0.0.1:1880',
      forwardedHost: 'nr.example',
      protocol: 'https',
    });
    expect(buildAccessLinkUrl(trusted, '/', 'aia_tok')).toBe('https://nr.example/mcp/a/aia_tok');
  });
});
