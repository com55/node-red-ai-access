/**
 * Editor localStorage auth token key (matches Node-RED editor suffix rules).
 */

import { describe, expect, it } from 'vitest';

import { editorAuthTokenKey } from '../../src/plugin/auth-token-key.js';

describe('editorAuthTokenKey', () => {
  it('uses auth-tokens when httpAdminRoot is /', () => {
    expect(editorAuthTokenKey('/')).toBe('auth-tokens');
    expect(editorAuthTokenKey(undefined)).toBe('auth-tokens');
  });

  it('applies editor path suffix for nested httpAdminRoot', () => {
    expect(editorAuthTokenKey('/admin')).toBe('auth-tokens-admin');
    expect(editorAuthTokenKey('/admin/')).toBe('auth-tokens-admin');
    expect(editorAuthTokenKey('/nr/editor')).toBe('auth-tokens-nr-editor');
  });
});
