/**
 * Dependency-free line diff for proposal review (unified hunks).
 */

export type LineDiffOp = 'equal' | 'add' | 'remove';

export interface LineDiffEntry {
  op: LineDiffOp;
  text: string;
}

function lineAt(lines: string[], index: number): string {
  return lines[index] ?? '';
}

function cell(dp: number[][], row: number, col: number): number {
  const r = dp[row];
  if (!r) {
    return 0;
  }
  return r[col] ?? 0;
}

function setCell(dp: number[][], row: number, col: number, value: number): void {
  const r = dp[row];
  if (r) {
    r[col] = value;
  }
}

/**
 * Compute a simple LCS-based line diff between two strings.
 * Suitable for function/template bodies in the admin UI — not a full Myers diff.
 */
export function diffLines(before: string, after: string): LineDiffEntry[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j <= m; j += 1) {
      row.push(0);
    }
    dp.push(row);
  }

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (lineAt(a, i) === lineAt(b, j)) {
        setCell(dp, i, j, cell(dp, i + 1, j + 1) + 1);
      } else {
        setCell(dp, i, j, Math.max(cell(dp, i + 1, j), cell(dp, i, j + 1)));
      }
    }
  }

  const out: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = lineAt(a, i);
    const right = lineAt(b, j);
    if (left === right) {
      out.push({ op: 'equal', text: left });
      i += 1;
      j += 1;
    } else if (cell(dp, i + 1, j) >= cell(dp, i, j + 1)) {
      out.push({ op: 'remove', text: left });
      i += 1;
    } else {
      out.push({ op: 'add', text: right });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ op: 'remove', text: lineAt(a, i) });
    i += 1;
  }
  while (j < m) {
    out.push({ op: 'add', text: lineAt(b, j) });
    j += 1;
  }
  return out;
}

function splitLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  return value.split('\n');
}

/** One aligned row for side-by-side (split) rendering. */
export interface SplitDiffRow {
  left: LineDiffEntry | null;
  right: LineDiffEntry | null;
}

/**
 * Pair remove/add runs into side-by-side rows so a large replace
 * (many removes followed by many adds) does not push the AFTER column's
 * real content below the fold under a stack of blank placeholders.
 *
 * Keep in sync with `renderSplitTextDiff` in page-client.ts.
 */
export function alignSplitDiffLines(lines: LineDiffEntry[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i += 1;
      continue;
    }
    if (line.op === 'equal') {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }

    const removes: LineDiffEntry[] = [];
    while (i < lines.length && lines[i]?.op === 'remove') {
      const rem = lines[i];
      if (rem) {
        removes.push(rem);
      }
      i += 1;
    }
    const adds: LineDiffEntry[] = [];
    while (i < lines.length && lines[i]?.op === 'add') {
      const add = lines[i];
      if (add) {
        adds.push(add);
      }
      i += 1;
    }

    const n = Math.max(removes.length, adds.length);
    for (let k = 0; k < n; k += 1) {
      rows.push({
        left: removes[k] ?? null,
        right: adds[k] ?? null,
      });
    }
  }
  return rows;
}
