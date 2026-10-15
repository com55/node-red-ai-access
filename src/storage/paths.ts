/**
 * On-disk layout under `<userDir>/.ai-access`.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AiAccessPaths {
  root: string;
  proposals: string;
  logs: string;
}

export function resolveAiAccessPaths(userDir: string): AiAccessPaths {
  const root = join(userDir, '.ai-access');
  return {
    root,
    proposals: join(root, 'proposals'),
    logs: join(root, 'logs'),
  };
}

export function ensureAiAccessDirs(paths: AiAccessPaths): void {
  mkdirSync(paths.proposals, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
}
