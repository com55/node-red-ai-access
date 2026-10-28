/**
 * /ai-access location-hash helpers for tab restore and one-shot proposal deep links.
 *
 * Tab fragments: #status (alias #overview) | #settings | #links (alias #tokens) | #oauth | #proposals | #audit
 * Deep link: #proposal=<id> (consumed after focus → #proposals)
 */

export type McpTabId = 'status' | 'settings' | 'links' | 'oauth' | 'proposals' | 'logs';

const TAB_IDS: readonly string[] = ['status', 'settings', 'links', 'oauth', 'proposals'];

/** Tab id → location hash fragment (Audit log panel uses #audit). */
export function hashForTab(tab: string): string {
  if (tab === 'logs') return 'audit';
  if (TAB_IDS.includes(tab)) return tab;
  return 'status';
}

/**
 * Parse a tab from `location.hash` (#status|#links|#proposals|#audit, plus
 * legacy #logs). Returns '' for empty, unknown, or #proposal=<id>.
 */
export function tabFromHash(hash: string): McpTabId | '' {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw || raw.startsWith('proposal=')) return '';
  if (raw === 'audit' || raw === 'logs') return 'logs';
  if (raw === 'overview') return 'status';
  if (raw === 'tokens') return 'links';
  if (TAB_IDS.includes(raw)) return raw as McpTabId;
  return '';
}

/** Read proposal id from `#proposal=<id>` (empty when absent/invalid). */
export function readProposalHashId(hash: string): string {
  try {
    const m = /^#proposal=([^&]+)/.exec(String(hash || ''));
    if (!m?.[1]) return '';
    return decodeURIComponent(m[1]);
  } catch {
    return '';
  }
}

/** Initial tab from hash: proposal deep link → proposals, else tab fragment, else status. */
export function initialTabFromHash(hash: string): McpTabId {
  if (readProposalHashId(hash)) return 'proposals';
  return tabFromHash(hash) || 'status';
}
