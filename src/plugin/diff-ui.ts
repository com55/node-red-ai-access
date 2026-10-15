/**
 * Shared helpers for /mcp proposal-diff UI (defaults + presence field display).
 */

/** Viewport width at/above which the default layout is side-by-side. */
export const DIFF_SPLIT_MIN_PX = 900;

/** Max length for a single-line presence field shown inline (not collapsed). */
export const PRESENCE_SHORT_TEXT_MAX = 120;

export type DiffLayoutMode = 'split' | 'unified';

/** Default layout when the user has not saved a preference. */
export function defaultDiffMode(viewportWidthPx: number): DiffLayoutMode {
  return viewportWidthPx >= DIFF_SPLIT_MIN_PX ? 'split' : 'unified';
}

/**
 * Long multi-line (or over-length) presence text should collapse in a
 * `<details>`; short single-line fields (format, syntax, …) stay inline.
 */
export function isCollapsiblePresenceText(
  value: unknown,
  maxChars: number = PRESENCE_SHORT_TEXT_MAX
): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.includes('\n')) {
    return true;
  }
  return value.length > maxChars;
}
