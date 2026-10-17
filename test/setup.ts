/**
 * Vitest global setup and configuration
 */

import supertest from 'supertest';
import { vi } from 'vitest';

process.env.NODE_ENV = 'test';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {
    // Intentionally empty for testing
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {
    // Intentionally empty for testing
  });
  vi.spyOn(console, 'error').mockImplementation(() => {
    // Intentionally empty for testing
  });
  vi.spyOn(console, 'info').mockImplementation(() => {
    // Intentionally empty for testing
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * GET-link responses (`/mcp/a/*`) default to `text/plain`, so supertest would
 * not parse their JSON bodies. Most suites assert on `res.body`; default those
 * requests to `Accept: application/json` unless the test sets Accept itself.
 * Tests that check the raw default send `X-Test-Raw-Accept: 1`, which keeps the
 * request untouched (the header is ignored by the server).
 */
const { Test } = supertest;
type HeaderedTest = InstanceType<typeof Test> & { url: string; _header: Record<string, string> };
const originalEnd = Test.prototype.end;
Test.prototype.end = function patchedEnd(
  this: HeaderedTest,
  ...args: Parameters<InstanceType<typeof Test>['end']>
) {
  const headers = this._header ?? {};
  if (/\/mcp\/a(\/|$)/.test(this.url) && !headers.accept && !headers['x-test-raw-accept']) {
    this.set('Accept', 'application/json');
  }
  return originalEnd.apply(this, args);
};
