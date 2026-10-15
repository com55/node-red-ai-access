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

  it('ships companion ai-access.html as an editor sidebar tab', () => {
    expect(packageJson.files).toContain('ai-access.html');
    expect(existsSync(join(root, 'ai-access.html'))).toBe(true);
    const html = readFileSync(join(root, 'ai-access.html'), 'utf8');
    expect(html).toMatch(/RED\.sidebar\.addTab/);
    expect(html).not.toMatch(/RED\.userSettings\.add/);
    expect(html).toMatch(/ai-access/);
    expect(html).toMatch(/\/settings/);
    expect(html).toMatch(/red-ui-sidebar-ai-access/);
    expect(html).toMatch(/fa fa-plug/);
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
    expect(styles).toMatch(/overflow-x:\s*auto/);
    expect(styles).toMatch(/\.diff-line/);
    expect(styles).toMatch(/DIFF_SPLIT_MIN_PX/);
    const client = readFileSync(join(root, 'src/plugin/page-client.ts'), 'utf8');
    expect(client).toMatch(/data-diff-mode="split"/);
    expect(client).toMatch(/data-diff-mode="unified"/);
    expect(client).toMatch(/renderSplitTextDiff|Side by side/);
    expect(client).toMatch(/bindDiffModeToggle/);
    expect(client).toMatch(/defaultDiffModeFromViewport|DIFF_SPLIT_MIN_PX/);
    expect(client).toMatch(/localStorage\.setItem\(DIFF_MODE_KEY/);
    expect(client).toMatch(/isCollapsiblePresenceText|PRESENCE_SHORT_TEXT_MAX/);
    expect(client).toMatch(/presence-inline/);
  });

  it('renders added/removed nodes as single presence blocks', () => {
    const client = readFileSync(join(root, 'src/plugin/page-client.ts'), 'utf8');
    expect(client).toMatch(/Node added/);
    expect(client).toMatch(/Node removed/);
    expect(client).toMatch(/renderPresenceNode/);
    expect(client).toMatch(/presence-all-props|All properties/);
    expect(client).toMatch(/presence-preview-toggle|Preview/);
    expect(client).toMatch(/sandbox=""/);
    expect(client).toMatch(/displayName|proposal-heading/);
    expect(client).toMatch(/#proposal=/);
    expect(client).toMatch(/focusProposalFromHash|proposal-highlight/);
    expect(client).toMatch(/vsCurrent|vs current flow/i);
    expect(client).toMatch(/base snapshot/);
    const styles = readFileSync(join(root, 'src/plugin/page-styles.ts'), 'utf8');
    expect(styles).toMatch(/\.node-presence/);
    expect(styles).toMatch(/\.presence-pre/);
    expect(styles).toMatch(/\.presence-preview-frame/);
    expect(styles).toMatch(/\.proposal-highlight/);
  });
});

describe('ai-access sidebar TTL layout', () => {
  it('stacks long labels above inputs', () => {
    const html = readFileSync(join(root, 'ai-access.html'), 'utf8');
    expect(html).toMatch(/red-ui-settings-row stacked/);
    expect(html).toMatch(/\.red-ui-settings-row\.stacked[\s\S]*flex-direction:\s*column/);
  });
});
