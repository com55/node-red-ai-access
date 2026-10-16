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
  buildReplaceFlowTitle,
  formatProposalSubmittedAt,
  formatUtcOffset,
  presentProposal,
  resolveProposalTitle,
  sanitizeProposalTitle,
  shouldRefreshDisplayTitle,
  titleFromDiffSummary,
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
  it('describes a rename (includes flow name)', () => {
    expect(
      autoGenerateProposalTitle(
        {
          label: 'Test Flow',
          nodes: [{ id: 'n1', type: 'debug', name: 'out', complete: 'payload' }],
        },
        {
          label: 'Test Flow',
          nodes: [{ id: 'n1', type: 'debug', name: 'out (patched)', complete: 'payload' }],
        }
      )
    ).toBe('Rename debug node "out" → "out (patched)" in Test Flow');
  });

  it('describes a single added inject (includes flow name)', () => {
    expect(
      autoGenerateProposalTitle(
        { label: 'Test Flow', nodes: [] },
        { label: 'Test Flow', nodes: [{ id: 'n2', type: 'inject', name: 'tick2' }] }
      )
    ).toBe('Add inject node "tick2" in Test Flow');
  });

  it('describes a single edited template (includes flow name)', () => {
    expect(
      autoGenerateProposalTitle(
        {
          label: 'Test Flow',
          nodes: [{ id: 't1', type: 'template', name: 'html20k', template: 'a' }],
        },
        {
          label: 'Test Flow',
          nodes: [{ id: 't1', type: 'template', name: 'html20k', template: 'b' }],
        }
      )
    ).toBe('Edit template "html20k" in Test Flow');
  });

  it('summarizes many changes with the flow label', () => {
    expect(
      autoGenerateProposalTitle(
        {
          label: 'Test Flow',
          nodes: [
            { id: 'a', type: 'inject', name: 'A', topic: '1' },
            { id: 'b', type: 'inject', name: 'B', topic: '1' },
            { id: 'c', type: 'inject', name: 'C', topic: '1' },
          ],
        },
        {
          label: 'Test Flow',
          nodes: [
            { id: 'a', type: 'inject', name: 'A', topic: '2' },
            { id: 'b', type: 'inject', name: 'B', topic: '2' },
            { id: 'c', type: 'inject', name: 'C', topic: '2' },
          ],
        }
      )
    ).toBe('3 changes in Test Flow');
  });

  it('falls back to Update flow when nothing changed and no label', () => {
    expect(autoGenerateProposalTitle({ nodes: [] }, { nodes: [] })).toBe('Update flow');
  });

  it('leads with deletes when nodes are removed (never bury under Add …)', () => {
    expect(
      autoGenerateProposalTitle(
        {
          label: 'Test Flow',
          nodes: [
            { id: 'a', type: 'inject', name: 'A' },
            { id: 'b', type: 'inject', name: 'B' },
            { id: 'c', type: 'debug', name: 'C' },
            { id: 'd', type: 'function', name: 'D' },
          ],
        },
        {
          label: 'Test Flow',
          nodes: [{ id: 'n', type: 'comment', name: 'note' }],
        }
      )
    ).toBe('Replace Test Flow: deletes 4 nodes, adds 1 comment');
  });
});

describe('buildReplaceFlowTitle / display-title refresh', () => {
  it('formats delete-leading replace titles', () => {
    expect(
      buildReplaceFlowTitle({
        flowLabel: 'Test Flow',
        removed: 4,
        added: [{ id: 'n', type: 'comment' }],
      })
    ).toBe('Replace Test Flow: deletes 4 nodes, adds 1 comment');
  });

  it('refreshes legacy Update titles and non-Replace delete titles', () => {
    expect(shouldRefreshDisplayTitle('Update flow', 0)).toBe(true);
    expect(shouldRefreshDisplayTitle('Update Test Flow', 0)).toBe(true);
    expect(shouldRefreshDisplayTitle('Add comment node', 4)).toBe(true);
    expect(shouldRefreshDisplayTitle('Rename inject', 0)).toBe(false);
    expect(shouldRefreshDisplayTitle('Replace Test Flow: deletes 4 nodes', 4)).toBe(false);
  });

  it('builds titles from a diff summary (client/server render path)', () => {
    expect(
      titleFromDiffSummary(
        { added: 1, removed: 4, modified: 0 },
        { flowLabel: 'Test Flow', storedTitle: 'Add comment node', firstAddedType: 'comment' }
      )
    ).toBe('Replace Test Flow: deletes 4 nodes, adds 1 comment');
    expect(
      titleFromDiffSummary(
        { added: 0, removed: 0, modified: 1 },
        { flowLabel: 'Test Flow', storedTitle: 'Update flow' }
      )
    ).toBe('Edit node in Test Flow');
  });

  it('resolveProposalTitle refreshes legacy Update / buried-delete titles', () => {
    const legacy = baseProposal({
      title: 'Add comment node',
      baseFlow: {
        id: 'tab1',
        type: 'tab',
        label: 'Test Flow',
        nodes: [
          { id: 'a', type: 'inject' },
          { id: 'b', type: 'inject' },
          { id: 'c', type: 'inject' },
          { id: 'd', type: 'inject' },
        ],
      },
      payload: {
        flowId: 'tab1',
        flow: {
          id: 'tab1',
          type: 'tab',
          label: 'Test Flow',
          nodes: [{ id: 'n', type: 'comment', name: 'note' }],
        },
      },
    });
    expect(resolveProposalTitle(legacy)).toBe('Replace Test Flow: deletes 4 nodes, adds 1 comment');

    const updateLegacy = baseProposal({
      title: 'Update flow',
      baseFlow: {
        id: 'tab1',
        type: 'tab',
        label: 'Test Flow',
        nodes: [{ id: 'n1', type: 'debug', name: 'out' }],
      },
      payload: {
        flowId: 'tab1',
        flow: {
          id: 'tab1',
          type: 'tab',
          label: 'Test Flow',
          nodes: [{ id: 'n1', type: 'debug', name: 'out (patched)' }],
        },
      },
    });
    expect(resolveProposalTitle(updateLegacy)).toBe(
      'Rename debug node "out" → "out (patched)" in Test Flow'
    );
  });

  it('resolves flow name for oldest cards via liveFlowLabels', () => {
    const orphan = baseProposal({
      title: 'Add comment node',
      baseFlow: { id: 'tab1', type: 'tab', nodes: [] },
      payload: {
        flowId: 'tab1',
        flow: {
          id: 'tab1',
          type: 'tab',
          nodes: [{ id: 'n', type: 'comment', name: 'note' }],
        },
      },
    });
    const labels = new Map([['tab1', 'Test Flow']]);
    expect(resolveProposalTitle(orphan, { liveFlowLabels: labels })).toBe(
      'Add comment node in Test Flow'
    );
    const presented = presentProposal(orphan, { liveFlowLabels: labels });
    expect(presented.flowLabel).toBe('Test Flow');
    expect(presented.title).toBe('Add comment node in Test Flow');
  });
});

describe('presentProposal', () => {
  it('uses stored AI title and builds displayName + reviewPath/Url', () => {
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

  it('auto-generates a change-based title for legacy proposals without title', () => {
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
    expect(presented.title).toBe('Edit inject "tick" in Main');
    expect(presented.flowLabel).toBe('Main');
    expect(presented.displayName.startsWith('Edit inject "tick" in Main · ')).toBe(true);
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
