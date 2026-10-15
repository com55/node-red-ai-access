/**
 * On-disk layout for proposals and logs (under the Node-RED userDir).
 */

import { join } from 'node:path';

import type { NodeRedPluginSettings } from './types.js';

/**
 * Hidden AI Access data directory: `<userDir>/.ai-access`.
 * Contains `proposals/` JSON files and append-only `logs/`.
 */
export function getStorageDir(settings: NodeRedPluginSettings): string {
  return join(settings.userDir, '.ai-access');
}
