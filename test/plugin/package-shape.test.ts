/**
 * Package metadata contract for the Node-RED plugin entry.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  'node-red'?: {
    version?: string;
    plugins?: Record<string, string>;
  };
};

describe('package.json Node-RED plugin shape', () => {
  it('declares the scoped package name', () => {
    expect(packageJson.name).toBe('@com55/node-red-ai-access');
  });

  it('lists node-red as an optional peerDependency targeting 4.x+', () => {
    expect(packageJson.peerDependencies?.['node-red']).toMatch(/^>=4/);
    expect(packageJson.peerDependenciesMeta?.['node-red']?.optional).toBe(true);
  });

  it('registers the plugin entry under node-red.plugins', () => {
    expect(packageJson['node-red']?.version).toMatch(/^>=4/);
    expect(packageJson['node-red']?.plugins).toEqual({
      'ai-access': 'ai-access.cjs',
    });
  });

  it('ships companion ai-access.html as a thin cache-busting sidebar loader', () => {
    expect(packageJson.files).toContain('ai-access.html');
    expect(existsSync(join(root, 'ai-access.html'))).toBe(true);
    const html = readFileSync(join(root, 'ai-access.html'), 'utf8');
    expect(html).toMatch(/ai-access-sidebar\.js\?v=/);
    expect(html).toMatch(/RED\.sidebar/);
    expect(html).not.toMatch(/RED\.userSettings\.add/);
    expect(html).toMatch(/ai-access/);
    const index = readFileSync(join(root, 'src/plugin/index.ts'), 'utf8');
    expect(index).toMatch(/\/mcp\/editor\/ai-access-sidebar\.js/);
    expect(index).toMatch(/renderEditorSidebarJs/);
    expect(index).toMatch(/Cache-Control.*no-store/);
  });
});

describe('/mcp audit log page client', () => {
  it('renders friendlier action badges instead of raw mid-word wraps', () => {
    const client = readFileSync(join(root, 'src/plugin/page-client.ts'), 'utf8');
    expect(client).toMatch(/actionBadge/);
    expect(client).toMatch(/Created/);
    expect(client).toMatch(/Approved/);
    expect(client).toMatch(/actorPlain/);
    expect(client).toMatch(/col-actor" title="/);
    const styles = readFileSync(join(root, 'src/plugin/page-styles.ts'), 'utf8');
    expect(styles).toMatch(/action-badge/);
    expect(styles).toMatch(/col-action[\s\S]*white-space:\s*nowrap/);
    expect(styles).toMatch(/col-actor[\s\S]*white-space:\s*nowrap/);
  });

  it('uses a wide responsive layout and side-by-side diff toggle', () => {
    const styles = readFileSync(join(root, 'src/plugin/page-styles.ts'), 'utf8');
    expect(styles).toMatch(/max-width:\s*min\(1400px,\s*95vw\)/);
    expect(styles).toMatch(/\.diff-split/);
    expect(styles).toMatch(/\.diff-mode-toggle/);
    expect(styles).toMatch(/\.diff-line/);
    expect(styles).toMatch(/white-space:\s*pre-wrap/);
    expect(styles).toMatch(/overflow-wrap:\s*anywhere/);
    expect(styles).toMatch(/DIFF_SPLIT_MIN_PX/);
    expect(styles).toMatch(/\.empty-state/);
    expect(styles).toMatch(/button\.action\.copied/);
    const client = readFileSync(join(root, 'src/plugin/page-client.ts'), 'utf8');
    expect(client).toMatch(/data-diff-mode="split"/);
    expect(client).toMatch(/data-diff-mode="unified"/);
    expect(client).toMatch(/renderSplitTextDiff|Side by side/);
    expect(client).toMatch(/bindDiffModeToggle/);
    expect(client).toMatch(/defaultDiffModeFromViewport|DIFF_SPLIT_MIN_PX/);
    expect(client).toMatch(/localStorage\.setItem\(DIFF_MODE_KEY/);
    expect(client).toMatch(/isCollapsiblePresenceText|PRESENCE_SHORT_TEXT_MAX/);
    expect(client).toMatch(/presence-inline/);
    expect(client).toMatch(/copy-link|Copy link/);
    expect(client).toMatch(/markCopied|Copied/);
    expect(client).toMatch(/fmtRelative|timeCell/);
    expect(client).toMatch(/window\.confirm/);
  });

  it('renders added/removed nodes as single presence blocks', () => {
    const client = readFileSync(join(root, 'src/plugin/page-client.ts'), 'utf8');
    expect(client).toMatch(/Node added/);
    expect(client).toMatch(/Node removed/);
    expect(client).toMatch(/renderPresenceNode/);
    expect(client).toMatch(/presence-all-props|All properties/);
    expect(client).toMatch(/presence-preview-toggle|Preview/);
    expect(client).toMatch(/sandbox=""/);
    expect(client).toMatch(/displayName|proposal-heading|proposalHeading|fmtLocalShort/);
    expect(client).toMatch(/Intl\.DateTimeFormat/);
    expect(client).toMatch(/titleFromDisplayName/);
    expect(client).toMatch(/Never render API displayName/);
    expect(client).toMatch(/alignSplitDiffLines/);
    expect(client).toMatch(/#proposal=/);
    expect(client).toMatch(/focusProposalFromHash|proposal-highlight/);
    expect(client).toMatch(/history\.replaceState|replaceLocationHash/);
    expect(client).toMatch(/hashForTab|tabFromHash|initialTabFromHash/);
    expect(client).toMatch(/tab === 'logs'\) return 'audit'/);
    expect(client).toMatch(/replaceLocationHash\('#proposals'\)/);
    expect(client).toMatch(/vsCurrent|live flow/i);
    expect(client).toMatch(/what the AI started from|base snapshot|live flow/);
    expect(client).toMatch(/showAuthGate|Approve &amp; deploy|fieldLabel|Connects to/);
    expect(client).toMatch(/Function code|HTML template|fieldLabelHtml/);
    expect(client).toMatch(/You \(admin\)/);
    expect(client).toMatch(/AI \(/);
    expect(client).toMatch(/Deploy options/);
    expect(client).toMatch(/Only changed nodes \(recommended\)/);
    expect(client).toMatch(/Changed flows|Full redeploy/);
    expect(client).toMatch(/to review.*out of date|formatPendingBadgeText/);
    expect(client).toMatch(/badge\.textContent = String\(counts\.live\)/);
    expect(client).toMatch(/displayTitleForProposal|data-title-for/);
    expect(client).toMatch(/flow changed since/);
    expect(client).toMatch(/Dismiss all out-of-date|dismiss-all-stale/);
    expect(client).toMatch(/renderHumanDiff/);
    expect(client).toMatch(/isLargeDelete/);
    expect(client).toMatch(/openDeleteConfirmDialog/);
    expect(client).toMatch(/deleteInput\.value !== 'DELETE'/);
    expect(client).toMatch(/You're an admin/);
    expect(client).toMatch(/renderDeleteBanner/);
    expect(client).toMatch(/Deletes .* of .* nodes/);
    // Round-2 regression guard: banner must NOT be gated on !stale.
    expect(client).not.toMatch(/isLargeDelete\([^)]*\) && !/);
    expect(client).toMatch(/renderStaleGroup|stale-group/);
    expect(client).toMatch(/Requested via link/);
    expect(client).toMatch(/Show .*line change|large-diff-btn/);
    const styles = readFileSync(join(root, 'src/plugin/page-styles.ts'), 'utf8');
    expect(styles).toMatch(/\.node-presence/);
    expect(styles).toMatch(/\.presence-pre/);
    expect(styles).toMatch(/\.presence-preview-frame/);
    expect(styles).toMatch(/\.proposal-highlight/);
    expect(styles).toMatch(/\.proposal-changes|\.stale-group/);
    expect(styles).toMatch(/\.delete-banner/);
    expect(styles).toMatch(/\.stale-reason/);
  });
});

describe('ai-access sidebar TTL layout', () => {
  it('auto-saves only with friendly deploy labels (served JS, not cached HTML)', () => {
    const sidebar = readFileSync(join(root, 'src/plugin/editor-sidebar.ts'), 'utf8');
    expect(sidebar).toMatch(/scheduleAutoSave/);
    expect(sidebar).toMatch(/Changes apply immediately \(no restart\)/);
    expect(sidebar).not.toMatch(/ai-access-save/);
    expect(sidebar).toMatch(/Default link expiry(?! \(hours\))/);
    expect(sidebar).not.toMatch(/Default link expiry \(hours\)/);
    expect(sidebar).toMatch(/AI tools are disabled/);
    expect(sidebar).not.toMatch(/MCP tools are disabled/);
    expect(sidebar).toMatch(/pendingSidebarText|1 proposal to review|to review/);
    expect(sidebar).toMatch(/ai-access-actions/);
    expect(sidebar).toMatch(/Only changed nodes \(recommended\)/);
    expect(sidebar).toMatch(/Changed flows/);
    expect(sidebar).toMatch(/Full redeploy/);
    expect(sidebar).toMatch(/flex-wrap:\s*nowrap/);
    expect(sidebar).toMatch(/red-ui-settings-row stacked/);
    expect(sidebar).toMatch(/flex-direction:\s*column/);
  });
});
