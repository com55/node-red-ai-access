import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8')) as {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const sharedExternal = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
];

export default defineConfig([
  {
    // Standalone MCP server (unchanged entry)
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    splitting: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    minify: process.env.NODE_ENV === 'production',
    external: sharedExternal,
    outExtension({ format }) {
      return {
        js: format === 'cjs' ? '.cjs' : '.mjs',
      };
    },
    platform: 'node',
    keepNames: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    },
    metafile: process.env.NODE_ENV !== 'production',
    watch: process.env.NODE_ENV === 'development',
  },
  {
    // Node-RED plugin entry (CommonJS for require())
    entry: {
      plugin: 'src/plugin/index.ts',
    },
    format: ['cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: false,
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
  },
]);
