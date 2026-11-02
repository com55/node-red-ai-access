import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { buildStamp, hashBuildInputs } from '../src/build-inputs.js';

export default function setup() {
  if (process.env.SKIP_TEST_BUILD === '1') return;
  const outputs = ['dist/plugin.cjs', 'dist/plugin.d.cts'];
  if (
    outputs.every(path => existsSync(path)) &&
    !existsSync('dist/plugin.cjs.map') &&
    existsSync(buildStamp) &&
    readFileSync(buildStamp, 'utf8') === hashBuildInputs()
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
