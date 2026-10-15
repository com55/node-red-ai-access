import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DraftAlreadySubmittedError,
  DraftStore,
  DraftValidationError,
} from '../../src/plugin/get-link/draft-store.js';

describe('DraftStore', () => {
  it('rejects invalid base64url with invalid_chunk_data and does not store seq', () => {
    const store = new DraftStore({ randomId: () => 'd1' });
    store.create({
      linkId: 'L',
      flowId: 'tab-1',
      expectedRev: 'r1',
      mode: 'field',
      nodeId: 'n1',
      field: 'template',
    });

    try {
      store.append('d1', 'L', 0, '@@@');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DraftValidationError);
      expect(error).toMatchObject({ code: 'invalid_chunk_data', statusCode: 400 });
    }

    const ok = store.append('d1', 'L', 0, Buffer.from('hi', 'utf8').toString('base64url'));
    expect(ok.receivedSeqs).toEqual([0]);
    expect(ok.totalBytes).toBe(2);
  });

  it('rejects malformed sha256 with invalid_sha256', () => {
    const store = new DraftStore({ randomId: () => 'd2' });
    store.create({
      linkId: 'L',
      flowId: 'tab-1',
      expectedRev: 'r1',
      mode: 'field',
      nodeId: 'n1',
      field: 'template',
    });
    store.append('d2', 'L', 0, Buffer.from('x', 'utf8').toString('base64url'));

    expect(() => store.assembleAndVerify('d2', 'L', 'abc')).toThrow(
      expect.objectContaining({ code: 'invalid_sha256' })
    );
  });

  it('markSubmitted makes re-get throw draft_already_submitted with proposalId', () => {
    const store = new DraftStore({ randomId: () => 'd3' });
    store.create({
      linkId: 'L',
      flowId: 'tab-1',
      expectedRev: 'r1',
      mode: 'field',
      nodeId: 'n1',
      field: 'template',
    });
    const raw = Buffer.from('hello', 'utf8');
    store.append('d3', 'L', 0, raw.toString('base64url'));
    const digest = createHash('sha256').update(raw).digest('hex');
    const assembled = store.assembleAndVerify('d3', 'L', digest);
    expect(assembled.assembled).toBe('hello');

    store.markSubmitted('d3', 'L', 'prop-99');
    expect(() => store.getForLink('d3', 'L')).toThrow(DraftAlreadySubmittedError);
    try {
      store.getForLink('d3', 'L');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'draft_already_submitted',
        proposalId: 'prop-99',
        statusCode: 409,
      });
    }
  });
});
