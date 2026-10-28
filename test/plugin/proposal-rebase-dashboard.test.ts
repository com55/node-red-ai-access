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
      renderConflictPanel, updateProposalConflict, renderPendingActions, renderRebaseChip, countPendingBuckets, renderProposalCard,
      setCanApprove: function (value) { canApprove = value; },
      setReload: function (reload, diff) { loadProposals = reload; loadProposalDiff = diff; },
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

describe('dashboard rebase controls', () => {
  it('renders all three comparisons, including live changes for a clean rebase', () => {
    const ui = dashboard();
    const html = ui.renderHumanDiff({
      rebase: { state: 'clean' },
      liveChanges: { summary: { tabChanges: ['label'] } },
      vsCurrent: {},
    });
    expect(html).toContain('Proposed change (vs base)');
    expect(html).toContain('Changed in editor since submit');
    expect(html).toContain('Flow settings changed: label');
    expect(html).toContain('Will deploy (vs live)');
  });

  it.each(['rebase_ack_required', 'proposal_conflict', 'rebase_race'])(
    'handles %s without retrying approval',
    async code => {
      const ui = dashboard();
      const api = vi.fn().mockRejectedValue({ status: 409, body: { code } });
      const reload = vi.fn();
      const diff = vi.fn();
      const toast = vi.fn();
      ui.setApi(api);
      ui.setToast(toast);
      ui.setReload(reload, diff);
      ui.setProposal({ id: 'p', status: 'pending' }, { rebase: { mergedHash: 'old' } });
      await ui.doApproveProposal('p', 'nodes');
      expect(api).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(code === 'rebase_race' ? 0 : 1);
      expect(diff).toHaveBeenCalledTimes(code === 'rebase_race' ? 0 : 1);
      expect(toast.mock.calls[0][0]).toContain(
        code === 'rebase_ack_required'
          ? 'review the updated diff'
          : code === 'rebase_race'
            ? 'Flows kept changing, try again'
            : 'Resolve the conflicts'
      );
    }
  );

  it('shows secret_may_revert on the proposal card before the diff loads', () => {
    const ui = dashboard();
    const html = ui.renderProposalCard({
      id: 'p',
      status: 'pending',
      title: 'Function edit',
      payload: { flowId: 'tab', flow: { nodes: [] } },
      warnings: [
        {
          code: 'secret_may_revert',
          error: 'Review the proposed secret against live flows.',
          nodeId: 'a',
          property: 'func',
        },
      ],
    });
    expect(html).toContain('secret_may_revert');
    expect(html).toContain('Review the proposed secret against live flows.');
  });

  it('shows an unknown deployment outcome on the card before the diff loads', () => {
    const ui = dashboard();
    const html = ui.renderProposalCard({
      id: 'p',
      status: 'pending',
      title: 'Late deployment',
      payload: { flowId: 'tab', flow: { nodes: [] } },
      deployPending: { mergedHash: 'abc', reason: 'Approvals wait until the runtime settles.' },
    });
    expect(html).toContain('Deploy outcome unknown');
    expect(html).toContain('Approvals wait until the runtime settles.');
  });

  it('shows ambiguous duplicate env pairing on the card', () => {
    const ui = dashboard();
    const html = ui.renderProposalCard({
      id: 'p',
      status: 'conflict',
      title: 'Env edit',
      payload: { flowId: 'tab', flow: { nodes: [] } },
      warnings: [{ code: 'duplicate_env_keys', error: 'Pairing by name is ambiguous.' }],
    });
    expect(html).toContain('duplicate_env_keys');
    expect(html).toContain('Pairing by name is ambiguous.');
  });

  it('escapes conflict details and offers only the available choices', () => {
    const ui = dashboard();
    ui.setCanApprove(true);
    const html = ui.renderConflictPanel({
      id: 'p',
      rebase: {
        state: 'conflict',
        conflicts: [
          {
            kind: 'node_changed_both',
            nodeId: 'n',
            nodeName: '<img src=x>',
            nodeType: 'function',
            fields: ['func'],
            message: '<script>alert(1)</script>',
            choices: ['live'],
          },
        ],
      },
    });
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Keep live');
    expect(html).not.toContain('Use proposed');
    expect(html).toContain('Re-check');
  });

  it('posts a conflict choice and reloads the proposal and diff', async () => {
    const ui = dashboard();
    const api = vi.fn();
    const reload = vi.fn();
    const diff = vi.fn();
    ui.setApi(api);
    ui.setReload(reload, diff);
    await ui.updateProposalConflict('p', 'n', 'proposed');
    expect(api).toHaveBeenCalledWith('/proposals/p/resolve-conflict', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'n', choice: 'proposed' }),
    });
    expect(reload).toHaveBeenCalledOnce();
    expect(diff).toHaveBeenCalledWith('p');
  });
});

describe('proposal status presentation', () => {
  it('counts conflicts as pending and disables their Approve button', () => {
    const ui = dashboard();
    ui.setCanApprove(true);
    const p = { id: 'p', status: 'conflict', rebase: { state: 'conflict' } };
    ui.setProposal(p, { rebase: p.rebase });
    expect(ui.countPendingBuckets()).toMatchObject({ pending: 1, decided: 0 });
    expect(ui.renderPendingActions(p, true)).toContain(
      'disabled title="Resolve conflicts before approving"'
    );
  });

  it('shows the live change count on rebased pending proposals', () => {
    const ui = dashboard();
    const p = { id: 'p', status: 'pending', rebase: { state: 'merged', liveChangedCount: 3 } };
    expect(ui.renderRebaseChip(p)).toContain('Rebased · 3 live changes');
    expect(ui.renderRebaseChip(p)).not.toContain(' hidden');
  });

  it('uses the updated rendered hash only on the next Approve click', async () => {
    const ui = dashboard();
    const api = vi.fn().mockRejectedValue({ status: 409, body: { code: 'rebase_ack_required' } });
    const p = { id: 'p', status: 'pending' };
    ui.setToast(vi.fn());
    ui.setApi(api);
    ui.setProposal(p, { rebase: { state: 'merged', mergedHash: 'old' } });
    ui.setReload(vi.fn(), () =>
      ui.setProposal(p, { rebase: { state: 'merged', mergedHash: 'new' } })
    );
    await ui.doApproveProposal('p', 'nodes');
    expect(api).toHaveBeenCalledTimes(1);
    await ui.doApproveProposal('p', 'nodes');
    expect(JSON.parse(api.mock.calls[1][1].body).mergedHash).toBe('new');
  });
});
