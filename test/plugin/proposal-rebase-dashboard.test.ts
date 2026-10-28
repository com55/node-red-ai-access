import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { pageClientScript } from '../../src/plugin/page-client.js';

// Run the shipped browser code with a minimal DOM and no boot-time requests.
function dashboard() {
  const context = {
    document: {
      getElementById: (id: string) =>
        id === 'mcp-root'
          ? { getAttribute: () => '{}' }
          : {
              addEventListener: vi.fn(),
              querySelectorAll: () => [],
              getAttribute: () => null,
              setAttribute: vi.fn(),
            },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
    },
    window: { addEventListener: vi.fn() },
    location: { hash: '' },
  };
  return runInNewContext(
    pageClientScript().replace(
      '  boot();',
      `
    globalThis.dashboard = {
      proposalIsStale, approveProposal, doApproveProposal, renderHumanDiff,
      setProposal: function (proposal, diff) {
        cachedProposals = [proposal];
        proposalDiffCache[proposal.id] = diff;
      },
      setApprove: function (fn) { doApproveProposal = fn; },
      setToast: function (fn) { showToast = fn; },
      setApi: function (fn) { api = fn; }
    };
  `
    ) + '\nglobalThis.dashboard;',
    context
  );
}

describe('dashboard auto-rebase review', () => {
  it.each(['clean', 'merged'])(
    'allows approval after a revision change with %s rebase',
    async state => {
      const ui = dashboard();
      const approve = vi.fn();
      ui.setApprove(approve);
      const proposal = { id: 'p', status: 'pending', baseRevStale: true, rebase: { state } };
      ui.setProposal(proposal, { baseRevStale: true, rebase: { state }, summary: { modified: 1 } });
      expect(ui.proposalIsStale(proposal)).toBe(false);
      await ui.approveProposal('p');
      expect(approve).toHaveBeenCalledWith('p', 'nodes');
    }
  );

  it('acknowledges the reviewed diff hash rather than an unseen list hash', async () => {
    const ui = dashboard();
    const api = vi.fn().mockRejectedValue(new Error('stop after capturing request'));
    ui.setApi(api);
    ui.setToast(vi.fn());
    ui.setProposal(
      { id: 'p', status: 'pending', rebase: { state: 'merged', mergedHash: 'unseen-list-hash' } },
      { rebase: { state: 'merged', mergedHash: 'reviewed-diff-hash' } }
    );
    await ui.doApproveProposal('p', 'nodes');
    expect(api).toHaveBeenCalledWith('/proposals/p/approve', {
      method: 'POST',
      body: JSON.stringify({ deploymentType: 'nodes', mergedHash: 'reviewed-diff-hash' }),
    });
  });

  it('keeps conflict proposals open and blocks deployment', async () => {
    const ui = dashboard();
    const approve = vi.fn();
    const toast = vi.fn();
    ui.setApprove(approve);
    ui.setToast(toast);
    const proposal = { id: 'p', status: 'conflict', rebase: { state: 'conflict' } };
    ui.setProposal(proposal, { rebase: { state: 'conflict' } });
    expect(ui.proposalIsStale(proposal)).toBe(true);
    await ui.approveProposal('p');
    expect(approve).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Resolve the conflicts'), false);
  });
});
