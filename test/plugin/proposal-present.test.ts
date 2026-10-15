/**
 * Tests for proposal title / displayName / reviewUrl helpers.
 */

import { describe, expect, it } from 'vitest';

import {
  autoGenerateProposalTitle,
  buildProposalDisplayName,
  buildProposalReviewUrl,
  formatProposalSubmittedAt,
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

describe('formatProposalSubmittedAt', () => {
  it('formats local time as D Mon HH:mm', () => {
    const fixed = new Date(2026, 9, 16, 1, 35, 0); // local 16 Oct 01:35
    expect(formatProposalSubmittedAt(fixed.toISOString(), fixed)).toBe('16 Oct 01:35');
  });
});

describe('autoGenerateProposalTitle', () => {
  it('describes a single edited node', () => {
    expect(
      autoGenerateProposalTitle(
        { nodes: [{ id: 'n1', type: 'function', name: 'fn1', func: 'a' }] },
        { nodes: [{ id: 'n1', type: 'function', name: 'fn1', func: 'b' }] }
      )
    ).toBe('Edit fn1 (function)');
  });

  it('describes a single added template', () => {
    expect(
      autoGenerateProposalTitle(
        { nodes: [] },
        { nodes: [{ id: 'n2', type: 'template', name: 'demo-html' }] }
      )
    ).toBe('Add template "demo-html"');
  });

  it('describes multiple edits', () => {
    expect(
      autoGenerateProposalTitle(
        {
          nodes: [
            { id: 'a', type: 'inject', name: 'A', topic: '1' },
            { id: 'b', type: 'inject', name: 'B', topic: '1' },
            { id: 'c', type: 'inject', name: 'C', topic: '1' },
          ],
        },
        {
          nodes: [
            { id: 'a', type: 'inject', name: 'A', topic: '2' },
            { id: 'b', type: 'inject', name: 'B', topic: '2' },
            { id: 'c', type: 'inject', name: 'C', topic: '2' },
          ],
        }
      )
    ).toBe('Edit 3 nodes');
  });
});

describe('presentProposal', () => {
  it('uses stored title and builds displayName + reviewUrl', () => {
    const presented = presentProposal(baseProposal({ title: 'Rename inject' }));
    expect(presented.title).toBe('Rename inject');
    expect(presented.displayName).toBe(
      buildProposalDisplayName('Rename inject', presented.createdAt)
    );
    expect(presented.reviewUrl).toBe('/mcp#proposal=prop-abcdef012345');
    expect(buildProposalReviewUrl('prop-x')).toBe('/mcp#proposal=prop-x');
  });

  it('auto-generates title for legacy proposals without title', () => {
    const presented = presentProposal(
      baseProposal({
        title: undefined,
        baseFlow: { nodes: [{ id: 'n1', type: 'inject', name: 'tick' }] },
        payload: {
          flowId: 'tab1',
          flow: { nodes: [{ id: 'n1', type: 'inject', name: 'tick', topic: 'x' }] },
        },
      })
    );
    expect(presented.title).toBe('Edit tick (inject)');
    expect(presented.displayName.startsWith('Edit tick (inject) · ')).toBe(true);
  });
});
