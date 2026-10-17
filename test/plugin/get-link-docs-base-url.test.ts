import { describe, expect, it } from 'vitest';

import { DEFAULT_RPC_URL_PLACEHOLDER, renderGetLinkDocs } from '../../src/plugin/get-link/docs.js';

const link = {
  id: 'l1',
  kind: 'get_link',
  token: 'aia_x',
  createdAt: '2026-10-17T00:00:00.000Z',
  expiresAt: '2026-10-17T04:00:00.000Z',
} as unknown as Parameters<typeof renderGetLinkDocs>[0]['link'];

const base = {
  link,
  openapiPath: '/mcp/api/v1/openapi.yaml',
  restApiBase: '/mcp/api/v1',
  mcpRpcPath: '/mcp/rpc',
};

describe('GET-link guide MCP URL in client snippets', () => {
  it('keeps the placeholder when publicBaseUrl is not configured', () => {
    const md = renderGetLinkDocs(base);
    expect(md).toContain(DEFAULT_RPC_URL_PLACEHOLDER);
  });

  it('uses publicBaseUrl + MCP path when configured', () => {
    const md = renderGetLinkDocs({
      ...base,
      publicBaseUrl: 'https://nr.example',
      mcpRpcPath: '/admin/mcp/rpc',
    });
    expect(md).not.toContain('YOUR-NODE-RED');
    expect(md).toContain('"url": "https://nr.example/admin/mcp/rpc"');
    expect(md).toContain('curl -sS -X POST "https://nr.example/admin/mcp/rpc"');
  });
});
