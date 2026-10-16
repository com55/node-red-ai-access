/**
 * Load and serve the OpenAPI YAML for `/mcp/api/v1`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Response } from 'express';
import { parse as parseYaml } from 'yaml';

import type { AuthenticatedRequest } from './types.js';

function moduleDir(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolve the single OpenAPI YAML copy in docs/api (packaged and in the repo).
 */
export function resolveOpenApiYamlPath(): string | null {
  const here = moduleDir();
  const candidates = [
    // Packaged: dist/plugin.cjs -> ../docs/api/openapi.yaml
    join(here, '..', 'docs', 'api', 'openapi.yaml'),
    // Source (dev/tests): src/plugin/openapi.ts -> ../../docs/api/openapi.yaml
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

let cachedJson: { path: string; json: string } | undefined;

/** The spec as JSON text, converted from the YAML once per resolved file. */
export function loadOpenApiJson(): string {
  const path = resolveOpenApiYamlPath();
  if (!path) {
    throw new Error('OpenAPI specification file was not found');
  }
  if (cachedJson?.path !== path) {
    cachedJson = { path, json: JSON.stringify(parseYaml(readFileSync(path, 'utf8'))) };
  }
  return cachedJson.json;
}

/** Public GET handler for `openapi.json` (same spec as `openapi.yaml`). */
export function openApiJsonHandler() {
  return (_req: AuthenticatedRequest, res: Response): void => {
    try {
      res.status(200).type('application/json').send(loadOpenApiJson());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  };
}
