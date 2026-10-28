/**
 * Compact / full formatting for proposal text diffs.
 */

import type { LineDiffEntry } from './line-diff.js';
import type {
  DiffSections,
  PresenceNodeDiff,
  PropertyChange,
  ProposalDiffResult,
  TextPropertyChange,
} from './proposal-diff.js';

export type DiffFormat = 'summary' | 'full';

/** Valid `?format=` values for proposal diffs (empty/undefined → summary). */
export const VALID_DIFF_FORMATS: readonly DiffFormat[] = ['summary', 'full'];

export type ResolveDiffFormatResult = { ok: true; format: DiffFormat } | { ok: false };

const DEFAULT_CONTEXT = 2;

/**
 * Resolve `?format=` for proposal diffs.
 * Empty / undefined → summary. Unknown values → `{ ok: false }` (callers return 400).
 */
export function resolveDiffFormat(raw: unknown): ResolveDiffFormatResult {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, format: 'summary' };
  }
  if (raw === 'summary' || raw === 'full') {
    return { ok: true, format: raw };
  }
  return { ok: false };
}

function compactLineDiff(
  lines: LineDiffEntry[],
  context: number = DEFAULT_CONTEXT
): { lines: LineDiffEntry[]; truncated: boolean } {
  if (lines.length === 0) {
    return { lines, truncated: false };
  }

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.op === 'equal') {
      continue;
    }
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    for (let j = start; j <= end; j += 1) {
      keep[j] = true;
    }
  }

  // If nothing changed, keep a short head/tail sample.
  if (!keep.some(Boolean)) {
    const sample = Math.min(lines.length, context * 2 + 1);
    for (let i = 0; i < sample; i += 1) {
      keep[i] = true;
    }
  }

  const out: LineDiffEntry[] = [];
  let truncated = false;
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      const line = lines[i];
      if (line) {
        out.push(line);
      }
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) {
      j += 1;
    }
    const skipped = j - i;
    truncated = true;
    out.push({
      op: 'equal',
      text: `… (${skipped} unchanged line${skipped === 1 ? '' : 's'}) …`,
    });
    i = j;
  }
  return { lines: out, truncated };
}

function formatTextChange(change: TextPropertyChange, format: DiffFormat): TextPropertyChange {
  const beforeText = change.before ?? '';
  const afterText = change.after ?? '';
  const beforeBytes = Buffer.byteLength(beforeText, 'utf8');
  const afterBytes = Buffer.byteLength(afterText, 'utf8');
  if (format === 'full') {
    return {
      ...change,
      before: beforeText,
      after: afterText,
      beforeBytes,
      afterBytes,
    };
  }
  // Summary: omit full before/after strings (can be tens of KB for a tiny edit).
  const compacted = compactLineDiff(change.lines);
  const formatted: TextPropertyChange = {
    key: change.key,
    kind: 'text',
    beforeBytes,
    afterBytes,
    lines: compacted.lines,
  };
  if (compacted.truncated) {
    formatted.truncated = true;
  }
  return formatted;
}

function formatPropertyChanges(changes: PropertyChange[], format: DiffFormat): PropertyChange[] {
  return changes.map(ch => (ch.kind === 'text' ? formatTextChange(ch, format) : ch));
}

function formatPresenceText(node: PresenceNodeDiff, format: DiffFormat): PresenceNodeDiff {
  if (format === 'full') {
    return node;
  }
  const trimText = (value: unknown): unknown => {
    if (typeof value !== 'string') {
      return value;
    }
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= 4_000) {
      return value;
    }
    return `${value.slice(0, 500)}\n… (${bytes} bytes total; use ?format=full for complete text) …`;
  };
  return {
    ...node,
    keyFields: node.keyFields.map(p =>
      p.kind === 'text' ? { ...p, value: trimText(p.value) } : p
    ),
    properties: node.properties.map(p =>
      p.kind === 'text' ? { ...p, value: trimText(p.value) } : p
    ),
  };
}

function formatSections(sections: DiffSections, format: DiffFormat): DiffSections {
  return {
    summary: sections.summary,
    added: sections.added.map(n => formatPresenceText(n, format)),
    removed: sections.removed.map(n => formatPresenceText(n, format)),
    modified: sections.modified.map(m => ({
      ...m,
      changes: formatPropertyChanges(m.changes, format),
    })),
  };
}

/** Apply summary (default) or full formatting to a proposal diff result. */
export function applyDiffFormat(
  diff: ProposalDiffResult,
  format: DiffFormat = 'summary'
): ProposalDiffResult {
  const formatted = formatSections(diff, format);
  const result: ProposalDiffResult = {
    ...diff,
    ...formatted,
    format,
  };
  if (diff.liveChanges) {
    result.liveChanges = formatSections(diff.liveChanges, format);
  }
  if (diff.vsCurrent) {
    result.vsCurrent = formatSections(diff.vsCurrent, format);
  }
  return result;
}
