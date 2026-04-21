/**
 * Text-similarity utilities for hypothesis deduplication.
 *
 * Jaro-Winkler is used because hypothesis descriptions are short natural-language
 * phrases where a common prefix ("lib/init.js:42 reads .npmrc ...") should
 * dominate similarity, and where transpositions and small edits are typical of
 * paraphrasing rather than semantic difference.
 */

/** Standard Jaro similarity in [0, 1]. */
function jaroSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(b.length, i + matchWindow + 1);
    for (let j = start; j < end; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions between matched characters
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = Math.floor(transpositions / 2);

  return (
    matches / a.length +
    matches / b.length +
    (matches - transpositions) / matches
  ) / 3;
}

/**
 * Jaro-Winkler similarity in [0, 1]. Adds a prefix bonus (up to 4 chars at 0.1
 * each) on top of Jaro similarity, rewarding strings that agree at the start.
 */
export function jaroWinkler(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  if (jaro <= 0) return jaro;

  let prefixLen = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefixLen++;
    else break;
  }

  return jaro + prefixLen * 0.1 * (1 - jaro);
}

export const DEFAULT_MERGE_THRESHOLD = 0.88;

/** Normalize descriptions for fair comparison: lowercase + whitespace collapse. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when two descriptions are similar enough to be considered duplicates. */
export function similarDescription(
  a: string,
  b: string,
  threshold: number = DEFAULT_MERGE_THRESHOLD,
): boolean {
  return jaroWinkler(normalize(a), normalize(b)) >= threshold;
}

/**
 * Search an existing list for a description that is near-duplicate of the
 * candidate. Returns the first match above `threshold`, or null.
 */
export function findDuplicate<H extends { description: string }>(
  candidate: H,
  existing: readonly H[],
  threshold: number = DEFAULT_MERGE_THRESHOLD,
): H | null {
  for (const h of existing) {
    if (similarDescription(candidate.description, h.description, threshold)) {
      return h;
    }
  }
  return null;
}
