/**
 * Disambiguate colliding proposal card titles with · HH:mm (and #n if needed).
 * Used by the /ai-access dashboard client (logic mirrored inline) and unit-tested here.
 */

export function formatClockHm(iso: string, now: Date = new Date(iso)): string {
  const d = Number.isNaN(now.getTime()) ? new Date(iso) : now;
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export interface TitleDisambiguateInput {
  id: string;
  baseTitle: string;
  createdAt?: string;
}

/**
 * When two or more items share the same baseTitle, append · HH:mm from
 * createdAt. If clock times also collide, append #1/#2 by createdAt then id.
 * Relative "12h ago" labels are intentionally NOT used — they do not
 * disambiguate same-day collisions.
 */
export function buildDisambiguatedTitleMap(
  items: TitleDisambiguateInput[]
): Record<string, string> {
  const map: Record<string, string> = {};
  const groups: Record<string, TitleDisambiguateInput[]> = {};

  for (const item of items) {
    if (!item.id) continue;
    const base = item.baseTitle || 'Proposal';
    map[item.id] = base;
    groups[base] ??= [];
    groups[base].push(item);
  }

  for (const base of Object.keys(groups)) {
    const list = groups[base] ?? [];
    if (list.length < 2) continue;

    const timed: Record<string, TitleDisambiguateInput[]> = {};
    for (const item of list) {
      const hm = item.createdAt ? formatClockHm(item.createdAt) : '';
      const withTime = hm ? `${base} · ${hm}` : base;
      timed[withTime] ??= [];
      timed[withTime].push(item);
    }

    for (const t of Object.keys(timed)) {
      const group = timed[t] ?? [];
      if (group.length === 1) {
        const only = group[0];
        if (only) map[only.id] = t;
        continue;
      }
      group.sort((a, b) => {
        const ca = String(a.createdAt ?? '');
        const cb = String(b.createdAt ?? '');
        if (ca !== cb) return ca < cb ? -1 : 1;
        return String(a.id).localeCompare(String(b.id));
      });
      group.forEach((item, i) => {
        map[item.id] = `${t} #${i + 1}`;
      });
    }
  }

  return map;
}
