import { describe, expect, it } from 'vitest';

import {
  applyConflictChoice,
  nestedLiveTab,
  rebaseFlowTab,
  stableStringify,
  type RebaseInput,
} from '../../src/plugin/proposal-rebase.js';
import { redactFlowData, restoreRedactedPlaceholders } from '../../src/plugin/secret-redaction.js';
import { replaceFlowTabInFlatFlows } from '../../src/runtime/flows-util.js';
import { RevHistory, snapshotAdapter, withRevHistory } from '../../src/runtime/rev-history.js';
import type { FlowNode, FlowTab } from '../../src/runtime/types.js';

const clone = <T>(v: T): T => structuredClone(v);
const base: FlowTab = {
  id: 'tab',
  type: 'tab',
  label: 'Main',
  disabled: false,
  info: '',
  env: [],
  nodes: [
    { id: 'a', type: 'function', func: 'return msg;', x: 10, y: 20, wires: [[]] },
    { id: 'b', type: 'debug', name: 'output', x: 30, y: 40, wires: [] },
  ],
  configs: [{ id: 'cfg', type: 'mqtt-broker', broker: 'localhost' }],
};
function flat(tab: FlowTab): FlowNode[] {
  const { nodes = [], configs = [], ...props } = clone(tab);
  return [props as FlowNode, ...[...nodes, ...configs].map(n => ({ ...n, z: tab.id }))];
}
function rebase(proposed = clone(base), live = clone(base), overrides: Partial<RebaseInput> = {}) {
  return rebaseFlowTab({
    flowId: 'tab',
    base: clone(base),
    proposed,
    liveFlows: flat(live),
    liveRev: 'r2',
    baseRev: 'r1',
    ...overrides,
  });
}
function expectConflict(result: ReturnType<typeof rebase>, kind: string, nodeId = 'a') {
  expect(result).toMatchObject({
    state: 'conflict',
    conflicts: expect.arrayContaining([expect.objectContaining({ kind, nodeId })]),
  });
  expect(result.merged).toBeUndefined();
  expect(result.mergedHash).toBeUndefined();
}

describe('per-field proposal three-way rebase', () => {
  it('is clean across unrelated global revisions, without mutating inputs', () => {
    const p = clone(base);
    p.nodes![0]!.func = 'proposal';
    const input = {
      flowId: 'tab',
      base,
      proposed: p,
      liveFlows: [...flat(base), { id: 'elsewhere', type: 'tab' }],
      liveRev: 'r2',
    };
    const before = clone(input);
    expect(rebaseFlowTab(input)).toMatchObject({ state: 'clean', merged: p, liveChangedIds: [] });
    expect(input).toEqual(before);
  });

  it('merges edits to disjoint nodes and configs in deterministic proposal order', () => {
    const p = clone(base);
    p.nodes![0]!.func = 'proposal';
    const c = clone(base);
    c.nodes![1]!.name = 'editor';
    c.configs![0]!.broker = 'editor.local';
    c.nodes!.push({ id: 'new-live', type: 'debug', wires: [] });
    const result = rebase(p, c);
    expect(result.state).toBe('merged');
    expect(result.merged!.nodes!.map(n => n.id)).toEqual(['a', 'b', 'new-live']);
    expect(result.merged!.nodes![0]!.func).toBe('proposal');
    expect(result.merged!.nodes![1]!.name).toBe('editor');
    expect(result.merged!.configs![0]!.broker).toBe('editor.local');
    expect(result.liveChangedIds).toEqual(['b', 'cfg', 'new-live']);
  });

  it.each(['live', 'proposed'] as const)(
    'merges %s position-only changes with content edits',
    side => {
      const p = clone(base),
        c = clone(base);
      const position = side === 'live' ? c : p;
      const content = side === 'live' ? p : c;
      position.nodes![0]!.x = 101;
      delete position.nodes![0]!.y;
      content.nodes![0]!.func = 'updated';
      const result = rebase(p, c);
      expect(result.state).toBe('merged');
      expect(result.merged!.nodes![0]).toMatchObject({ func: 'updated', x: 101 });
      expect(result.merged!.nodes![0]).not.toHaveProperty('y');
    }
  );

  it.each(['same field', 'identical content'])('conflicts on both-side node edits: %s', mode => {
    const p = clone(base),
      c = clone(base);
    p.nodes![0]!.func = 'proposal';
    c.nodes![0]!.func = mode === 'identical content' ? 'proposal' : 'live';
    expectConflict(rebase(p, c), 'node_changed_both');
  });

  it('merges disjoint config fields', () => {
    const p = clone(base),
      c = clone(base);
    p.configs![0]!.broker = 'proposal';
    c.configs![0]!.port = 1884;
    expect(rebase(p, c).merged!.configs![0]).toMatchObject({ broker: 'proposal', port: 1884 });
  });

  it('merges disjoint fields of one node, including removals, and reports only overlapping fields', () => {
    const b = clone(base);
    Object.assign(b.nodes![0]!, { name: 'before', outputs: 1 });
    const p = clone(b),
      c = clone(b);
    p.nodes![0]!.func = 'proposal';
    delete p.nodes![0]!.outputs;
    c.nodes![0]!.name = 'live';
    const before = clone({ b, p, c });
    expect(rebase(p, c, { base: b }).merged!.nodes![0]).toMatchObject({
      name: 'live',
      func: 'proposal',
    });
    expect(rebase(p, c, { base: b }).merged!.nodes![0]).not.toHaveProperty('outputs');
    p.nodes![0]!.name = 'proposed name';
    const result = rebase(p, c, { base: b });
    expect(result.conflicts[0]!.fields).toEqual(['name']);
    for (const choice of ['live', 'proposed'] as const) {
      const next = applyConflictChoice({
        flowId: 'tab',
        base: b,
        proposed: p,
        liveFlows: flat(c),
        nodeId: 'a',
        choice,
      });
      expect(
        rebase(next.proposed as FlowTab, c, { base: next.base }).merged!.nodes!.find(
          n => n.id === 'a'
        )
      ).toMatchObject({
        name: choice === 'live' ? 'live' : 'proposed name',
        func: 'proposal',
      });
    }
    expect(b).toEqual(before.b);
    expect(c).toEqual(before.c);
  });

  it.each(['tab', 'node', 'config'] as const)(
    'merges env per unique name and entry field on %s',
    location => {
      const b = clone(base);
      const entity = (tab: FlowTab) =>
        location === 'tab'
          ? tab
          : location === 'node'
            ? tab.nodes!.find(n => n.id === 'a')!
            : tab.configs![0]!;
      entity(b).env = [
        { name: 'A', value: 'old', type: 'str' },
        { name: 'PASSWORD', value: 'old-secret', type: 'str' },
      ];
      const p = clone(b),
        c = clone(b);
      entity(p).env = [
        { name: 'A', value: 'proposed', type: 'str' },
        { name: 'PASSWORD', value: 'old-secret', type: 'str' },
        { name: 'NEW', value: 'new' },
      ];
      entity(c).env = [
        { name: 'PASSWORD', value: 'live-secret', type: 'str' },
        { name: 'A', value: 'old', type: 'num' },
      ];
      const result = rebase(p, c, { base: b });
      expect(result.state).toBe('merged');
      expect(entity(result.merged!).env).toEqual([
        { name: 'A', value: 'proposed', type: 'num' },
        { name: 'PASSWORD', value: 'live-secret', type: 'str' },
        { name: 'NEW', value: 'new' },
      ]);
      (entity(c).env as { name: string; value: string }[]).find(e => e.name === 'A')!.value =
        'live';
      expect(rebase(p, c, { base: b }).conflicts[0]!.fields).toEqual(['env["A"].value']);
      for (const choice of ['live', 'proposed'] as const) {
        const nodeId = location === 'tab' ? 'tab' : location === 'node' ? 'a' : 'cfg';
        const next = applyConflictChoice({
          flowId: 'tab',
          base: b,
          proposed: p,
          liveFlows: flat(c),
          nodeId,
          choice,
        });
        const resolved = rebase(next.proposed as FlowTab, c, { base: next.base });
        expect(resolved.state).not.toBe('conflict');
        expect(entity(resolved.merged!).env).toEqual(
          expect.arrayContaining([
            { name: 'A', value: choice === 'live' ? 'live' : 'proposed', type: 'num' },
            { name: 'PASSWORD', value: 'live-secret', type: 'str' },
            { name: 'NEW', value: 'new' },
          ])
        );
      }
    }
  );

  it('merges credentials per key without reverting live secrets and conflicts on the same key', () => {
    const b = clone(base);
    b.configs![0]!.credentials = { user: 'old', password: 'old-secret', nested: { a: 1, b: 1 } };
    const p = clone(b),
      c = clone(b);
    p.configs![0]!.credentials = {
      user: 'proposed',
      password: 'old-secret',
      nested: { a: 2, b: 1 },
    };
    c.configs![0]!.credentials = { user: 'old', password: 'live-secret', nested: { a: 1, b: 2 } };
    expect(rebase(p, c, { base: b }).merged!.configs![0]!.credentials).toEqual({
      user: 'proposed',
      password: 'live-secret',
      nested: { a: 2, b: 2 },
    });
    (c.configs![0]!.credentials as Record<string, unknown>).user = 'live';
    expect(rebase(p, c, { base: b }).conflicts[0]!.fields).toEqual(['credentials.user']);
  });

  it('merges disjoint credential keys even when the credentials container is new', () => {
    const p = clone(base),
      c = clone(base);
    p.configs![0]!.credentials = { user: 'proposed' };
    c.configs![0]!.credentials = { password: 'live-secret' };
    expect(rebase(p, c).merged!.configs![0]!.credentials).toEqual({
      user: 'proposed',
      password: 'live-secret',
    });
  });

  it('conflicts on env removal versus an edit, and uses atomic fallback for duplicate names', () => {
    const b = clone(base);
    b.env = [{ name: 'A', value: 'old' }];
    const p = clone(b),
      c = clone(b);
    p.env = [];
    c.env![0]!.value = 'live';
    expect(rebase(p, c, { base: b }).conflicts[0]!.fields).toEqual(['env["A"]']);
    b.env.push({ name: 'A', value: 'duplicate' });
    p.env = [...b.env].reverse();
    c.env = [{ name: 'A', value: 'live' }, b.env[1]!];
    expect(rebase(p, c, { base: b }).conflicts[0]!.fields).toEqual(['env']);
  });

  it('accepts live deletion when proposal left the node alone, and accepts proposal-only and shared deletions', () => {
    const p = clone(base),
      c = clone(base);
    c.nodes!.shift();
    p.nodes![1]!.name = 'proposal';
    expect(rebase(p, c)).toMatchObject({
      state: 'merged',
      merged: { nodes: [{ id: 'b', name: 'proposal' }] },
    });
    p.nodes!.shift();
    expect(rebase(p)).toMatchObject({ state: 'clean', merged: { nodes: [{ id: 'b' }] } });
    expect(rebase(p, c).state).toBe('clean');
  });

  it.each(['content', 'position'])('live deletion conflicts with a proposal %s edit', mode => {
    const p = clone(base),
      c = clone(base);
    c.nodes!.shift();
    p.nodes![0]![mode === 'position' ? 'x' : 'func'] = 'changed';
    expectConflict(rebase(p, c), 'node_deleted_live');
  });

  it.each(['content', 'position'])('proposal deletion conflicts with live %s edit', mode => {
    const p = clone(base),
      c = clone(base);
    p.nodes!.shift();
    c.nodes![0]![mode === 'position' ? 'x' : 'func'] = 'changed';
    expectConflict(rebase(p, c), 'node_deleted_in_proposal_modified_live');
  });

  it.each(['same tab', 'identical same tab', 'another tab', 'global config', 'tab id'])(
    'conflicts on new id collision: %s',
    kind => {
      const p = clone(base);
      const n = { id: kind === 'tab id' ? 'tab' : 'new', type: 'debug', wires: [] };
      p.nodes!.push(n);
      const liveFlows = flat(base);
      if (kind !== 'tab id')
        liveFlows.push({
          ...n,
          name: kind === 'identical same tab' ? undefined : 'live',
          ...(kind.includes('same tab')
            ? { z: 'tab' }
            : kind === 'another tab'
              ? { z: 'other' }
              : {}),
        });
      expectConflict(rebase(p, base, { liveFlows }), 'id_collision', n.id);
    }
  );

  it('conflicts when an existing node id moved to another tab', () => {
    const liveFlows = flat(base).map(n => (n.id === 'a' ? { ...n, z: 'other' } : n));
    expectConflict(rebase(base, base, { liveFlows }), 'id_collision');
  });

  it('conflicts if the tab disappeared or its id now belongs to a node', () => {
    for (const liveFlows of [[], [{ id: 'tab', type: 'debug' }]]) {
      expectConflict(rebase(base, base, { liveFlows }), 'tab_deleted', 'tab');
    }
  });

  it.each(['label', 'disabled', 'info', 'env'] as const)(
    'strictly merges tab property %s',
    field => {
      const p = clone(base),
        c = clone(base);
      const value =
        field === 'env'
          ? [{ name: 'MODE', value: 'live', type: 'str' }]
          : field === 'disabled'
            ? true
            : 'changed';
      Object.assign(c, { [field]: value });
      expect(rebase(p, c)).toMatchObject({ state: 'merged', merged: { [field]: value } });
      Object.assign(p, { [field]: value });
      expectConflict(rebase(p, c), 'tab_changed_both', 'tab');
    }
  );

  it.each(['label', 'disabled', 'info', 'env'] as const)(
    'actually clears a removed tab setting: %s',
    field => {
      const b = clone(base);
      Object.assign(b, {
        [field]:
          field === 'env'
            ? [{ name: 'API_KEY', value: 'secret' }]
            : field === 'disabled'
              ? true
              : 'old',
      });
      const p = clone(b);
      delete p[field];
      const result = rebase(p, b, { base: b });
      expect(result.state).toBe('clean');
      const deployedTab = replaceFlowTabInFlatFlows(flat(b), 'tab', result.merged!).find(
        n => n.id === 'tab'
      )!;
      expect(deployedTab[field]).toEqual(field === 'env' ? [] : field === 'disabled' ? false : '');
    }
  );

  it('merges different tab properties', () => {
    const p = clone(base),
      c = clone(base);
    p.label = 'proposal';
    c.info = 'editor';
    expect(rebase(p, c).merged).toMatchObject({ label: 'proposal', info: 'editor' });
  });

  it.each(['wire', 'group', 'group member', 'link'])(
    'blocks dangling %s references, including preexisting ones',
    kind => {
      const p = clone(base);
      if (kind === 'wire') p.nodes![0]!.wires = [['missing']];
      if (kind === 'group') p.nodes![0]!.g = 'missing';
      if (kind === 'group member')
        Object.assign(p.nodes![0]!, { type: 'group', nodes: ['missing'] });
      if (kind === 'link') p.nodes![0]!.links = ['missing'];
      expectConflict(rebase(p), 'dangling_reference');
    }
  );

  it('blocks a wire broken by accepting a live deletion', () => {
    const p = clone(base),
      c = clone(base);
    p.nodes![0]!.wires = [['b']];
    c.nodes!.pop();
    expectConflict(rebase(p, c), 'dangling_reference');
  });

  it('allows empty group membership from editor exports', () => {
    const p = clone(base);
    p.nodes![0]!.g = '';
    expect(rebase(p).state).toBe('clean');
  });

  it('allows link references to other tabs', () => {
    const p = clone(base);
    p.nodes![0]!.links = ['external'];
    expect(
      rebase(p, base, {
        liveFlows: [...flat(base), { id: 'external', type: 'link in', z: 'other' }],
      }).state
    ).toBe('clean');
  });

  it.each(['node', 'config', 'tab', 'deep'])('never deploys a placeholder in %s data', location => {
    const p = clone(base);
    if (location === 'node') p.nodes![0]!.func = 'prefix [REDACTED] suffix';
    if (location === 'config') p.configs![0]!.password = '[REDACTED]';
    if (location === 'tab') p.env = [{ name: 'TOKEN', value: '[REDACTED]' }];
    if (location === 'deep') {
      let value: unknown = '[REDACTED]';
      for (let i = 0; i < 80; i++) value = { child: value };
      p.nodes![0]!.nested = value;
    }
    expect(rebase(p)).toMatchObject({
      state: 'conflict',
      conflicts: expect.arrayContaining([
        expect.objectContaining({ kind: 'redacted_placeholder' }),
      ]),
    });
  });

  it.each(['node', 'config', 'tab', 'deep'])(
    'allows a literal live placeholder at the same %s field path',
    location => {
      const b = clone(base);
      if (location === 'node') b.nodes![0]!.func = 'prefix [REDACTED] suffix';
      if (location === 'config') b.configs![0]!.password = '[REDACTED]';
      if (location === 'tab') b.env = [{ name: 'TOKEN', value: '[REDACTED]' }];
      if (location === 'deep') b.nodes![0]!.nested = { child: ['[REDACTED]'] };
      const p = clone(b);
      p.nodes![1]!.name = 'proposal';
      expect(rebase(p, b, { base: b }).state).toBe('clean');
      const live = clone(b);
      live.nodes![0]!.x = 100;
      expect(rebase(p, live, { base: b }).state).toBe('merged');
    }
  );

  it.each(['node', 'field', 'array index'])(
    'blocks a placeholder copied to a different %s',
    location => {
      const b = clone(base);
      b.nodes![0]!.nested = ['[REDACTED]', 'safe'];
      const p = clone(b);
      if (location === 'node') p.nodes![1]!.nested = ['[REDACTED]'];
      if (location === 'field') p.nodes![0]!.other = '[REDACTED]';
      if (location === 'array index') p.nodes![0]!.nested = ['safe', '[REDACTED]'];
      expect(rebase(p, b, { base: b }).conflicts).toContainEqual(
        expect.objectContaining({ kind: 'redacted_placeholder' })
      );
    }
  );

  it('keeps a literal placeholder added live after the proposal was submitted', () => {
    const p = clone(base),
      c = clone(base);
    p.nodes![1]!.name = 'proposal';
    c.nodes![0]!.func = '[REDACTED]';
    expect(rebase(p, c)).toMatchObject({
      state: 'merged',
      merged: {
        nodes: [
          expect.objectContaining({ id: 'a', func: '[REDACTED]' }),
          expect.objectContaining({ id: 'b', name: 'proposal' }),
        ],
      },
    });
  });

  it('legacy records need a base after revisions move and cannot bypass safety at the same rev', () => {
    expectConflict(rebase(base, base, { base: undefined }), 'base_unavailable', 'tab');
    expect(rebase(base, base, { base: undefined, baseRev: 'r2' }).state).toBe('clean');
    const p = clone(base);
    p.nodes![0]!.func = '[REDACTED]';
    expectConflict(rebase(p, base, { base: undefined, baseRev: 'r2' }), 'redacted_placeholder');
  });

  it.each(['node', 'deleted live', 'deleted proposed', 'collision', 'tab', 'legacy'])(
    'manual live/proposed choices rebase without conflict: %s',
    kind => {
      for (const choice of ['live', 'proposed'] as const) {
        const p = clone(base),
          c = clone(base);
        let nodeId = 'a';
        let b: FlowTab | undefined = clone(base);
        p.nodes![0]!.func = 'proposal';
        c.nodes![0]!.func = 'editor';
        if (kind === 'deleted live') c.nodes!.shift();
        if (kind === 'deleted proposed') p.nodes!.shift();
        if (kind === 'collision') {
          b.nodes!.shift();
        }
        if (kind === 'tab') {
          nodeId = 'tab';
          p.label = 'proposal';
          c.label = 'editor';
          p.nodes = clone(base.nodes);
          c.nodes = clone(base.nodes);
        }
        if (kind === 'legacy') {
          if (choice === 'live') continue;
          b = undefined;
        }
        const next = applyConflictChoice({
          flowId: 'tab',
          base: b,
          proposed: p,
          liveFlows: flat(c),
          nodeId,
          choice,
        });
        const result = rebase(next.proposed as FlowTab, c, { base: next.base });
        expect(result.state).not.toBe('conflict');
        expect(next.proposed).not.toBe(p);
      }
    }
  );

  it('hashes ignore object key order, node/config ordering, z and representation', () => {
    const p = clone(base);
    p.nodes![0]!.func = 'proposal';
    const first = rebase(p);
    const reordered = JSON.parse(stableStringify(p)) as FlowTab;
    reordered.nodes!.reverse();
    reordered.nodes!.push(...reordered.configs!);
    delete reordered.configs;
    for (const node of reordered.nodes!) node.z = 'tab';
    const second = rebase(reordered);
    expect(second.state).toBe('clean');
    expect(second.mergedHash).toBe(first.mergedHash);
    reordered.env = [{ name: 'NEW', value: 'setting' }];
    expect(rebase(reordered).mergedHash).not.toBe(first.mergedHash);
  });

  it.each(['in', 'out'])('rejects dangling subflow %s port wires', direction => {
    const subflow = {
      ...clone(base),
      type: 'subflow',
      [direction]: [{ wires: [{ id: 'a', port: 0 }] }],
    };
    const p = clone(subflow);
    p.nodes!.shift();
    expectConflict(rebase(p, subflow, { base: subflow }), 'dangling_reference', 'tab');
  });

  it('classifies groups as nodes and config nodes as configs, and supports subflow tabs', async () => {
    const subflow = { ...clone(base), type: 'subflow' };
    subflow.nodes!.push({ id: 'group', type: 'group', nodes: [] });
    const liveFlows = flat(subflow);
    for (const nested of [
      nestedLiveTab(liveFlows, 'tab')!,
      (await snapshotAdapter({ rev: 'r1', flows: liveFlows }, 'red').getFlow('tab')).flow,
    ]) {
      expect(nested.type).toBe('subflow');
      expect(nested.nodes!.some(n => n.id === 'group')).toBe(true);
      expect(nested.configs!.map(n => n.id)).toEqual(['cfg']);
      expect(nested.env).toEqual([]);
    }
    expect(rebase(subflow, subflow, { base: subflow }).merged!.type).toBe('subflow');
  });
});

describe('secrets during rebase', () => {
  const secretBase = (): FlowTab => {
    const b = clone(base);
    b.nodes![0]!.func = 'const API_KEY = "base-secret";\nreturn msg;';
    return b;
  };
  it.each(['password', 'credentials', 'env', 'code', 'tab env'])(
    'keeps a newer live %s secret on proposed conflict resolution unless intentionally changed',
    location => {
      for (const intentional of [false, true]) {
        const b = clone(base);
        const setSecret = (tab: FlowTab, value: string) => {
          const node = tab.nodes![0]!;
          if (location === 'password') node.password = value;
          if (location === 'credentials') node.credentials = { password: value };
          if (location === 'env')
            node.env = [
              { name: 'MODE', value: 'dev' },
              { name: 'PASSWORD', value },
            ];
          if (location === 'code') node.func = `const PASSWORD = "${value}";\nreturn msg;`;
          if (location === 'tab env') tab.env = [{ name: 'PASSWORD', value }];
        };
        setSecret(b, 'OLDPW');
        const p = clone(b),
          c = clone(b);
        if (location === 'tab env') {
          p.label = 'proposed';
          c.label = 'live';
        } else {
          p.nodes![0]!.name = 'proposed';
          c.nodes![0]!.name = 'live';
        }
        if (intentional) setSecret(p, 'PROPOSALPW');
        setSecret(c, 'NEWPW');
        if (location === 'env') (c.nodes![0]!.env as unknown[]).reverse();
        const nodeId = location === 'tab env' ? 'tab' : 'a';
        expectConflict(
          rebase(p, c, { base: b }),
          location === 'tab env' ? 'tab_changed_both' : 'node_changed_both',
          nodeId
        );
        const before = clone({ b, p, c });
        const next = applyConflictChoice({
          flowId: 'tab',
          base: b,
          proposed: p,
          liveFlows: flat(c),
          nodeId,
          choice: 'proposed',
        });
        const result = rebase(next.proposed as FlowTab, c, { base: next.base });
        expect(result.state).not.toBe('conflict');
        expect(JSON.stringify(result.merged)).toContain(intentional ? 'PROPOSALPW' : 'NEWPW');
        expect(JSON.stringify(result.merged)).not.toContain('OLDPW');
        expect({ b, p, c }).toEqual(before);
      }
    }
  );
  it('preserves each live rotated span while keeping edits on other function lines', () => {
    const b = clone(base);
    b.nodes![0]!.func =
      "// see [REDACTED] docs\nconst password = 'OLDPW'; const token = 'OLDTOKEN';\nreturn msg;";
    const p = clone(b),
      c = clone(b);
    p.nodes![0]!.func = (p.nodes![0]!.func as string).replace('return msg;', 'return null;');
    c.nodes![0]!.func = (c.nodes![0]!.func as string)
      .replace('OLDPW', 'NEWPW')
      .replace('OLDTOKEN', 'NEWTOKEN');
    const next = applyConflictChoice({
      flowId: 'tab',
      base: b,
      proposed: p,
      liveFlows: flat(c),
      nodeId: 'a',
      choice: 'proposed',
    });
    expect(next.proposed.nodes!.find(n => n.id === 'a')!.func).toBe(
      "// see [REDACTED] docs\nconst password = 'NEWPW'; const token = 'NEWTOKEN';\nreturn null;"
    );
    expect(next.warnings).toEqual([]);
  });

  it('keeps an intentionally edited secret while preserving other live rotated spans', () => {
    const b = clone(base);
    b.nodes![0]!.func = "const password = 'OLDPW';\nconst token = 'OLDTOKEN';\nreturn msg;";
    const p = clone(b),
      c = clone(b);
    p.nodes![0]!.func = (p.nodes![0]!.func as string)
      .replace('OLDPW', 'PROPOSEDPW')
      .replace('return msg;', 'return null;');
    c.nodes![0]!.func = (c.nodes![0]!.func as string)
      .replace('OLDPW', 'NEWPW')
      .replace('OLDTOKEN', 'NEWTOKEN');
    const next = applyConflictChoice({
      flowId: 'tab',
      base: b,
      proposed: p,
      liveFlows: flat(c),
      nodeId: 'a',
      choice: 'proposed',
    });
    expect(next.proposed.nodes!.find(n => n.id === 'a')!.func).toBe(
      "const password = 'PROPOSEDPW';\nconst token = 'NEWTOKEN';\nreturn null;"
    );
    expect(next.warnings).toEqual([]);
  });

  it.each(['none', 'distinct value', 'same value'])(
    'does not warn when a proposed secret line was deleted (retained secret: %s)',
    retained => {
      const retainOther = retained !== 'none';
      const oldToken = retained === 'same value' ? 'OLDPW' : 'OLDTOKEN';
      const b = clone(base);
      b.nodes![0]!.func = `const password = 'OLDPW';\nconst token = '${oldToken}';\nreturn msg;`;
      const p = clone(b),
        c = clone(b);
      p.nodes![0]!.func = retainOther
        ? `const token = '${oldToken}';\nreturn null;`
        : 'return null;';
      c.nodes![0]!.func = "const password = 'NEWPW';\nconst token = 'NEWTOKEN';\nreturn msg;";
      const next = applyConflictChoice({
        flowId: 'tab',
        base: b,
        proposed: p,
        liveFlows: flat(c),
        nodeId: 'a',
        choice: 'proposed',
      });
      expect(next.warnings).toEqual([]);
      expect(next.proposed.nodes!.find(n => n.id === 'a')!.func).toBe(
        retainOther ? "const token = 'NEWTOKEN';\nreturn null;" : 'return null;'
      );
    }
  );

  it.each(['tab', 'a'])(
    'warns when duplicate env keys are reordered on %s during conflict resolution',
    nodeId => {
      const b = clone(base);
      const entity = nodeId === 'tab' ? b : b.nodes![0]!;
      entity.env = [
        { name: 'PASSWORD', value: 'FIRST' },
        { name: 'PASSWORD', value: 'SECOND' },
      ];
      const p = clone(b),
        c = clone(b);
      const proposedEntity = nodeId === 'tab' ? p : p.nodes![0]!;
      (proposedEntity.env as unknown[]).reverse();
      const next = applyConflictChoice({
        flowId: 'tab',
        base: b,
        proposed: p,
        liveFlows: flat(c),
        nodeId,
        choice: 'proposed',
      });
      expect(next.warnings).toContainEqual(
        expect.objectContaining({
          code: 'duplicate_env_keys',
          nodeId,
          property: 'env',
          error: expect.stringContaining('ambiguous'),
        })
      );
      expect(JSON.stringify(next.warnings)).not.toMatch(/FIRST|SECOND/);
    }
  );

  it.each(['changed context', 'duplicate context', 'missing live secret'])(
    'keeps proposed values with a warning when secret spans cannot align: %s',
    mode => {
      const b = clone(base);
      b.nodes![0]!.func = "const password = 'OLDPW';\nreturn msg;";
      const p = clone(b),
        c = clone(b);
      p.nodes![0]!.func =
        mode === 'changed context'
          ? "let password = 'OLDPW';\nreturn null;"
          : mode === 'duplicate context'
            ? "const password = 'OLDPW';\nconst password = 'OTHERPW';\nreturn null;"
            : "const password = 'OLDPW';\nreturn null;";
      c.nodes![0]!.func =
        mode === 'missing live secret' ? 'return msg;' : "const password = 'NEWPW';\nreturn msg;";
      const next = applyConflictChoice({
        flowId: 'tab',
        base: b,
        proposed: p,
        liveFlows: flat(c),
        nodeId: 'a',
        choice: 'proposed',
      });
      expect(next.proposed.nodes!.find(n => n.id === 'a')!.func).toBe(p.nodes![0]!.func);
      expect(next.warnings).toEqual([
        expect.objectContaining({ code: 'secret_may_revert', nodeId: 'a', property: 'func' }),
      ]);
      expect(JSON.stringify(next.warnings)).not.toMatch(/OLDPW|NEWPW|OTHERPW/);
    }
  );

  it('raises a conflict when a duplicate secret line is deleted and live changed both passwords', () => {
    const b = clone(base);
    b.nodes![0]!.func = "const password = 'OLDPW';\nconst password = 'OLDPW';\nreturn msg;";
    const p = clone(b),
      c = clone(b);
    p.nodes![0]!.func = "const password = 'OLDPW';\nreturn null;";
    c.nodes![0]!.func = "const password = 'FIRSTNEW';\nconst password = 'SECONDNEW';\nreturn msg;";
    expectConflict(rebase(p, c, { base: b }), 'node_changed_both');
    expect(() =>
      applyConflictChoice({
        flowId: 'tab',
        base: b,
        proposed: p,
        liveFlows: flat(c),
        nodeId: 'a',
        choice: 'proposed',
      })
    ).toThrow('A duplicate secret line was removed');
  });

  it.each(['env', 'headers'])(
    'matches literal placeholder entries by name/key across reordered %s',
    field => {
      const b = clone(base);
      b.nodes![0]![field] =
        field === 'env'
          ? [
              { name: 'MODE', value: 'dev' },
              { name: 'PASSWORD', value: '[REDACTED]' },
            ]
          : [
              { key: 'Accept', value: 'json' },
              { key: 'Authorization', value: '[REDACTED]' },
            ];
      const p = clone(b);
      (p.nodes![0]![field] as unknown[]).reverse();
      expect(rebase(p, b, { base: b }).state).toBe('clean');
      (p.nodes![0]![field] as Record<string, unknown>[])[0]![field === 'env' ? 'name' : 'key'] =
        'renamed';
      expectConflict(rebase(p, b, { base: b }), 'redacted_placeholder');
    }
  );

  it('rejects a new literal placeholder occurrence even when the field already has one', () => {
    const b = clone(base);
    b.nodes![0]!.func = '// [REDACTED] docs\nreturn msg;';
    const p = clone(b);
    p.nodes![0]!.func = (p.nodes![0]!.func as string) + '\n// [REDACTED] docs';
    expectConflict(rebase(p, b, { base: b }), 'redacted_placeholder');
  });

  it.each(['content', 'position'])(
    'handles an editor secret rotation alongside a proposal %s edit',
    mode => {
      const b = secretBase(),
        p = clone(b),
        c = clone(b);
      c.nodes![0]!.func = 'const API_KEY = "new-live-secret";\nreturn msg;';
      if (mode === 'position') p.nodes![0]!.x = 999;
      else p.nodes![0]!.func = (p.nodes![0]!.func as string) + '\n// proposed';
      if (mode === 'content') expectConflict(rebase(p, c, { base: b }), 'node_changed_both');
      else
        expect(rebase(p, c, { base: b }).merged!.nodes![0]).toMatchObject({
          x: 999,
          func: c.nodes![0]!.func,
        });
    }
  );
  it('keeps the live secret on an untouched node after restoring the base placeholder', () => {
    const b = secretBase(),
      c = clone(b);
    const ai = redactFlowData(b).value;
    expect(ai.nodes![0]!.func).toContain('[REDACTED]');
    ai.nodes![1]!.name = 'proposal';
    const restored = restoreRedactedPlaceholders(ai, flat(b));
    expect(restored.unresolved).toEqual([]);
    expect(restored.restoredFields).toContainEqual({ nodeId: 'a', property: 'func' });
    c.nodes![0]!.func = 'const API_KEY = "new-live-secret";\nreturn msg;';
    const result = rebase(restored.flow as unknown as FlowTab, c, { base: b });
    expect(result.state).toBe('merged');
    expect(result.merged!.nodes![0]!.func).toBe(c.nodes![0]!.func);
    expect(JSON.stringify(result.merged)).not.toContain('[REDACTED]');
    expect(JSON.stringify(result.merged)).not.toContain('base-secret');
  });
  it('allows a position edit alongside live code edits when its secret stayed unchanged', () => {
    const b = secretBase(),
      p = clone(b),
      c = clone(b);
    p.nodes![0]!.x = 999;
    c.nodes![0]!.func = (c.nodes![0]!.func as string) + '\n// editor';
    expect(rebase(p, c, { base: b }).state).toBe('merged');
  });
  it('merges a proposal position edit with reordered live env entries when secret values are unchanged', () => {
    const b = secretBase();
    b.nodes![0]!.env = [
      { name: 'API_KEY', value: 'same-key' },
      { name: 'PASSWORD', value: 'same-password' },
    ];
    const p = clone(b),
      c = clone(b);
    p.nodes![0]!.x = 500;
    (c.nodes![0]!.env as unknown[]).reverse();
    const result = rebase(p, c, { base: b });
    expect(result.state).toBe('merged');
    expect(result.merged!.nodes![0]!.env).toEqual(c.nodes![0]!.env);
  });
  it('keeps live tab env secrets when the proposal only edits nodes', () => {
    const b = clone(base);
    b.env = [{ name: 'API_KEY', value: 'old' }];
    const p = clone(b),
      c = clone(b);
    p.nodes![0]!.func = 'proposal';
    c.env![0] = { name: 'API_KEY', value: 'live' };
    expect(rebase(p, c, { base: b }).merged!.env).toEqual(c.env);
  });
});

describe('revision snapshots', () => {
  it('retains bounded immutable revisions and preserves the first snapshot for a revision', () => {
    const history = new RevHistory(2),
      snapshot = { rev: 'r1', flows: flat(base) };
    history.record(snapshot);
    snapshot.flows.length = 0;
    history.record(snapshot);
    expect(history.get('r1')!.flows.length).toBeGreaterThan(0);
    history.get('r1')!.flows.length = 0;
    expect(history.get('r1')!.flows.length).toBeGreaterThan(0);
    history.record({ rev: 'r2', flows: [] });
    history.record({ rev: 'r3', flows: [] });
    expect(history.has('r1')).toBe(false);
  });
  it('records reads once and serves a read-only snapshot', async () => {
    const adapter = withRevHistory(snapshotAdapter({ rev: 'r1', flows: flat(base) }, 'red'));
    expect(withRevHistory(adapter)).toBe(adapter);
    await adapter.getFlow('tab');
    const snapshot = await adapter.getFlows();
    snapshot.flows.length = 0;
    expect((await adapter.getFlows()).flows.length).toBeGreaterThan(0);
    await expect(
      adapter.updateFlow({ flowId: 'tab', flow: base, expectedRev: 'r1' })
    ).rejects.toThrow('read-only');
  });
});
