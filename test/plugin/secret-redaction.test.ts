import { describe, expect, it } from 'vitest';

import {
  aiRedactingAdapter,
  createSecretNameMatcher,
  MAX_SCAN_FIELD_CHARS,
  DEFAULT_SECRET_NAME_PATTERNS,
  normalizeSecretNamePatterns,
  rawFlowAdapter,
  redactFlowData,
  redactProposalForAi,
  REDACTED_PLACEHOLDER,
  restoreRedactedPlaceholders,
  scanTextForSecrets,
  secretChangeWarnings,
} from '../../src/plugin/secret-redaction.js';
import type { FlowAdapter, FlowNode, FlowTab } from '../../src/runtime/types.js';
import type { Proposal } from '../../src/storage/proposals.js';

const R = REDACTED_PLACEHOLDER;
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const matcher = createSecretNameMatcher(DEFAULT_SECRET_NAME_PATTERNS);

describe('secret name matching', () => {
  it.each([
    'OAUTH_POC_PASSWORD',
    'password',
    'DB_PASS',
    'dbPassword',
    'MYSQLPASSWORD',
    'passwd',
    'PWD',
    'client_secret',
    'clientSecret',
    'apiKey',
    'API_KEY',
    'APIKEY',
    'x-api-key',
    'PRIVATE_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN',
    'accessTokens',
    'AUTH',
    'Authorization',
    'SESSION_ID',
    'cookie',
    'CONNECTION_STRING',
    'connStr',
    'MONGO_DSN',
    'credentials',
    'bearer',
    'KEYS',
    'key2',
  ])('matches %s', name => {
    expect(matcher.matches(name)).toBe(true);
  });

  it.each([
    'KEYBOARD',
    'MONKEY',
    'TURKEY',
    'AUTHOR',
    'author_name',
    'OAUTH',
    'SECRETARY',
    'TOKENIZER',
    'PASSPORT',
    'COMPASS',
    'BYPASS',
    'TOKEN_URL',
    'AUTH_TYPE',
    'authType',
    'keyType',
    'SESSION_TIMEOUT',
    'PASSWORD_FIELD',
    'USERNAME',
    'HOST',
    'topic',
    'payload',
    '',
  ])('does not match %s', name => {
    expect(matcher.matches(name)).toBe(false);
  });

  it('normalizes patterns (trim, uppercase, dedupe, drop invalid)', () => {
    expect(normalizeSecretNamePatterns([' api_key ', 'API_KEY', 'pin', 'x', 'a b', 7])).toEqual([
      'API_KEY',
      'PIN',
    ]);
    expect(normalizeSecretNamePatterns('PASSWORD')).toBeUndefined();
  });

  it('custom pattern list replaces defaults; empty disables name matching', () => {
    const custom = createSecretNameMatcher(['PIN']);
    expect(custom.matches('DOOR_PIN')).toBe(true);
    expect(custom.matches('PASSWORD')).toBe(false);
    expect(createSecretNameMatcher([]).matches('PASSWORD')).toBe(false);
  });
});

describe('content scanning', () => {
  const cases: [string, string, string][] = [
    ['AWS key', 'const k = AKIAIOSFODNN7EXAMPLE;', 'const k = [REDACTED];'],
    ['GitHub PAT', `fetch(u, {h: "${GHP}"})`, `fetch(u, {h: "${R}"})`],
    ['github_pat_', 'x github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz y', `x ${R} y`],
    ['Slack', 'token xoxb-123456789012-abcdefghij end', `token ${R} end`],
    ['OpenAI', 'k=sk-proj-abcdefghijklmnopqrstuvwxyz012345', `k=${R}`],
    ['Google', 'AIzaSyA-1234567890abcdefghijklmnopqrstu', R],
    [
      'JWT',
      't eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U t',
      `t ${R} t`,
    ],
    [
      'Bearer header',
      'headers.Authorization = "Bearer abc123def456ghi789"',
      `headers.Authorization = "Bearer ${R}"`,
    ],
    [
      'URL creds',
      'mongodb://admin:s3cr3t@db.local:27017/x',
      `mongodb://admin:${R}@db.local:27017/x`,
    ],
    ['assignment', 'const password = "hunter22";', `const password = "${R}";`],
    ['object key', "{ apiKey: 'abc-123-xyz' }", `{ apiKey: '${R}' }`],
    ['JSON key', '{"client_secret":"zzz999"}', `{"client_secret":"${R}"}`],
    ['bracket key', "headers['x-api-key'] = 'k-123456'", `headers['x-api-key'] = '${R}'`],
  ];
  it.each(cases)('%s', (_label, input, expected) => {
    expect(scanTextForSecrets(input, matcher).text).toBe(expected);
  });

  it('PEM private key keeps BEGIN/END lines', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----';
    const out = scanTextForSecrets(`const k = \`${pem}\`;`, matcher).text;
    expect(out).toBe(
      `const k = \`-----BEGIN RSA PRIVATE KEY-----${R}-----END RSA PRIVATE KEY-----\`;`
    );
  });

  it.each([
    'const keyboard = "qwerty";',
    'msg.topic = "sensor/1";',
    'const author = "jane";',
    'node.status({text: "token expired"});',
    'const authType = "basic";',
    'const password = msg.password;',
    "const password = env.get('PASSWORD');",
    'const token = `${prefix}-x`;',
    'if (password === "") return;',
    'Bearer token authentication is used',
    'http://example.com/path',
    'https://user:${PASS}@host/',
    'Basic authentication',
  ])('no false positive: %s', input => {
    expect(scanTextForSecrets(input, matcher).secrets).toEqual([]);
  });
});

function tabWithSecrets(): FlowTab {
  return {
    id: 't1',
    type: 'tab',
    label: 'Main',
    env: [
      { name: 'API_TOKEN', value: 'tok-xyz-1', type: 'str' },
      { name: 'REGION', value: 'eu', type: 'str' },
      { name: 'DB_PASS', value: 'OTHER', type: 'env' },
      { name: 'CRED_ENV', type: 'cred' },
    ],
    nodes: [
      {
        id: 'g1',
        type: 'group',
        z: 't1',
        env: [{ name: 'OAUTH_POC_PASSWORD', value: 'plain-pw', type: 'str' }],
      },
      {
        id: 'f1',
        type: 'function',
        z: 't1',
        name: 'uses token',
        func: `const gh = "${GHP}";\nconst password = "hunter22";\nreturn msg;`,
        initialize: '// setup\nconst apiKey = "init-key-123";',
        finalize: '',
        wires: [[]],
      },
      {
        id: 'h1',
        type: 'http request',
        z: 't1',
        url: 'https://bob:pa55word@api.example.com/v1',
        authType: 'basic',
        headers: [
          { keyType: 'other', keyValue: 'X-Api-Key', valueType: 'other', valueValue: 'hdr-secret' },
          {
            keyType: 'other',
            keyValue: 'Accept',
            valueType: 'other',
            valueValue: 'application/json',
          },
        ],
        wires: [[]],
      },
      {
        id: 'c1',
        type: 'change',
        z: 't1',
        rules: [
          { t: 'set', p: 'password', pt: 'msg', to: 'chg-secret', tot: 'str' },
          { t: 'set', p: 'token', pt: 'msg', to: 'payload.t', tot: 'msg' },
          { t: 'set', p: 'topic', pt: 'msg', to: 'hello', tot: 'str' },
        ],
        wires: [[]],
      },
      {
        id: 's1',
        type: 'subflow:sf1',
        z: 't1',
        env: [{ name: 'SECRET', value: 'inst-secret', type: 'str' }],
        wires: [[]],
      },
      { id: 'k1', type: 'inject', z: 't1', name: 'KEYBOARD MONKEY', topic: 'MONKEY', wires: [[]] },
    ],
    configs: [{ id: 'b1', type: 'mqtt-broker', broker: 'localhost', password: 'not-a-cred-field' }],
  };
}

function find(tab: Partial<FlowTab>, id: string): Record<string, unknown> {
  const all = [...(tab.nodes ?? []), ...(tab.configs ?? [])] as Record<string, unknown>[];
  const n = all.find(x => x.id === id);
  if (!n) throw new Error(id);
  return n;
}

describe('redactFlowData on a tab', () => {
  const original = tabWithSecrets();
  const snapshot = JSON.stringify(original);
  const { value: red, count } = redactFlowData(original);

  it('does not mutate the input', () => {
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('redacts env entries by name and marks them', () => {
    expect(red.env?.[0]).toEqual({ name: 'API_TOKEN', value: R, type: 'str', redacted: true });
    expect(red.env?.[1]).toEqual({ name: 'REGION', value: 'eu', type: 'str' });
    // env-reference and cred entries are untouched
    expect(red.env?.[2]).toEqual({ name: 'DB_PASS', value: 'OTHER', type: 'env' });
    expect(red.env?.[3]).toEqual({ name: 'CRED_ENV', type: 'cred' });
    expect((red as Record<string, unknown>)._aiRedactions).toEqual(['env[0].value']);
  });

  it('redacts group and subflow instance env', () => {
    const g = find(red, 'g1');
    expect((g.env as Record<string, unknown>[])[0]).toMatchObject({ value: R, redacted: true });
    expect(g._aiRedactions).toEqual(['env[0].value']);
    expect((find(red, 's1').env as Record<string, unknown>[])[0]).toMatchObject({ value: R });
  });

  it('redacts only the literals inside function code', () => {
    const f = find(red, 'f1');
    expect(f.func).toBe(`const gh = "${R}";\nconst password = "${R}";\nreturn msg;`);
    expect(f.initialize).toBe(`// setup\nconst apiKey = "${R}";`);
    expect(f._aiRedactions).toEqual(['func', 'initialize']);
    expect(f.name).toBe('uses token');
  });

  it('redacts url passwords, header values and change rule literals', () => {
    const h = find(red, 'h1');
    expect(h.url).toBe(`https://bob:${R}@api.example.com/v1`);
    expect(h.authType).toBe('basic');
    const headers = h.headers as Record<string, unknown>[];
    expect(headers[0]?.valueValue).toBe(R);
    expect(headers[1]?.valueValue).toBe('application/json');
    expect(h._aiRedactions).toEqual(['url', 'headers[0].valueValue']);
    const rules = find(red, 'c1').rules as Record<string, unknown>[];
    expect(rules[0]?.to).toBe(R);
    expect(rules[1]?.to).toBe('payload.t');
    expect(rules[2]?.to).toBe('hello');
  });

  it('redacts secret-named config fields; leaves innocuous nodes alone', () => {
    expect(find(red, 'b1').password).toBe(R);
    expect(find(red, 'k1')).toEqual(find(original, 'k1'));
    expect(count).toBe(10);
  });

  it('is idempotent', () => {
    const again = redactFlowData(red);
    expect(again.value).toEqual(red);
    expect(again.count).toBe(0);
  });
});

describe('restoreRedactedPlaceholders', () => {
  const live = tabWithSecrets();
  const flat = [
    { id: 't1', type: 'tab', label: 'Main', env: live.env },
    ...(live.nodes ?? []),
    ...(live.configs ?? []),
  ] as FlowNode[];
  const red = redactFlowData(live).value;

  it('unchanged redacted tab round-trips to the original exactly', () => {
    const result = restoreRedactedPlaceholders(structuredClone(red), flat);
    expect(result.flow).toEqual(live);
    expect(result.unresolved).toEqual([]);
    expect(result.restored).toBe(10);
  });

  it('keeps secrets when the AI edits function code around placeholders', () => {
    const ai = structuredClone(red);
    const f = find(ai, 'f1');
    f.func = `// edited by AI\nconst gh = "${R}";\nconst password = "${R}";\nmsg.payload = 1;\nreturn msg;`;
    const result = restoreRedactedPlaceholders(ai, flat);
    expect(find(result.flow, 'f1').func).toBe(
      `// edited by AI\nconst gh = "${GHP}";\nconst password = "hunter22";\nmsg.payload = 1;\nreturn msg;`
    );
    expect(find(result.flow, 'f1')._aiRedactions).toBeUndefined();
    expect(result.unresolved).toEqual([]);
  });

  it('keeps secrets when placeholders are reordered', () => {
    const ai = structuredClone(red);
    find(ai, 'f1').func = `const password = "${R}";\nconst gh = "${R}";\nreturn msg;`;
    const out = find(restoreRedactedPlaceholders(ai, flat).flow, 'f1').func;
    expect(out).toBe(`const password = "hunter22";\nconst gh = "${GHP}";\nreturn msg;`);
  });

  it('an AI-supplied new value replaces the secret', () => {
    const ai = structuredClone(red);
    (ai.env as Record<string, unknown>[])[0] = { name: 'API_TOKEN', value: 'new-one', type: 'str' };
    const result = restoreRedactedPlaceholders(ai, flat);
    expect(result.flow.env?.[0]).toEqual({ name: 'API_TOKEN', value: 'new-one', type: 'str' });
  });

  it('matches env entries by name when the AI reorders them', () => {
    const ai = structuredClone(red);
    ai.env = [...(ai.env ?? [])].reverse();
    const env = restoreRedactedPlaceholders(ai, flat).flow.env as Record<string, unknown>[];
    expect(env.find(e => e.name === 'API_TOKEN')).toEqual({
      name: 'API_TOKEN',
      value: 'tok-xyz-1',
      type: 'str',
    });
  });

  it('flags placeholders with no original (new node) and strips markers', () => {
    const ai = structuredClone(red);
    ai.nodes = [
      ...(ai.nodes ?? []),
      {
        id: 'new1',
        type: 'function',
        z: 't1',
        func: `const password = "${R}";`,
        _aiRedactions: ['func'],
      },
    ];
    const result = restoreRedactedPlaceholders(ai, flat);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ nodeId: 'new1', property: 'func' }),
    ]);
    expect(find(result.flow, 'new1')._aiRedactions).toBeUndefined();
  });

  it('restores a node copied from another tab by id lookup in flat flows', () => {
    const ai: Partial<FlowTab> = {
      id: 't2',
      nodes: [{ ...find(red, 'f1'), z: 't2' } as FlowNode],
    };
    const out = find(restoreRedactedPlaceholders(ai, flat).flow, 'f1');
    expect(String(out.func)).toContain(GHP);
  });
});

describe('aiRedactingAdapter', () => {
  const inner: FlowAdapter = {
    kind: 'red',
    getFlows: async () => ({
      rev: 'r1',
      flows: [{ id: 't1', type: 'tab', env: [{ name: 'PASSWORD', value: 'x1', type: 'str' }] }],
    }),
    getFlow: async () => ({ rev: 'r1', flow: tabWithSecrets() }),
    updateFlow: async p => ({ flowId: p.flowId, rev: 'r2' }),
  };

  it('redacts reads and unwraps to the raw adapter', async () => {
    const view = aiRedactingAdapter(inner);
    const flows = await view.getFlows();
    expect(JSON.stringify(flows)).not.toContain('x1');
    const tab = await view.getFlow('t1');
    expect(JSON.stringify(tab)).not.toContain(GHP);
    expect(rawFlowAdapter(view)).toBe(inner);
    expect(rawFlowAdapter(inner)).toBe(inner);
    expect(aiRedactingAdapter(view)).toBe(view);
  });

  it('redactProposalForAi covers payload and baseFlow', () => {
    const proposal = {
      id: 'prop-1',
      payload: { flowId: 't1', flow: tabWithSecrets() },
      baseFlow: tabWithSecrets(),
    } as unknown as Proposal;
    const red = redactProposalForAi(proposal);
    expect(JSON.stringify(red)).not.toContain('hunter22');
    expect(JSON.stringify(proposal)).toContain('hunter22');
  });
});

describe('strict restore — exploit cases', () => {
  const TOK = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const live: FlowNode[] = [
    { id: 't9', type: 'tab', label: 'x' },
    {
      id: 'h1',
      type: 'http request',
      z: 't9',
      method: 'GET',
      url: 'https://api.good.example/v1',
      headers: [
        {
          keyType: 'other',
          keyValue: 'Authorization',
          valueType: 'other',
          valueValue: `Bearer ${TOK}`,
        },
        {
          keyType: 'other',
          keyValue: 'Accept',
          valueType: 'other',
          valueValue: 'application/json',
        },
      ],
      wires: [],
    },
    {
      id: 'g1',
      type: 'group',
      z: 't9',
      env: [
        { name: 'DB_PASSWORD', value: 'hunter2-real', type: 'str' },
        { name: 'API_TOKEN', value: 'tok-real-value', type: 'str' },
      ],
    },
  ];
  const tab = (): Partial<FlowTab> => {
    const red = redactFlowData(
      { id: 't9', type: 'tab', label: 'x', nodes: structuredClone(live.slice(1)) },
      DEFAULT_SECRET_NAME_PATTERNS
    ).value as Partial<FlowTab>;
    return structuredClone(red);
  };
  const node = (f: Partial<FlowTab>, id: string) =>
    (f.nodes ?? []).find(n => n.id === id) as unknown as Record<string, unknown>;

  it('unchanged round trip restores exactly', () => {
    const r = restoreRedactedPlaceholders(tab(), live);
    expect(r.unresolved).toEqual([]);
    expect(JSON.stringify(r.flow)).toContain(TOK);
    expect(JSON.stringify(r.flow)).toContain('hunter2-real');
    expect(r.restoredFields.map(f => f.nodeId).sort()).toEqual(['g1', 'g1', 'h1']);
  });

  it('header swap (X-Leak takes the Bearer value) is not restored', () => {
    const f = tab();
    const h = node(f, 'h1').headers as Record<string, unknown>[];
    h[0]!.keyValue = 'X-Leak';
    const r = restoreRedactedPlaceholders(f, live);
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.flow)).not.toContain(TOK);
  });

  it('header reorder still restores by key, not index', () => {
    const f = tab();
    const n = node(f, 'h1');
    n.headers = [...(n.headers as unknown[])].reverse();
    const r = restoreRedactedPlaceholders(f, live);
    expect(r.unresolved).toEqual([]);
    const hs = (r.flow.nodes ?? []).find(x => x.id === 'h1') as unknown as {
      headers: Record<string, string>[];
    };
    expect(hs.headers[1]!.valueValue).toBe(`Bearer ${TOK}`);
  });

  it('host change restores but raises secret_destination_changed', () => {
    const f = tab();
    node(f, 'h1').url = 'https://evil.example/c';
    const r = restoreRedactedPlaceholders(f, live);
    expect(r.unresolved).toEqual([]);
    const w = secretChangeWarnings(r.restoredFields, r.flow, live);
    expect(w).toEqual([
      expect.objectContaining({ code: 'secret_destination_changed', nodeId: 'h1' }),
    ]);
  });

  it('env swap of names does not cross values; rename is unresolved', () => {
    const f = tab();
    const env = node(f, 'g1').env as { name: string }[];
    env[0]!.name = 'LEAK_TO_URL';
    const r = restoreRedactedPlaceholders(f, live);
    expect(r.unresolved).toEqual([expect.objectContaining({ nodeId: 'g1' })]);
    expect(JSON.stringify(r.flow)).not.toContain('hunter2-real');
  });

  it('duplicate placeholder in a field is rejected', () => {
    const f = tab();
    const h = node(f, 'h1').headers as Record<string, unknown>[];
    h[0]!.valueValue = `${String(h[0]!.valueValue)} ${R}`;
    const r = restoreRedactedPlaceholders(f, live);
    expect(r.unresolved.length).toBe(1);
    expect(JSON.stringify(r.flow)).not.toContain(TOK);
  });

  it('placeholder moved to a different line is rejected', () => {
    const fnLive: FlowNode[] = [
      {
        id: 'f9',
        type: 'function',
        z: 't9',
        func: `const token = "${TOK}";\nreturn msg;`,
      },
    ];
    const red = redactFlowData(
      { id: 't9', nodes: structuredClone(fnLive) },
      DEFAULT_SECRET_NAME_PATTERNS
    ).value as Partial<FlowTab>;
    const n = (red.nodes ?? [])[0] as unknown as Record<string, string>;
    n.func = `const token = "x";\nsend("${R}");\nreturn msg;`;
    const r = restoreRedactedPlaceholders(red, fnLive);
    expect(r.unresolved.length).toBe(1);
    expect(JSON.stringify(r.flow)).not.toContain(TOK);
  });
});

describe('S1/S2 detection', () => {
  const m = createSecretNameMatcher(DEFAULT_SECRET_NAME_PATTERNS);
  it('redacts a token in a node name / info (value scan only)', () => {
    const tok = 'ghp_' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8';
    const out = redactFlowData(
      {
        id: 't',
        type: 'tab',
        nodes: [{ id: 'n', type: 'debug', name: `key ${tok}`, info: `use ${tok}` }],
      },
      DEFAULT_SECRET_NAME_PATTERNS
    );
    expect(JSON.stringify(out.value)).not.toContain(tok);
    const plain = redactFlowData(
      { id: 't', type: 'tab', nodes: [{ id: 'n', type: 'debug', name: 'password reset' }] },
      DEFAULT_SECRET_NAME_PATTERNS
    );
    expect(JSON.stringify(plain.value)).toContain('password reset');
  });
  it('catches DSN Password=...; , unquoted password: x, PW=, Buffer.from basic auth', () => {
    expect(scanTextForSecrets('Server=db;User Id=sa;Password=S3cretDsn!;', m).secrets).toContain(
      'S3cretDsn!'
    );
    expect(scanTextForSecrets('password: s3cr3tUnq', m).secrets).toContain('s3cr3tUnq');
    expect(scanTextForSecrets('PW=zz9pwvalue', m).secrets).toContain('zz9pwvalue');
    const b = scanTextForSecrets(
      'const h = Buffer.from("admin:hunter2pw").toString("base64");',
      m,
      { code: true }
    );
    expect(b.text).not.toContain('hunter2pw');
  });
  it('large input: oversized field is fully redacted fast', () => {
    const big = 'a=b '.repeat(MAX_SCAN_FIELD_CHARS / 3);
    const t0 = Date.now();
    const out = redactFlowData(
      { id: 't', type: 'tab', nodes: [{ id: 'n', type: 'function', func: big }] },
      DEFAULT_SECRET_NAME_PATTERNS
    ).value as { nodes: { func: string }[] };
    expect(out.nodes[0]!.func).toBe(R);
    const near = `${'x'.repeat(MAX_SCAN_FIELD_CHARS - 10)}`;
    scanTextForSecrets(near, m);
    scanTextForSecrets('password = "'.repeat(20000), m);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('round 2 — ReDoS timing (256 KB adversarial, per rule)', () => {
  const m = createSecretNameMatcher(DEFAULT_SECRET_NAME_PATTERNS);
  const N = 256 * 1024;
  const fill = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const cases: Record<string, string> = {
    'conn no ;': `Password=${'x'.repeat(N)}`,
    'conn many starts': fill(' a='),
    'conn many pairs': fill('a=b;'),
    'buffer.from': `Buffer.from("${'a'.repeat(N)}`,
    'buffer.from many': fill('Buffer.from("a:'),
    pem: fill('-----BEGIN PRIVATE KEY-----'),
    'pem words': `-----BEGIN ${fill('A ')}`,
    aws: fill('AKIA'),
    github: `ghp_${'a'.repeat(N)}`,
    slack: `xoxb-${'a'.repeat(N)}`,
    'slack hook': `hooks.slack.com/services/${'a'.repeat(N)}`,
    openai: `sk-${'a'.repeat(N)}`,
    jwt: fill('eyJaaaaa.'),
    'jwt long': `eyJ${'a'.repeat(N)}`,
    bearer: `Bearer ${'a'.repeat(N)}`,
    'bearer =': `Bearer aaaaaaaaaaaaaaaa1${'='.repeat(N)}`,
    basic: `Basic ${'a'.repeat(N)}`,
    'url creds': fill('ab://a:'),
    'url creds long': `ab://${'a'.repeat(N)}`,
    'url query': fill('?key='),
    'url query amp': fill('&token=a'),
    assign: fill('password = "'),
    'assign long': `password = "${'a'.repeat(N)}`,
    'assign json': fill('"password":'),
    unquoted: fill('password: '),
    'unquoted colons': fill('a:'),
    spaces: ' '.repeat(N),
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`${name} < 200ms`, () => {
      for (const code of [false, true]) {
        const t0 = performance.now();
        scanTextForSecrets(text, m, { code });
        expect(performance.now() - t0).toBeLessThan(200);
      }
    });
  }
});

describe('round 2 — detection', () => {
  const m = createSecretNameMatcher(DEFAULT_SECRET_NAME_PATTERNS);
  it('redacts secret-named URL query params, keeps others', () => {
    const r = scanTextForSecrets('https://api.example/?key=abc123&x=1&access_token=Zz9-tok', m);
    expect(r.secrets).toEqual(['abc123', 'Zz9-tok']);
    expect(r.text).toContain('&x=1');
    const c = scanTextForSecrets('fetch("https://api.example/v1?key=abc123")', m, { code: true });
    expect(c.text).not.toContain('abc123');
  });
  it('unquoted rule does not swallow https: (query rule still sees ?key=)', () => {
    const r = scanTextForSecrets('url: https://h.example/x?token=t0k3nvalue', m);
    expect(r.secrets).toEqual(['t0k3nvalue']);
  });
  it('prose like "Session: started" / "key: value" is not redacted', () => {
    expect(scanTextForSecrets('Session: started\nkey: value\nauth: required', m).secrets).toEqual(
      []
    );
    expect(scanTextForSecrets('password: hunter2', m).secrets).toEqual(['hunter2']);
  });
});

describe('round 2 — restore + warnings', () => {
  const TOK = 'ghp_' + 'B1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R7s8';
  const live = (): Record<string, unknown>[] => [
    {
      id: 't8',
      type: 'tab',
      label: 'x',
      env: [{ name: 'API_HOST', value: 'good.example', type: 'str' }],
    },
    { id: 'g8', type: 'group', z: 't8', nodes: ['h8'], env: [] },
    {
      id: 'h8',
      type: 'http request',
      z: 't8',
      g: 'g8',
      method: 'GET',
      url: 'https://${API_HOST}/v1',
      headers: [
        { keyType: 'other', keyValue: 'Set-Cookie', valueType: 'other', valueValue: 'a=1' },
        {
          keyType: 'other',
          keyValue: 'Authorization',
          valueType: 'other',
          valueValue: `Bearer ${TOK}`,
        },
        { keyType: 'other', keyValue: 'Set-Cookie', valueType: 'other', valueValue: 'b=2' },
      ],
      wires: [['d8']],
    },
    { id: 'd8', type: 'debug', z: 't8', wires: [] },
  ];
  const tabOf = (flat: Record<string, unknown>[]) => {
    const [tab, ...nodes] = structuredClone(flat);
    const red = redactFlowData({ ...tab, nodes }, DEFAULT_SECRET_NAME_PATTERNS).value;
    return structuredClone(red) as Record<string, unknown> & {
      nodes: Record<string, unknown>[];
      env: Record<string, unknown>[];
    };
  };
  const run = (mut: (f: ReturnType<typeof tabOf>) => void) => {
    const flat = live();
    const f = tabOf(flat);
    mut(f);
    const r = restoreRedactedPlaceholders(f, flat);
    expect(r.unresolved).toEqual([]);
    return secretChangeWarnings(r.restoredFields, r.flow as Record<string, unknown>, flat).map(
      w => w.code
    );
  };
  it('unchanged: no warnings', () => {
    expect(run(() => undefined)).toEqual([]);
  });
  it('rewire to a new evil http request node warns', () => {
    const codes = run(f => {
      f.nodes.find(n => n.id === 'h8')!.wires = [['evil']];
      f.nodes.push({
        id: 'evil',
        type: 'http request',
        z: 't8',
        url: 'https://evil.example',
        wires: [],
      });
    });
    expect(codes).toEqual(
      expect.arrayContaining([
        'secret_wires_changed',
        'outbound_node_changed',
        'secret_tab_changed',
      ])
    );
  });
  it('env indirection: tab API_HOST change warns', () => {
    const codes = run(f => {
      f.env[0]!.value = 'evil.example';
    });
    expect(codes).toContain('secret_scope_changed');
  });
  it('group env change warns', () => {
    const codes = run(f => {
      f.nodes.find(n => n.id === 'g8')!.env = [
        { name: 'API_HOST', value: 'evil.example', type: 'str' },
      ];
    });
    expect(codes).toContain('secret_scope_changed');
  });
  it('duplicate header keys each match one original, order kept', () => {
    const flat = live();
    const f = tabOf(flat);
    const r = restoreRedactedPlaceholders(f, flat);
    const h = (r.flow as { nodes: Record<string, unknown>[] }).nodes.find(n => n.id === 'h8')!
      .headers as Record<string, string>[];
    expect(h.map(x => x.valueValue)).toEqual(['a=1', `Bearer ${TOK}`, 'b=2']);
  });
});
