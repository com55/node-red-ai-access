/**
 * On-disk layout under `<userDir>/.ai-access`.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { AI_ACCESS_DIR_MODE } from './trusted-write.js';

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

function mkdirSecure(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: AI_ACCESS_DIR_MODE });
  try {
    chmodSync(dir, AI_ACCESS_DIR_MODE);
  } catch {
    // Best-effort when the filesystem ignores chmod.
  }
}

export function ensureAiAccessDirs(paths: AiAccessPaths): void {
  mkdirSecure(paths.root);
  mkdirSecure(paths.proposals);
  mkdirSecure(paths.logs);
}
