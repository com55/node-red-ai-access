/**
 * Vitest global setup and configuration
 */

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
