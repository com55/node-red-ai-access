import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  contents: new Map<string, string>(),
  missing: new Set<string>(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.build }));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => !mocks.missing.has(path),
  readFileSync: (path: string) => mocks.contents.get(path) ?? path,
  readdirSync: (path: string) =>
    path === '.'
      ? [
          'src',
          'dist',
          'package.json',
          'yarn.lock',
          'tsconfig.json',
          'tsup.config.ts',
          'vitest.config.ts',
        ]
      : ['nested.ts'],
  statSync: (path: string) => ({
    isDirectory: () => path === 'src',
    mtimeMs: 100,
  }),
}));

import { buildStamp, hashBuildInputs } from '../src/build-inputs.js';

import setup from './global-setup.js';

describe('test build setup', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    mocks.build.mockReset();
    mocks.contents.clear();
    mocks.missing.clear();
    mocks.missing.add('dist/plugin.cjs.map');
    mocks.contents.set(buildStamp, hashBuildInputs());
    vi.stubEnv('SKIP_TEST_BUILD', '');
  });

  it('skips a build when the production stamp matches the input contents', () => {
    setup();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it.each(['src/nested.ts', 'tsup.config.ts', 'tsconfig.json', 'package.json', 'yarn.lock'])(
    'builds when %s content changes despite identical mtimes',
    path => {
      mocks.contents.set(path, 'changed');
      setup();
      expect(mocks.build).toHaveBeenCalledWith('yarn', ['build:prod'], { stdio: 'inherit' });
    }
  );

  it('rebuilds a dev build even with a matching stamp', () => {
    mocks.missing.delete('dist/plugin.cjs.map');
    setup();
    expect(mocks.build).toHaveBeenCalledOnce();
  });

  it('rebuilds when there is no production stamp', () => {
    mocks.missing.add(buildStamp);
    setup();
    expect(mocks.build).toHaveBeenCalledOnce();
  });

  it('builds when a required dist output is missing', () => {
    mocks.missing.add('dist/plugin.d.cts');
    setup();
    expect(mocks.build).toHaveBeenCalledOnce();
  });

  it('honors SKIP_TEST_BUILD=1 even if dist is missing', () => {
    vi.stubEnv('SKIP_TEST_BUILD', '1');
    mocks.missing.add('dist/plugin.cjs');
    setup();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it('explains how to diagnose a failed build', () => {
    mocks.missing.add('dist/plugin.cjs');
    mocks.build.mockImplementation(() => {
      throw new Error('compiler failed');
    });
    expect(setup).toThrow('Vitest setup: production build failed. Run yarn build:prod');
  });
});
