import express, { type Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import {
  absolutizePath,
  bindPublicBaseUrl,
  buildAccessLinkUrl,
  isTrustProxyEnabled,
  isValidHostHeader,
  normalizePublicBaseUrl,
  requestPublicOrigin,
} from '../../src/plugin/access-path.js';

function mockReq(options: {
  trustProxy?: boolean | number;
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
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
      if (key === 'x-forwarded-proto') return options.forwardedProto;
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

describe('requestPublicOrigin scheme and publicBaseUrl', () => {
  afterEach(() => bindPublicBaseUrl(undefined));

  it('ignores X-Forwarded-Proto when trust proxy is off', () => {
    const req = mockReq({ host: 'nr.example', forwardedProto: 'https', protocol: 'http' });
    expect(requestPublicOrigin(req)).toBe('http://nr.example');
  });

  it('uses the first X-Forwarded-Proto value when trust proxy is on', () => {
    const req = mockReq({
      trustProxy: true,
      host: 'nr.example',
      forwardedProto: 'https, http',
      protocol: 'http',
    });
    expect(requestPublicOrigin(req)).toBe('https://nr.example');
  });

  it('honors X-Forwarded-Proto through a real Express sub-app with trust proxy', async () => {
    const parent = express();
    parent.set('trust proxy', true);
    const admin = express();
    admin.get('/u', (req, res) => {
      res.json({ url: buildAccessLinkUrl(req, '/', 'aia_tok') });
    });
    parent.use(admin);
    const res = await request(parent)
      .get('/u')
      .set('Host', 'nr.example')
      .set('X-Forwarded-Proto', 'https');
    expect(res.body.url).toBe('https://nr.example/mcp/a/aia_tok');
  });

  it('publicBaseUrl overrides Host and X-Forwarded-*', () => {
    bindPublicBaseUrl('https://public.example/base/');
    const req = mockReq({
      trustProxy: true,
      host: 'local:1880',
      forwardedHost: 'other.example',
      forwardedProto: 'http',
      protocol: 'http',
    });
    expect(requestPublicOrigin(req)).toBe('https://public.example/base');
    expect(buildAccessLinkUrl(req, '/', 'aia_tok')).toBe(
      'https://public.example/base/mcp/a/aia_tok'
    );
    expect(absolutizePath(mockReq({}), '/mcp')).toBe('https://public.example/base/mcp');
  });

  it('normalizePublicBaseUrl rejects invalid values', () => {
    expect(normalizePublicBaseUrl('')).toBeUndefined();
    expect(normalizePublicBaseUrl('not a url')).toBeUndefined();
    expect(normalizePublicBaseUrl('ftp://x.example')).toBeUndefined();
    expect(normalizePublicBaseUrl(42)).toBeUndefined();
    expect(normalizePublicBaseUrl('https://x.example/?q=1#f')).toBe('https://x.example');
  });
});

describe('requestPublicOrigin validates forwarded and Host values', () => {
  afterEach(() => bindPublicBaseUrl(undefined));
  const trusted = (forwardedProto: string | undefined, forwardedHost: string | undefined) =>
    mockReq({
      trustProxy: true,
      host: 'local:1880',
      protocol: 'http',
      ...(forwardedProto !== undefined ? { forwardedProto } : {}),
      ...(forwardedHost !== undefined ? { forwardedHost } : {}),
    });

  it.each([
    ['javascript', 'alert(1)', 'http://local:1880'],
    ['https', 'evil.com?x=1#y', 'https://local:1880'],
    ['https', 'a b', 'https://local:1880'],
    ['https', 'user@evil.com', 'https://local:1880'],
    ['https', 'evil.com/path', 'https://local:1880'],
    ['https', '"><script>', 'https://local:1880'],
    ['ftp', 'nr.example', 'http://nr.example'],
    ['javascript', undefined, 'http://local:1880'],
  ])('proto %j host %j → %s', (proto, host, expected) => {
    const req = trusted(proto, host);
    expect(requestPublicOrigin(req)).toBe(expected);
    expect(buildAccessLinkUrl(req, '/', 'aia_t')).toBe(`${expected}/mcp/a/aia_t`);
  });

  it.each([
    [' HTTPS ', 'nr.example:8443', 'https://nr.example:8443'],
    ['https, http', 'nr.example, evil.example', 'https://nr.example'],
    ['https', '[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'],
    ['https', '[::1]', 'https://[::1]'],
    ['https', '192.168.1.10:1880', 'https://192.168.1.10:1880'],
  ])('valid proto %j host %j → %s', (proto, host, expected) => {
    expect(requestPublicOrigin(trusted(proto, host))).toBe(expected);
  });

  it('falls back to a relative path when Host is invalid too', () => {
    const req = mockReq({ trustProxy: true, host: 'bad host', forwardedHost: 'x/y' });
    expect(requestPublicOrigin(req)).toBeUndefined();
    expect(absolutizePath(req, '/mcp')).toBe('/mcp');
  });

  it('validates Host when trust proxy is off', () => {
    expect(
      requestPublicOrigin(mockReq({ host: 'evil.com?x=1', protocol: 'http' }))
    ).toBeUndefined();
    expect(requestPublicOrigin(mockReq({ host: 'nr.example:1880', protocol: 'http' }))).toBe(
      'http://nr.example:1880'
    );
  });

  it('isValidHostHeader rules', () => {
    for (const ok of [
      'a',
      'nr.example',
      'a-b.c',
      'nr.example:1',
      'nr.example:65535',
      '10.0.0.1',
      '[::1]:80',
    ]) {
      expect(isValidHostHeader(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'nr.example:0',
      'nr.example:65536',
      '-a.example',
      'a_b.example',
      'a..b',
      '[zz::1]',
      'u:p@h',
      'h:80:90',
      'h#x',
      `${'a'.repeat(64)}.example`,
      `${'a.'.repeat(127)}aa`,
    ]) {
      expect(isValidHostHeader(bad)).toBe(false);
    }
  });
});
