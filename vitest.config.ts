import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __AI_ACCESS_VERSION__: JSON.stringify('0.1.0'),
  },
  test: {
    include: ['src/**/*.test.{js,ts}', 'test/**/*.test.{js,ts}'],
    exclude: ['node_modules', 'dist', '.git', '.husky', '.yarn'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      NO_PROXY: '127.0.0.1,localhost,0.0.0.0',
      no_proxy: '127.0.0.1,localhost,0.0.0.0',
    },
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'dist/**',
        'node_modules/**',
      ],
      // Plugin-focused thresholds (legacy standalone suites removed).
      thresholds: {
        branches: 55,
        functions: 70,
        lines: 70,
        statements: 70,
      },
    },
    watch: true,
    testTimeout: 10000,
    mockReset: true,
    clearMocks: true,
    restoreMocks: true,
    reporters: ['verbose'],
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
