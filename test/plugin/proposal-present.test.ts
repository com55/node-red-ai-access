/**
 * Tests for proposal title / displayName / reviewUrl helpers.
 */

import express, { type Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  autoGenerateProposalTitle,
  buildProposalDisplayName,
  buildProposalReviewPath,
  buildProposalReviewUrl,
  formatProposalSubmittedAt,
  formatUtcOffset,
  presentProposal,
  sanitizeProposalTitle,
} from '../../src/plugin/proposal-present.js';
import type { Proposal } from '../../src/storage/proposals.js';

function baseProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-abcdef012345',
    type: 'replace_flow',
    status: 'pending',
    expectedRev: 'rev-1',
    payload: {
      flowId: 'tab1',
      flow: { id: 'tab1', type: 'tab', nodes: [] },
    },
    baseFlow: { id: 'tab1', type: 'tab', nodes: [] },
    createdBy: { kind: 'access-link', linkId: 'link-1' },
    createdAt: '2026-10-16T01:35:00.000Z',
    updatedAt: '2026-10-16T01:35:00.000Z',
    ...overrides,
  };
}

describe('sanitizeProposalTitle', () => {
  it('trims, collapses whitespace, and caps at 80 chars', () => {
    expect(sanitizeProposalTitle('  Hello   world  ')).toBe('Hello world');
    expect(sanitizeProposalTitle('x'.repeat(100))).toHaveLength(80);
    expect(sanitizeProposalTitle('')).toBeUndefined();
    expect(sanitizeProposalTitle('   ')).toBeUndefined();
    expect(sanitizeProposalTitle(null)).toBeUndefined();
  });

  it('strips control characters', () => {
    expect(sanitizeProposalTitle('Edit\u0000 fn1\n(function)')).toBe('Edit fn1 (function)');
  });
});

describe('formatUtcOffset / formatProposalSubmittedAt', () => {
  it('formats offsets as ±HH:MM', () => {
    expect(formatUtcOffset(0)).toBe('+00:00');
    expect(formatUtcOffset(120)).toBe('+02:00');
    expect(formatUtcOffset(-300)).toBe('-05:00');
    expect(formatUtcOffset(-330)).toBe('-05:30');
  });

  it('formats server local time with explicit offset', () => {
    const fixed = new Date(2026, 9, 16, 1, 35, 0); // local 16 Oct 01:35
    const formatted = formatProposalSubmittedAt(fixed.toISOString(), fixed);
    expect(formatted).toMatch(/^16 Oct 01:35 [+-]\d{2}:\d{2}$/);
    const expectedOffset = formatUtcOffset(-fixed.getTimezoneOffset());
    expect(formatted).toBe(`16 Oct 01:35 ${expectedOffset}`);
  });
});

describe('autoGenerateProposalTitle', () => {
  it('uses a plain Update {flow label} title', () => {
    expect(
      autoGenerateProposalTitle(
        {
          id: 'tab1',
          label: 'Test Flow',
          nodes: [{ id: 'n1', type: 'function', name: 'fn1', func: 'a' }],
        },
        {
          id: 'tab1',
          label: 'Test Flow',
          nodes: [{ id: 'n1', type: 'function', name: 'fn1', func: 'b' }],
        }
      )
    ).toBe('Update Test Flow');
  });

  it('falls back to Update flow when no label', () => {
    expect(
      autoGenerateProposalTitle(
        { nodes: [] },
        { nodes: [{ id: 'n2', type: 'template', name: 'demo-html' }] }
      )
    ).toBe('Update flow');
  });

  it('prefers the after-flow label over the base label', () => {
    expect(
      autoGenerateProposalTitle(
        { label: 'Old Name', nodes: [{ id: 'a', type: 'inject', name: 'A' }] },
        { label: 'New Name', nodes: [{ id: 'a', type: 'inject', name: 'A', topic: 'x' }] }
      )
    ).toBe('Update New Name');
  });
});

describe('presentProposal', () => {
  it('uses stored title and builds displayName + reviewPath/Url', () => {
    const presented = presentProposal(baseProposal({ title: 'Rename inject' }));
    expect(presented.title).toBe('Rename inject');
    expect(presented.displayName).toBe(
      buildProposalDisplayName('Rename inject', presented.createdAt)
    );
    expect(presented.displayName).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(presented.reviewPath).toBe('/mcp#proposal=prop-abcdef012345');
    expect(presented.reviewUrl).toBe('/mcp#proposal=prop-abcdef012345');
    expect(buildProposalReviewPath('prop-x')).toBe('/mcp#proposal=prop-x');
    expect(buildProposalReviewPath('prop-x', '/editor')).toBe('/editor/mcp#proposal=prop-x');
  });

  it('absolutizes reviewUrl from request Host (no trust proxy → ignore X-Forwarded-*)', () => {
    const app = express();
    const req = {
      app,
      protocol: 'http',
      get(name: string) {
        const key = name.toLowerCase();
        if (key === 'host') return 'nodered.local:1880';
        if (key === 'x-forwarded-host') return 'public.example';
        if (key === 'x-forwarded-proto') return 'https';
        return undefined;
      },
    } as unknown as Request;

    const presented = presentProposal(baseProposal({ title: 'T' }), {
      req,
      httpAdminRoot: '/',
    });
    expect(presented.reviewPath).toBe('/mcp#proposal=prop-abcdef012345');
    expect(presented.reviewUrl).toBe('http://nodered.local:1880/mcp#proposal=prop-abcdef012345');
    expect(buildProposalReviewUrl('prop-abcdef012345', { req })).toBe(presented.reviewUrl);
  });

  it('uses X-Forwarded-* when trust proxy is enabled', () => {
    const app = express();
    app.set('trust proxy', 1);
    const req = {
      app,
      protocol: 'https',
      get(name: string) {
        const key = name.toLowerCase();
        if (key === 'host') return '127.0.0.1:1880';
        if (key === 'x-forwarded-host') return 'flows.example.com';
        return undefined;
      },
    } as unknown as Request;

    const presented = presentProposal(baseProposal({ title: 'T' }), { req });
    expect(presented.reviewUrl).toBe('https://flows.example.com/mcp#proposal=prop-abcdef012345');
  });

  it('auto-generates a plain title for legacy proposals without title', () => {
    const presented = presentProposal(
      baseProposal({
        title: undefined,
        baseFlow: {
          id: 'tab1',
          label: 'Main',
          nodes: [{ id: 'n1', type: 'inject', name: 'tick' }],
        },
        payload: {
          flowId: 'tab1',
          flow: {
            id: 'tab1',
            label: 'Main',
            nodes: [{ id: 'n1', type: 'inject', name: 'tick', topic: 'x' }],
          },
        },
      })
    );
    expect(presented.title).toBe('Update Main');
    expect(presented.flowLabel).toBe('Main');
    expect(presented.displayName.startsWith('Update Main · ')).toBe(true);
    expect(presented.reviewPath).toBeTruthy();
  });

  it('resolves flowLabel and never exposes a raw tab id as the label', () => {
    const presented = presentProposal(
      baseProposal({
        payload: {
          flowId: 'tab1',
          flow: { id: 'tab1', type: 'tab', label: 'Test Flow', nodes: [] },
        },
      })
    );
    expect(presented.flowLabel).toBe('Test Flow');
    expect(presented.flowLabel).not.toBe('tab1');
  });
});
