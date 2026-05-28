/**
 * Find existing tags that look like near-duplicates of a candidate tag,
 * so the user can reuse an existing one instead of fragmenting the graph
 * (e.g. "flow" vs "flow-state", "поэзия" vs "поэзии").
 *
 * Note: this is string-based, so same-language variants/typos are caught.
 * Cross-language synonyms (poem/поэзия) are handled by the AI classifier,
 * not here.
 */
export function findSimilarTags(
  candidate: string,
  vocabulary: string[],
  exclude: string[] = [],
): string[] {
  const cand = candidate.toLowerCase().trim();
  if (!cand) return [];
  const excludeSet = new Set(exclude.map((t) => t.toLowerCase()));

  const scored: { tag: string; score: number }[] = [];
  for (const tag of vocabulary) {
    const t = tag.toLowerCase();
    if (t === cand) continue; // identical → already reusing, no warning needed
    if (excludeSet.has(t)) continue;
    if (isSimilar(cand, t)) {
      scored.push({ tag, score: levenshtein(cand, t) });
    }
  }

  return scored.sort((a, b) => a.score - b.score).map((s) => s.tag);
}

function isSimilar(a: string, b: string): boolean {
  // Shared stem: one contains the other (min length 3 to avoid noise)
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) {
    return true;
  }
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 4) return dist <= 1;
  return dist <= 2 || dist / maxLen <= 0.34;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
