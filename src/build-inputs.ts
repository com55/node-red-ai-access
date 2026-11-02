import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const buildStamp = 'dist/.production-build-hash';

export function hashBuildInputs(): string {
  const hash = createHash('sha256');
  const visit = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else {
      hash.update(JSON.stringify(path));
      hash.update(readFileSync(path));
    }
  };
  const inputs = [
    'src',
    'docs/api/openapi.yaml',
    ...readdirSync('.').filter(name =>
      /^(package\.json|yarn\.lock|tsconfig.*\.json|.*\.config\.[cm]?[jt]s|\.yarnrc\.yml)$/.test(
        name
      )
    ),
  ];
  for (const path of inputs.sort()) visit(path);
  return hash.digest('hex');
}
