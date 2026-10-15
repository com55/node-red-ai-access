/**
 * Load and serve the OpenAPI YAML for `/mcp/api/v1`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Response } from 'express';

import type { AuthenticatedRequest } from './types.js';

function moduleDir(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolve the OpenAPI YAML from dist (packaged) or the repo docs tree (dev/tests).
 */
export function resolveOpenApiYamlPath(): string | null {
  const here = moduleDir();
  const candidates = [
    join(here, 'openapi.yaml'),
    join(here, '..', 'openapi.yaml'),
    join(here, '..', '..', 'docs', 'api', 'openapi.yaml'),
    join(process.cwd(), 'docs', 'api', 'openapi.yaml'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function loadOpenApiYaml(): string {
  const path = resolveOpenApiYamlPath();
  if (!path) {
    throw new Error('OpenAPI specification file was not found');
  }
  return readFileSync(path, 'utf8');
}

/** Public GET handler — no admin session required (documentation only). */
export function openApiYamlHandler() {
  return (_req: AuthenticatedRequest, res: Response): void => {
    try {
      const yaml = loadOpenApiYaml();
      res.status(200).type('application/yaml').send(yaml);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  };
}
