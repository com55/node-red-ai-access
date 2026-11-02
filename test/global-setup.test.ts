import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  modified: new Map<string, number>(),
  missing: new Set<string>(),
}));
vi.mock('node:child_process', () => ({ execFileSync: mocks.build }));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => !mocks.missing.has(path),
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
    mtimeMs: mocks.modified.get(path) ?? (path.startsWith('dist/') ? 200 : 100),
  }),
}));

import setup from './global-setup.js';

describe('test build setup', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    mocks.build.mockReset();
    mocks.modified.clear();
    mocks.missing.clear();
    vi.stubEnv('SKIP_TEST_BUILD', '');
  });

  it('skips a build when both dist outputs are newer than source and config', () => {
    setup();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it.each(['src/nested.ts', 'tsup.config.ts', 'tsconfig.json', 'package.json', 'yarn.lock'])(
    'builds when %s is newer than dist',
    path => {
      mocks.modified.set(path, 300);
      setup();
      expect(mocks.build).toHaveBeenCalledWith('yarn', ['build:prod'], { stdio: 'inherit' });
    }
  );

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
