/** Pure quota-display logic for UsageBucket allowances. */

import type { UsageBucket } from "./engine-types.ts";

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

/** Copy for the public-repo-audit allowance. Re-auditing a repository that
 * already consumed a slot is always free — exhausted is not a dead end. */
export function publicAuditAllowanceCopy(bucket: UsageBucket): string {
  const state = quotaState(bucket);
  switch (state.kind) {
    case "unlimited":
      return "Unlimited public repository audits.";
    case "exhausted":
      return "Free repository allowance used. Existing repositories can still be re-audited.";
    case "available":
      return `${state.remaining} new public ${state.remaining === 1 ? "repository" : "repositories"} left. Re-audits are free.`;
  }
}

export function usageLabel(bucket: UsageBucket): string {
  return bucket.remaining === null ? `${bucket.used} / ∞` : `${bucket.used} / ${bucket.limit}`;
}

/** 0..1 fill for allowance meters; unlimited renders a token 5%. */
export function usageFraction(bucket: UsageBucket): number {
  if (bucket.remaining === null) return 0.05;
  if (bucket.limit <= 0) return 1;
  return Math.min(1, bucket.used / bucket.limit);
}
