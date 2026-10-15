import { describe, expect, it } from 'vitest';

import {
  hashForTab,
  initialTabFromHash,
  readProposalHashId,
  tabFromHash,
} from '../../src/plugin/page-hash.js';

describe('hashForTab', () => {
  it('maps logs to audit and passes through known tabs', () => {
    expect(hashForTab('status')).toBe('status');
    expect(hashForTab('links')).toBe('links');
    expect(hashForTab('proposals')).toBe('proposals');
    expect(hashForTab('logs')).toBe('audit');
    expect(hashForTab('unknown')).toBe('status');
  });
});

describe('tabFromHash', () => {
  it('restores tabs from fragments including #audit', () => {
    expect(tabFromHash('#status')).toBe('status');
    expect(tabFromHash('#links')).toBe('links');
    expect(tabFromHash('#proposals')).toBe('proposals');
    expect(tabFromHash('#audit')).toBe('logs');
    expect(tabFromHash('#logs')).toBe('logs');
    expect(tabFromHash('audit')).toBe('logs');
  });

  it('ignores empty, unknown, and proposal deep links', () => {
    expect(tabFromHash('')).toBe('');
    expect(tabFromHash('#')).toBe('');
    expect(tabFromHash('#other')).toBe('');
    expect(tabFromHash('#proposal=abc')).toBe('');
  });
});

describe('readProposalHashId', () => {
  it('decodes #proposal=<id> only', () => {
    expect(readProposalHashId('#proposal=prop-1')).toBe('prop-1');
    expect(readProposalHashId('#proposal=a%2Fb')).toBe('a/b');
    expect(readProposalHashId('#proposals')).toBe('');
    expect(readProposalHashId('#status')).toBe('');
    expect(readProposalHashId('')).toBe('');
  });
});

describe('initialTabFromHash', () => {
  it('prefers proposal deep link, then tab fragment, else status', () => {
    expect(initialTabFromHash('#proposal=x')).toBe('proposals');
    expect(initialTabFromHash('#audit')).toBe('logs');
    expect(initialTabFromHash('#links')).toBe('links');
    expect(initialTabFromHash('')).toBe('status');
  });
});
