/**
 * On-disk layout for proposals and logs (under the Node-RED userDir).
 */

import { join } from 'node:path';

import type { NodeRedPluginSettings } from './types.js';

/**
 * Hidden AI Access data directory: `<userDir>/.ai-access`.
 * Later PRs will create `proposals/` and `logs/` under this path.
 */
export function getStorageDir(settings: NodeRedPluginSettings): string {
  return join(settings.userDir, '.ai-access');
}
