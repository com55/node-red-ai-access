import { describe, expect, it } from 'vitest';

import { renderMcpPage } from '../../src/plugin/page.js';

const html = renderMcpPage({
  apiBase: '/mcp/api/v1',
  editorRoot: '/',
  authTokenKey: 'test-auth',
});
const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

describe('dashboard keyboard focus rings in the served CSS', () => {
  it('reserves room on all sides of scrolling filter chips with matching margins', () => {
    expect(html).toContain('class="filter-row" id="proposals-filters"');
    expect(css).toMatch(
      /\.filter-row \{[^}]*overflow-x: auto;[^}]*padding: 5px;[^}]*margin: -5px -5px calc\(0\.75rem - 5px\);/
    );
    // Preserve the proposal row's original 18px bottom spacing (13px + 5px).
    expect(css).toMatch(/#proposals-filters \{ margin: -5px -5px 13px; gap: 8px;/);
  });

  it('keeps the mobile row wrapping with its existing gap and visible overflow', () => {
    expect(css).toMatch(
      /@media \(max-width: 850px\) \{[^@]*#proposals-filters \{ gap: 6px; overflow: visible; \}/
    );
    expect(css).toMatch(/#proposals-filters \{[^}]*flex-wrap: wrap;/);
  });

  it('preserves the shared 2px accent outline and offset for keyboard focus', () => {
    expect(css).toContain(
      '.settings-layout :is(button, summary, [role="button"]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }'
    );
    expect(css).not.toMatch(/\.filter-chip:focus-visible\s*\{[^}]*outline:\s*(?:none|0)/);
  });

  it('fits Split/Unified focus rings inside their rounded overflow clip', () => {
    expect(css).toMatch(/\.diff-mode-toggle \{[^}]*overflow: hidden;/);
    expect(css).toContain(
      '.settings-layout .diff-mode-toggle button:focus-visible { outline-offset: -3px; border-radius: inherit; }'
    );
  });

  it('paints canvas toolbar focus rings above adjacent buttons', () => {
    expect(css).toContain(
      '.visual-layout button:focus-visible, .visual-tools button:focus-visible { position: relative; z-index: 1; }'
    );
  });
});
