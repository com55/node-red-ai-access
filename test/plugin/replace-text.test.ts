import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessLinkStore } from '../../src/access/index.js';
import { AiOpsValidationError } from '../../src/plugin/ai-ops.js';
import {
  applyReplaceTextToValue,
  findTextOccurrences,
  interpretPatch,
} from '../../src/plugin/get-link/flow-patch.js';
import { registerRoutes } from '../../src/plugin/index.js';
import type { NodeRedPluginAPI } from '../../src/plugin/types.js';
import type { FlowAdapter, FlowTab } from '../../src/runtime/types.js';

describe('applyReplaceTextToValue', () => {
  it('replaces a unique find', () => {
    expect(applyReplaceTextToValue('Hello world', 'template', 'Hello', 'Hi')).toBe('Hi world');
  });

  it('throws text_not_found when missing', () => {
    try {
      applyReplaceTextToValue('abc', 'func', 'zzz', 'x');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AiOpsValidationError);
      expect((e as AiOpsValidationError).code).toBe('text_not_found');
      expect((e as AiOpsValidationError).statusCode).toBe(400);
      expect((e as AiOpsValidationError).details).toMatchObject({ matchCount: 0 });
    }
  });

  it('throws ambiguous_match with matchCount when find is not unique', () => {
    try {
      applyReplaceTextToValue('aa-aa-aa', 'func', 'aa', 'bb');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AiOpsValidationError);
      expect((e as AiOpsValidationError).code).toBe('ambiguous_match');
      expect((e as AiOpsValidationError).statusCode).toBe(409);
      expect((e as AiOpsValidationError).details).toMatchObject({ matchCount: 3 });
    }
  });

  it('picks a 1-based occurrence', () => {
    expect(applyReplaceTextToValue('aa-aa-aa', 'func', 'aa', 'X', 2)).toBe('aa-X-aa');
  });

  it('throws field_not_found when the field value is missing', () => {
    try {
      applyReplaceTextToValue(undefined, 'template', 'a', 'b');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AiOpsValidationError);
      expect((e as AiOpsValidationError).code).toBe('field_not_found');
    }
  });

  it('throws field_not_string when the field exists but is not a string', () => {
    try {
      applyReplaceTextToValue(42, 'count', 'a', 'b');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AiOpsValidationError);
      expect((e as AiOpsValidationError).code).toBe('field_not_string');
    }
  });

  it('applies multiple non-overlapping finds via findTextOccurrences', () => {
    expect(findTextOccurrences('ababab', 'ab')).toEqual([0, 2, 4]);
  });
});

describe('interpretPatch replace_text', () => {
  it('parses replace_text ops with node alias and occurrence', () => {
    const interpreted = interpretPatch(
      {
        nodes: [
          {
            op: 'replace_text',
            node: 'n1',
            field: 'template',
            find: 'a',
            replace: 'b',
            occurrence: 1,
          },
        ],
      },
      'tab1'
    );
    expect(interpreted.kind).toBe('nodes');
    if (interpreted.kind !== 'nodes') return;
    expect(interpreted.ops[0]).toEqual({
      op: 'replace_text',
      nodeId: 'n1',
      field: 'template',
      find: 'a',
      replace: 'b',
      occurrence: 1,
    });
  });
});

function createApp(userDir: string): { app: Express; linkStore: AccessLinkStore; flow: FlowTab } {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const linkStore = new AccessLinkStore({ maxActiveLinks: 10, defaultTtlSeconds: 14_400 });
  const flow: FlowTab = {
    id: 'tab-1',
    type: 'tab',
    label: 'Main',
    nodes: [
      {
        id: 'n1',
        type: 'template',
        z: 'tab-1',
        name: 'Tpl',
        template: '<p>Hello</p><p>Hello</p><p>Bye</p>',
      },
      {
        id: 'n2',
        type: 'function',
        z: 'tab-1',
        name: 'Fn',
        func: 'return msg;\n// TODO\n// TODO\n',
      },
    ],
  };
  let rev = 'rev-1';
  const adapter = {
    kind: 'red',
    getFlows: () => Promise.resolve({ rev, flows: [{ id: 'tab-1', type: 'tab', label: 'Main' }] }),
    getFlow: (id: string) =>
      Promise.resolve({
        rev,
        flow: { ...flow, id, nodes: flow.nodes?.map(n => ({ ...n })) },
      }),
    updateFlow: () => {
      rev = 'rev-2';
      return Promise.resolve({ rev });
    },
  } as FlowAdapter;

  const RED: NodeRedPluginAPI = {
    settings: {
      userDir,
      httpAdminRoot: '/',
      adminAuth: { type: 'credentials' },
      aiAccess: { defaultDeploymentType: 'nodes', defaultLinkTtlSeconds: 14_400 },
    },
    httpAdmin: app,
    auth: {
      needsPermission() {
        return (_req: Request, _res: Response, next: NextFunction) => next();
      },
    },
    plugins: {
      registerPlugin() {
        return undefined;
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  registerRoutes(RED, { linkStore, flowAdapter: adapter });
  return { app, linkStore, flow };
}

describe('GET propose replace_text + REST nodes', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'ai-access-replace-text-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('GET propose replace_text creates a proposal with a short field diff', async () => {
    const { app, linkStore } = createApp(userDir);
    const created = linkStore.create({ label: 'rt' });
    const res = await request(app).get(
      `/mcp/a/${created.token}/propose?flow=tab-1&rev=rev-1&node=n1&field=template&find=${encodeURIComponent('<p>Bye</p>')}&replace=${encodeURIComponent('<p>OK</p>')}&title=Tweak&include=payload`
    );
    expect(res.status).toBe(201);
    expect(res.body.proposal?.id).toBeTruthy();
    expect(res.body.proposal?.payload).toBeTruthy();
    expect(res.body.proposal?.changeSummary).toMatch(/edit/i);
    const diff = await request(app).get(
      `/mcp/a/${created.token}/proposals/${res.body.proposal.id}/diff`
    );
    expect(diff.status).toBe(200);
    const change = diff.body.modified?.[0]?.changes?.find(
      (c: { key?: string }) => c.key === 'template'
    );
    expect(change?.kind).toBe('text');
    expect(JSON.stringify(change)).toMatch(/Bye|OK/);
  });

  it('GET propose replace_text on unknown field returns field_not_found', async () => {
    const { app, linkStore } = createApp(userDir);
    const created = linkStore.create({ label: 'rt-missing' });
    const res = await request(app).get(
      `/mcp/a/${created.token}/propose?flow=tab-1&rev=rev-1&node=n1&field=noSuchField&find=a&replace=b`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('field_not_found');
    expect(String(res.body.hint ?? '')).toMatch(/field/i);
  });

  it('GET propose rejects replace_text combined with set props', async () => {
    const { app, linkStore } = createApp(userDir);
    const created = linkStore.create({ label: 'rt-conflict' });
    const res = await request(app).get(
      `/mcp/a/${created.token}/propose?flow=tab-1&rev=rev-1&node=n1&field=template&find=Hello&replace=Hi&set.name=Nope`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('conflicting_edits');
    expect(String(res.body.hint ?? '')).toMatch(/set/i);
  });

  it('GET propose returns 409 ambiguous_match with matchCount', async () => {
    const { app, linkStore } = createApp(userDir);
    const created = linkStore.create({ label: 'rt' });
    const res = await request(app).get(
      `/mcp/a/${created.token}/propose?flow=tab-1&rev=rev-1&node=n1&field=template&find=Hello&replace=Hi`
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ambiguous_match', matchCount: 2 });
  });

  it('GET propose returns 400 text_not_found', async () => {
    const { app, linkStore } = createApp(userDir);
    const created = linkStore.create({ label: 'rt' });
    const res = await request(app).get(
      `/mcp/a/${created.token}/propose?flow=tab-1&rev=rev-1&node=n1&field=template&find=Nope&replace=X`
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('text_not_found');
  });

  it('GET propose occurrence picks the second match', async () => {
    const { app, linkStore } = createApp(userDir);
    const created = linkStore.create({ label: 'rt' });
    const res = await request(app).get(
      `/mcp/a/${created.token}/propose?flow=tab-1&rev=rev-1&node=n1&field=template&find=Hello&replace=Hi&occurrence=2&include=payload`
    );
    expect(res.status).toBe(201);
    const flow = res.body.proposal?.payload?.flow;
    const node = flow?.nodes?.find((n: { id: string }) => n.id === 'n1');
    expect(node?.template).toBe('<p>Hello</p><p>Hi</p><p>Bye</p>');
  });

  it('REST submit_proposal accepts payload.nodes replace_text ops in order', async () => {
    const { app, linkStore } = createApp(userDir);
    const created = linkStore.create({ label: 'rt-rest' });
    const res = await request(app)
      .post('/mcp/api/v1/proposals?include=payload')
      .set('Authorization', `Bearer ${created.token}`)
      .send({
        type: 'replace_flow',
        expectedRev: 'rev-1',
        title: 'Two tweaks',
        payload: {
          flowId: 'tab-1',
          nodes: [
            {
              op: 'replace_text',
              node: 'n2',
              field: 'func',
              find: 'TODO',
              replace: 'one',
              occurrence: 1,
            },
            { op: 'replace_text', node: 'n2', field: 'func', find: 'TODO', replace: 'two' },
          ],
        },
      });
    expect(res.status).toBe(201);
    const node = res.body.payload?.flow?.nodes?.find((n: { id: string }) => n.id === 'n2');
    expect(node?.func).toBe('return msg;\n// one\n// two\n');
  });
});

describe('AI guide mentions replace_text and last-resort paste', () => {
  it('embeds guidance in get-link docs source', async () => {
    const { readFileSync } = await import('node:fs');
    const docs = readFileSync(join(process.cwd(), 'src/plugin/get-link/docs.ts'), 'utf8');
    expect(docs).toMatch(/replace_text/);
    expect(docs).toMatch(/ambiguous_match/);
    expect(docs).toMatch(/Last resort/);
    expect(docs).toMatch(/paste/);
    expect(docs).toMatch(/not.*reviewed through the proposal diff/i);
  });
});
