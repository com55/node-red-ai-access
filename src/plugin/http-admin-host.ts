/**
 * Resolve Express apps involved in serving /mcp routes inside Node-RED.
 *
 * Plugin modules receive `runtime.adminApp` via createNodeApi. Body-parser and
 * the editor mount live on the parent `@node-red/editor-api` app
 * (`runtime._.adminApi.httpAdmin`). Parse errors from that parent never reach
 * error middleware registered only on the nested runtime app.
 */

import { createRequire } from 'node:module';

import type { Express } from 'express';

import type { NodeRedPluginAPI } from './types.js';

function createPluginRequire(): NodeRequire {
  if (typeof require === 'function') {
    return require;
  }
  const metaUrl = (0, eval)('import.meta.url') as string;
  return createRequire(metaUrl);
}

/**
 * Parent editor-api httpAdmin (has body-parser), when distinct from plugin RED.
 */
export function resolveEditorHttpAdmin(RED: NodeRedPluginAPI): Express | null {
  try {
    const req = createPluginRequire();
    const runtimeMod = req('@node-red/runtime') as {
      _?: { adminApi?: { httpAdmin?: Express } };
    };
    const parent = runtimeMod._?.adminApi?.httpAdmin;
    if (parent && typeof parent.use === 'function' && parent !== RED.httpAdmin) {
      return parent;
    }
  } catch {
    // Not running inside Node-RED, or runtime not initialized.
  }
  return null;
}

/** Apps that should receive /mcp JSON error middleware (plugin + parent). */
export function httpAdminAppsForMcpErrors(RED: NodeRedPluginAPI): Express[] {
  const apps: Express[] = [RED.httpAdmin];
  const parent = resolveEditorHttpAdmin(RED);
  if (parent) {
    apps.push(parent);
  }
  return apps;
}
