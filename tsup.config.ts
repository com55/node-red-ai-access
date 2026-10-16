import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsup';

const repoRoot = dirname(fileURLToPath(import.meta.url));

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8')) as {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const sharedExternal = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
];

export default defineConfig({
  // Node-RED plugin entry (CommonJS for require())
  entry: {
    plugin: 'src/plugin/index.ts',
  },
  format: ['cjs'],
  dts: true,
  splitting: false,
  // Source maps for local/dev builds only; published (production) builds ship none.
  sourcemap: process.env.NODE_ENV !== 'production',
  clean: true,
  target: 'es2022',
  minify: process.env.NODE_ENV === 'production',
  external: sharedExternal,
  outExtension() {
    return { js: '.cjs' };
  },
  platform: 'node',
  keepNames: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    __AI_ACCESS_VERSION__: JSON.stringify(packageJson.version),
  },
  esbuildOptions(options) {
    options.packages = 'external';
  },
  async onSuccess() {
    // The OpenAPI spec ships once, from docs/api/openapi.yaml; drop any stale dist copy.
    rmSync(join(repoRoot, 'dist', 'openapi.yaml'), { force: true });

    // Regenerate companion HTML so ?v= always matches package.json (no hand-typed dup).
    // Use createRequire only — a dynamic import('./dist/plugin.cjs') is resolved by
    // esbuild while bundling tsup.config and fails when dist/ does not exist yet.
    const { createRequire } = await import('node:module');
    const { writeFileSync } = await import('node:fs');
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- post-build CJS
    const plugin = require('./dist/plugin.cjs') as {
      renderEditorSidebarLoaderHtml?: (v?: string) => string;
      default?: { renderEditorSidebarLoaderHtml?: (v?: string) => string };
    };
    const render =
      plugin.renderEditorSidebarLoaderHtml ?? plugin.default?.renderEditorSidebarLoaderHtml;
    if (typeof render === 'function') {
      writeFileSync(join(repoRoot, 'ai-access.html'), render(packageJson.version), 'utf8');
    }
  },
});
