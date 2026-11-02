import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  loadOpenApiJson,
  loadOpenApiYaml,
  resolveOpenApiYamlPath,
} from '../../src/plugin/openapi.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const specPath = join(root, 'docs/api/openapi.yaml');
const yaml = readFileSync(specPath, 'utf8');

describe('OpenAPI module location', () => {
  it('resolves and loads the specification under Vitest', () => {
    expect(resolveOpenApiYamlPath()).toBe(specPath);
    expect(loadOpenApiYaml()).toBe(yaml);
    expect(JSON.parse(loadOpenApiJson()).openapi).toBe('3.1.0');
  });

  it.each(['cjs', 'mjs'])('loads native %s independently of cwd', format => {
    // Keep the emitted module one level below the package, like dist/plugin.cjs.
    const output = mkdtempSync(join(root, '.openapi-test-'));
    const cwd = mkdtempSync(join(tmpdir(), 'openapi-cwd-'));
    try {
      const source = readFileSync(join(root, 'src/plugin/openapi.ts'), 'utf8');
      const compiled = transformSync(source, {
        loader: 'ts',
        format: format === 'cjs' ? 'cjs' : 'esm',
        platform: 'node',
        target: 'es2022',
        logLevel: 'silent',
      }).code;
      const modulePath = join(output, `openapi.${format}`);
      writeFileSync(modulePath, compiled);
      const script =
        format === 'cjs'
          ? `const api = require(${JSON.stringify(modulePath)});`
          : `import * as api from ${JSON.stringify(pathToFileURL(modulePath).href)};`;
      const result = execFileSync(
        process.execPath,
        [
          '--input-type',
          format === 'cjs' ? 'commonjs' : 'module',
          '-e',
          `${script} process.stdout.write(JSON.stringify({path: api.resolveOpenApiYamlPath(), yaml: api.loadOpenApiYaml(), json: JSON.parse(api.loadOpenApiJson())}));`,
        ],
        { cwd, encoding: 'utf8' }
      );
      const loaded = JSON.parse(result);
      expect(loaded.path).toBe(specPath);
      expect(loaded.yaml).toBe(yaml);
      expect(loaded.json.openapi).toBe('3.1.0');
    } finally {
      rmSync(output, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('serves the specification from the required production plugin outside the repo cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openapi-plugin-'));
    try {
      const result = execFileSync(
        process.execPath,
        [
          '-e',
          `const { registerRoutes } = require(${JSON.stringify(join(root, 'dist/plugin.cjs'))});
          const routes = new Map();
          const noop = () => {};
          registerRoutes({
            settings: { userDir: process.cwd(), adminAuth: { type: 'credentials' } },
            httpAdmin: new Proxy({}, { get: (_, method) => (path, ...handlers) => {
              if (method === 'get') routes.set(path, handlers.at(-1));
            }}),
            auth: { needsPermission: () => noop },
            log: { info: noop, warn: noop, error: noop },
          }, { flowAdapter: { kind: 'red', getFlows: async () => ({ flows: [] }) } });
          const responses = [];
          for (const ext of ['yaml', 'json']) {
            const res = { status(code) { this.code = code; return this; }, type() { return this; },
              send(body) { responses.push({ code: this.code, body }); },
              json(body) { responses.push({ code: this.code, body }); } };
            routes.get('/mcp/api/v1/openapi.' + ext)({}, res);
          }
          process.stdout.write(JSON.stringify(responses));`,
        ],
        { cwd, encoding: 'utf8' }
      );
      const responses = JSON.parse(result);
      expect(responses[0]).toEqual({ code: 200, body: yaml });
      expect(responses[1].code).toBe(200);
      expect(JSON.parse(responses[1].body).openapi).toBe('3.1.0');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
