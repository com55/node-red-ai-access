import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function newest(path: string): number {
  const stat = statSync(path);
  return stat.isDirectory()
    ? Math.max(stat.mtimeMs, ...readdirSync(path).map(name => newest(join(path, name))))
    : stat.mtimeMs;
}

export default function setup() {
  if (process.env.SKIP_TEST_BUILD === '1') return;
  const inputs = [
    'src',
    'docs/api/openapi.yaml',
    ...readdirSync('.').filter(name =>
      /^(package\.json|yarn\.lock|tsconfig.*\.json|.*\.config\.[cm]?[jt]s|\.yarnrc\.yml)$/.test(
        name
      )
    ),
  ];
  const outputs = ['dist/plugin.cjs', 'dist/plugin.d.cts'];
  if (
    outputs.every(path => existsSync(path)) &&
    Math.min(...outputs.map(path => statSync(path).mtimeMs)) >= Math.max(...inputs.map(newest))
  )
    return;
  try {
    execFileSync('yarn', ['build:prod'], { stdio: 'inherit' });
  } catch {
    throw new Error(
      'Vitest setup: production build failed. Run yarn build:prod to diagnose; SKIP_TEST_BUILD=1 skips this build when using an existing dist.'
    );
  }
}
