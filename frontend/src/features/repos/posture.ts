/** Repo-level classification: which bucket a repository's posture falls in, and
 * the counts every dashboard surface derives from it.
 *
 * This is the panel's answer to "what does this repo's last audit set MEAN",
 * and it lives here rather than inside the two components that consume it
 * (`Dashboard.tsx`'s `needsAttention` + filter counters, `PortfolioPosture.tsx`'s
 * four-way tally) for one reason: they are the same classification read twice,
 * and the rail's counts and the filter's counts are shown side by side. Two
 * inline copies of one rule is a pair that can disagree on screen, and the
 * disagreement would read to a user as the product being unsure whether their
 * repo is in trouble.
 *
 * ── THE TWO AXES, AT REPO LEVEL (design §4.4) ───────────────────────────────
 *
 * A set's `status` is PROGRESS (`running | done`) and is never a verdict; its
 * `rollup.outcome` is the OUTCOME over its items, and is null until something
 * concludes. Both classifiers below read both axes, and they read them in a
 * deliberately DIFFERENT order — see `repoBucket`.
 */

import type { PanelRepo } from "@npmguard/shared";

/** Which slice of the portfolio rail a repo occupies. Exactly one per repo, so
 * the segments are a true proportion over `repos.length`. */
export type PostureBucket = "attention" | "safe" | "running" | "unknown";

export type RepoFilter = "all" | "protected" | "unscanned" | "attention";

/** Attention = a human has to do something: a dep is DANGEROUS, or audits could
 * not conclude (ERROR). A set still running, or one with pending deps, is NOT
 * attention — it resolves itself.
 *
 * The set's own rollup is the authority. There is no failed-SET arm: R-1's
 * falsification pass found zero producers for one, and every way a set can go
 * wrong now lands in the rollup as ERROR, which this already reads. */
export function needsAttention(repo: PanelRepo): boolean {
  const outcome = repo.lastScan?.rollup.outcome ?? null;
  return outcome === "DANGEROUS" || outcome === "ERROR";
}

/** The rail bucket. PROGRESS WINS HERE, and that is the one place these two
 * functions deliberately diverge: a repo whose scan is still running has a
 * posture that is not settled, and painting a partial rollup as a settled
 * segment would claim a proportion the run may still change. `needsAttention`
 * answers a different question — "is there something to act on right now" — for
 * which a partial DANGEROUS rollup is a yes, because that finding will not
 * un-happen.
 *
 * `unknown` is last and is the honest default: no set, or a set that concluded
 * over nothing. It is never folded into `safe` — absence of knowledge is not
 * absence of threats. */
export function repoBucket(repo: PanelRepo): PostureBucket {
  if (repo.lastScan?.status === "running") return "running";
  if (needsAttention(repo)) return "attention";
  if (repo.lastScan?.rollup.outcome === "SAFE") return "safe";
  return "unknown";
}

export interface PortfolioCounts {
  attention: number;
  safe: number;
  running: number;
  unknown: number;
  /** The denominator every segment is a proportion of. */
  total: number;
  protectedRepos: number;
  /** Repos with any audit set at all — the complement of "never audited", which
   * is NOT the same as `unknown` (a running first scan is also not yet known). */
  audited: number;
}

/** The portfolio tally. The four buckets PARTITION the list
 * (`attention + safe + running + unknown === total`) because `repoBucket` is
 * total and returns exactly one bucket — that is what makes the rail a true
 * proportion rather than four independent filters that happen to add up. */
export function portfolioCounts(repos: PanelRepo[]): PortfolioCounts {
  const counts: PortfolioCounts = {
    attention: 0,
    safe: 0,
    running: 0,
    unknown: 0,
    total: repos.length,
    protectedRepos: 0,
    audited: 0,
  };
  for (const repo of repos) {
    counts[repoBucket(repo)] += 1;
    if (repo.protected) counts.protectedRepos += 1;
    if (repo.lastScan !== null) counts.audited += 1;
  }
  return counts;
}

/** Does this repo belong in `filter`? The filter chips' counts come from the
 * SAME predicate (`repoFilterCounts` below), so a chip can never advertise a
 * number the grid then fails to show. */
export function matchesRepoFilter(repo: PanelRepo, filter: RepoFilter): boolean {
  switch (filter) {
    case "protected":
      return repo.protected;
    case "unscanned":
      return repo.lastScan === null;
    case "attention":
      return needsAttention(repo);
    case "all":
      return true;
  }
}

/** Free-text match over the two identifiers a repo card actually shows. An empty
 * query matches everything — "no filter" is not "no results". */
export function matchesRepoQuery(repo: PanelRepo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    repo.fullName.toLowerCase().includes(q) || repo.defaultBranch.toLowerCase().includes(q)
  );
}

/** The chip counts. Deliberately NOT narrowed by the search box: a chip says how
 * many repos are in that state, and re-counting it under the current query
 * would make every chip read `0` while the user types a name. */
export function repoFilterCounts(repos: PanelRepo[]): Record<RepoFilter, number> {
  return {
    all: repos.length,
    protected: repos.filter((repo) => matchesRepoFilter(repo, "protected")).length,
    unscanned: repos.filter((repo) => matchesRepoFilter(repo, "unscanned")).length,
    attention: repos.filter((repo) => matchesRepoFilter(repo, "attention")).length,
  };
}
