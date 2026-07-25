/** Pure quota-display logic for UsageBucket allowances. */

import type { UsageBucket } from "@npmguard/shared";

export type QuotaState =
  | { kind: "unlimited" }
  | { kind: "exhausted" }
  | { kind: "available"; remaining: number };

/** remaining === null means UNLIMITED (limit 0), not zero-left. */
export function quotaState(bucket: UsageBucket): QuotaState {
  if (bucket.remaining === null) return { kind: "unlimited" };
  if (bucket.remaining <= 0) return { kind: "exhausted" };
  return { kind: "available", remaining: bucket.remaining };
}

/* `publicAuditAllowanceCopy` was deleted here when D-1 stopped billing public
   repository scans to an installation. There is no `publicRepoAudits` bucket to
   describe any more: the scan needs a GitHub sign-in and nothing else, and its
   cost ceiling is per user and expressed as COVERAGE ("audited 150 of 900
   dependencies"), not as an allowance. Copy about a remaining allowance would
   describe a quota nothing meters. */

export function usageLabel(bucket: UsageBucket): string {
  return bucket.remaining === null ? `${bucket.used} / ∞` : `${bucket.used} / ${bucket.limit}`;
}

/* `usageFraction` was deleted here when `AllowanceMeter` became an adapter over
   `ui/meter`. The primitive derives its own fill from `(value, max)` and its own
   state machine from the same pair, so keeping a second fraction beside it was two
   projections of one number — and the projection here was the dishonest one: it
   painted a 5% sliver for an UNMETERED bucket, a magnitude for a ceiling that does
   not exist. `Meter` prints "No limit on this plan" and draws no bar. Do not
   reintroduce it; if a caller needs a fill, it needs `Meter`. */
