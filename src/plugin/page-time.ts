/**
 * Browser-local timestamp helpers for the /mcp admin UI.
 *
 * API `displayName` keeps Node-RED **server** local time (+ offset) for AI
 * clients. The /mcp page must never show that server string — rebuild the
 * visible title from `title` / displayName prefix + ISO `createdAt`/`at`
 * via `Intl.DateTimeFormat` in the browser timezone.
 *
 * Keep the inline copies in `page-client.ts` in sync with these helpers.
 */

/** Strip the server-formatted ` · <datetime offset>` suffix from displayName. */
export function titleFromDisplayName(displayName: string): string {
  const s = String(displayName || '');
  const idx = s.lastIndexOf(' · ');
  if (idx > 0) return s.slice(0, idx);
  return s;
}

/** Short browser-local stamp: day + short month + 24h time (no offset). */
export function formatLocalShort(iso: string, locale?: string, now: Date = new Date(iso)): string {
  const d = Number.isNaN(now.getTime()) ? new Date(iso) : now;
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** Compact browser-local absolute for `<time title="…">`. */
export function formatLocalCompact(
  iso: string,
  locale?: string,
  now: Date = new Date(iso)
): string {
  const d = Number.isNaN(now.getTime()) ? new Date(iso) : now;
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

/**
 * Build the UI heading: title · local-short. Never returns a raw API displayName
 * (which embeds server TZ).
 */
export function buildLocalProposalHeading(input: {
  title?: string;
  displayName?: string;
  createdAt?: string;
  id?: string;
}): { title: string; when: string } {
  const fromTitle = input.title ? String(input.title) : '';
  const fromDisplay = input.displayName ? titleFromDisplayName(String(input.displayName)) : '';
  const title = fromTitle !== '' ? fromTitle : fromDisplay;
  const when = input.createdAt ? formatLocalShort(input.createdAt) : '';
  return { title, when };
}
