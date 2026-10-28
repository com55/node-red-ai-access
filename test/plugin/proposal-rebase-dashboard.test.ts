import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

import { pageClientScript } from '../../src/plugin/page-client.js';

// Run the shipped browser code with a minimal DOM and no boot-time requests.
function dashboard() {
  const elements = new Map<string, any>();
  const context = {
    document: {
      getElementById: (id: string) =>
        id === 'mcp-root'
          ? { getAttribute: () => '{}' }
          : (elements.get(id) ?? {
              addEventListener: vi.fn(),
              querySelectorAll: () => [],
              getAttribute: () => null,
              setAttribute: vi.fn(),
            }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
    },
    elements,
    window: { addEventListener: vi.fn() },
    location: { hash: '' },
  };
  return runInNewContext(
    pageClientScript().replace(
      '  boot();',
      `
    globalThis.dashboard = {
      proposalIsStale, approveProposal, doApproveProposal, renderHumanDiff,
      renderConflictPanel, updateProposalConflict, updatePendingBadges, showFlash, authGateStatus, bindProposalActions, renderPendingActions, renderRebaseChip, countPendingBuckets, renderProposalCard,
      setElement: function (id, el) { elements.set(id, el); },
      setProposals: function (value) { cachedProposals = value; proposalDiffCache = {}; },
      setConfirm: function (fn) { openConfirmDialog = fn; },
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
      const proposal = { id: 'p', status: 'pending', baseRevChanged: true, rebase: { state } };
      ui.setProposal(proposal, {
        baseRevChanged: true,
        rebase: { state },
        summary: { modified: 1 },
      });
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
      rebase: { state: 'merged' },
      summary: { modified: 1 },
      modified: [{ id: 'n', changes: [{ key: 'name', kind: 'scalar', before: 'a', after: 'b' }] }],
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

  it('asks reviewers to check live after the deployment hard cap', () => {
    const html = dashboard().renderProposalCard({
      id: 'p',
      status: 'pending',
      title: 'Unsettled deployment',
      payload: { flowId: 'tab', flow: { nodes: [] } },
      deployPending: {
        mergedHash: 'abc',
        reason: 'The approval queue was released.',
        queueReleased: true,
      },
    });
    expect(html).toContain('Deploy outcome unknown');
    expect(html).toContain('The approval queue was released.');
    expect(html).toContain('Check the live flow before approving again.');
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
    expect(html).toContain('The editor and proposal changed the same fields');
    expect(html).not.toContain('node_changed_both');
    expect(html).not.toContain('<script>');
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

describe('proposal UX details', () => {
  const empty = {
    summary: { added: 0, removed: 0, modified: 0, tabChanges: [] },
    added: [],
    removed: [],
    modified: [],
  };

  it('hides deployment and security notes for a rebased proposal with no net change', async () => {
    const ui = dashboard();
    ui.setCanApprove(true);
    const p = {
      id: 'p',
      status: 'pending',
      payload: { flowId: 'tab', flow: {} },
      warnings: [{ code: 'secret_may_revert', error: 'Security review' }],
    };
    const diff = { ...empty, rebase: { state: 'merged' }, vsCurrent: empty };
    ui.setProposal(p, diff);
    const html = ui.renderProposalCard(p);
    expect(html).toContain('Nothing changes in the live flow.');
    expect(html).not.toContain('approve-btn');
    expect(html).not.toContain('Security review');
    expect(html).toContain('Reject to close');
    const approve = vi.fn();
    ui.setApprove(approve);
    ui.setToast(vi.fn());
    await ui.approveProposal('p');
    expect(approve).not.toHaveBeenCalled();
  });

  it('omits duplicate comparisons and an unchanged editor section', () => {
    const ui = dashboard();
    const changes = { ...empty, summary: { ...empty.summary, tabChanges: ['label'] } };
    const html = ui.renderHumanDiff({
      ...changes,
      rebase: { state: 'clean' },
      liveChanges: empty,
      vsCurrent: changes,
    });
    expect(html).toContain('Proposed change</h3>');
    expect(html).not.toContain('vs base');
    expect(html).not.toContain('vs live');
    expect(html).not.toContain('Changed in editor since submit');
  });

  it('keeps distinct flow-setting comparisons even when both change the same field', () => {
    const ui = dashboard();
    const primary = {
      summary: { tabChanges: ['label'] },
      tabProperties: [{ key: 'label', kind: 'scalar', before: 'base', after: 'proposed' }],
    };
    const html = ui.renderHumanDiff({
      ...primary,
      rebase: { state: 'merged' },
      liveChanges: { summary: { tabChanges: ['label'] } },
      vsCurrent: {
        ...primary,
        tabProperties: [{ key: 'label', kind: 'scalar', before: 'live', after: 'proposed' }],
      },
    });
    expect(html).toContain('Proposed change (vs base)');
    expect(html).toContain('Will deploy (vs live)');
    expect(html).toContain('base');
    expect(html).toContain('live');
  });

  it('shows each warning once in one counted area with separate security and configuration headings', () => {
    const ui = dashboard();
    ui.setCanApprove(true);
    const warnings = [
      { code: 'outbound_node_changed', error: 'Review destination' },
      { code: 'missing_config', error: 'Choose broker' },
    ];
    const p = { id: 'p', status: 'pending', payload: { flowId: 'tab', flow: {} }, warnings };
    ui.setProposal(p, { ...empty, warnings });
    const html = ui.renderProposalCard(p);
    expect(html).toContain('Review notes (2)');
    expect(html).toContain('Security review (1)');
    expect(html).toContain('Needs configuration (1)');
    expect(html.match(/Review destination/g)).toHaveLength(1);
    expect(html.match(/Choose broker/g)).toHaveLength(1);
    expect(html).not.toContain('Scaffold warnings');
    expect(html).not.toContain('Approve will deploy with');
  });

  it('renders the tab, node identity, friendly reason and three escaped field values, including flow env', () => {
    const ui = dashboard();
    const rebase = {
      state: 'conflict',
      conflicts: [
        {
          nodeId: 'tab',
          nodeName: 'Main',
          nodeType: 'tab',
          kind: 'tab_changed_both',
          fields: ['env["MODE"].value'],
          choices: [],
        },
      ],
    };
    const html = ui.renderConflictPanel(
      { id: 'p', flowLabel: 'Main', rebase },
      {
        rebase,
        conflictValues: [
          {
            nodeId: 'tab',
            fields: [
              {
                field: 'env["MODE"].value',
                base: 'before',
                live: 'editor',
                proposed: '<script>after</script>',
              },
            ],
          },
        ],
      }
    );
    for (const text of [
      'Main · Main',
      'tab',
      'same flow settings',
      'Base (before submission)',
      'Live (in editor)',
      'Proposed (by AI)',
      'before',
      'editor',
      '&lt;script&gt;after&lt;/script&gt;',
      'MODE',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('tab_changed_both');
    expect(html).not.toContain('<script>');
  });

  it('shows the chosen state and a real undo/change control after resolution', () => {
    const ui = dashboard();
    ui.setCanApprove(true);
    const html = ui.renderConflictPanel({
      id: 'p',
      conflictChoice: { nodeId: 'n', choice: 'live' },
      rebase: { state: 'clean' },
    });
    expect(html).toContain('Chosen: Keep live');
    expect(html).toContain('Undo / change choice');
    expect(html).toContain('data-choice="undo"');
  });

  it('requires confirmation before sending a conflict choice', () => {
    const ui = dashboard();
    const api = vi.fn();
    const confirm = vi.fn();
    let click: (() => void) | undefined;
    const attrs: Record<string, string> = {
      'data-id': 'p',
      'data-node-id': 'n',
      'data-choice': 'proposed',
    };
    const button = {
      getAttribute: (key: string) => attrs[key],
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
      },
      addEventListener: (_event: string, fn: () => void) => {
        click = fn;
      },
    };
    ui.setApi(api);
    ui.setConfirm(confirm);
    ui.bindProposalActions({
      querySelectorAll: (selector: string) =>
        selector.includes('resolve-conflict-btn') ? [button] : [],
    });
    click?.();
    expect(api).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Use proposed values?',
        confirmLabel: 'Confirm choice',
        onConfirm: expect.any(Function),
      })
    );
  });

  it.each([true, false])(
    'shows a spinner during recheck and the result (conflicting=%s)',
    async conflict => {
      const ui = dashboard();
      let finish: ((value: unknown) => void) | undefined;
      ui.setApi(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      );
      ui.setReload(vi.fn(), vi.fn());
      ui.setProposal(
        { id: 'p', status: conflict ? 'conflict' : 'pending' },
        { rebase: { state: conflict ? 'conflict' : 'clean' } }
      );
      const toast = vi.fn();
      ui.setToast(toast);
      const button = {
        textContent: 'Re-check',
        innerHTML: '',
        disabled: false,
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      };
      const work = ui.updateProposalConflict('p', null, null, button);
      expect(button.disabled).toBe(true);
      expect(button.innerHTML).toContain('spinner');
      finish?.({});
      await work;
      expect(toast).toHaveBeenCalledWith(
        expect.stringContaining(conflict ? 'Still conflicting' : 'Resolved'),
        true
      );
      expect(button.disabled).toBe(false);
    }
  );

  it('uses the same total on the pending filter, dashboard and badge while keeping the conflict breakdown', () => {
    const ui = dashboard();
    ui.setProposals([
      { id: 'a', status: 'pending' },
      { id: 'b', status: 'conflict' },
      { id: 'c', status: 'approved' },
    ]);
    const elements = [
      'proposals-pending-badge',
      'filter-pending-count',
      'dash-pending',
      'filter-decided-count',
    ].map(id => {
      const el = { textContent: '', title: '', hidden: true };
      ui.setElement(id, el);
      return el;
    });
    ui.updatePendingBadges();
    expect(elements.slice(0, 3).map(el => el.textContent)).toEqual(['2', '2', '2']);
    expect(elements[0]?.title).toBe('1 to review · 1 conflict');
    expect(elements[3]?.textContent).toBe('1');
  });

  it('marks errors as alerts without changing the sign-in button', () => {
    const ui = dashboard();
    const status = { textContent: '', className: '', hidden: true, setAttribute: vi.fn() };
    const button = { className: 'sg-primary' };
    ui.setElement('auth-gate-status', status);
    ui.setElement('auth-gate-submit', button);
    ui.authGateStatus('Wrong password', true);
    expect(status.setAttribute).toHaveBeenCalledWith('role', 'alert');
    expect(button.className).toBe('sg-primary');
    ui.showFlash(status, 'Failed to save', false);
    expect(status.setAttribute).toHaveBeenLastCalledWith('role', 'alert');
  });
});
