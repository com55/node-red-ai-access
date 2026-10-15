/**
 * Package metadata contract for the Node-RED plugin entry.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  'node-red'?: {
    version?: string;
    plugins?: Record<string, string>;
  };
};

describe('package.json Node-RED plugin shape', () => {
  it('declares the scoped package name', () => {
    expect(packageJson.name).toBe('@com55/node-red-ai-access');
  });

  it('lists node-red as an optional peerDependency targeting 4.x+', () => {
    expect(packageJson.peerDependencies?.['node-red']).toMatch(/^>=4/);
    expect(packageJson.peerDependenciesMeta?.['node-red']?.optional).toBe(true);
  });

  it('registers the plugin entry under node-red.plugins', () => {
    expect(packageJson['node-red']?.version).toMatch(/^>=4/);
    expect(packageJson['node-red']?.plugins).toEqual({
      'ai-access': 'ai-access.cjs',
    });
  });

  it('ships companion ai-access.html for the User Settings editor tab', () => {
    expect(packageJson.files).toContain('ai-access.html');
    expect(existsSync(join(root, 'ai-access.html'))).toBe(true);
    const html = readFileSync(join(root, 'ai-access.html'), 'utf8');
    expect(html).toMatch(/RED\.userSettings\.add/);
    expect(html).toMatch(/ai-access/);
    expect(html).toMatch(/\/settings/);
  });
});
