// Minimal line-diff helper. Returns a list of hunks marking lines as
// "added", "removed", or "context". Designed for the wiki diff panel —
// where most pages are short (under ~80 lines), so a naive O(n*m) LCS is
// fine. No dependency added.

export type DiffLine =
  | { kind: "context"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string };

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const dp = lcsTable(a, b);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ kind: "removed", text: a[i++] });
  }
  while (j < b.length) {
    out.push({ kind: "added", text: b[j++] });
  }
  return out;
}

/** Counts of added / removed lines, useful for headers. */
export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "added") added++;
    else if (l.kind === "removed") removed++;
  }
  return { added, removed };
}
