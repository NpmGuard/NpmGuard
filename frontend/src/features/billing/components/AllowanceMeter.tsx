/** Usage-bucket meter: mono `used / limit` label (∞ when unlimited) over a
 * base.css meter. Exhausted buckets fill in the danger tone. */

import type { UsageBucket } from "../../lib/engine-types.ts";
import { quotaState, usageFraction, usageLabel } from "../../lib/quota.ts";

interface AllowanceMeterProps {
  label: string;
  bucket: UsageBucket;
}

export function AllowanceMeter({ label, bucket }: AllowanceMeterProps) {
  const state = quotaState(bucket);
  const width = `${Math.round(usageFraction(bucket) * 100)}%`;
  return (
    <div className="panel-meter">
      <div className="panel-meter__head">
        <span className="eyebrow eyebrow--faint">{label}</span>
        <span className="microtext mono">{usageLabel(bucket)}</span>
      </div>
      <div
        className="meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={bucket.remaining === null ? Math.max(bucket.used, 1) : bucket.limit}
        aria-valuenow={bucket.used}
        aria-valuetext={usageLabel(bucket)}
      >
        <div
          className={`meter__fill${state.kind === "exhausted" ? " meter__fill--danger" : ""}`}
          style={{ width }}
        />
      </div>
    </div>
  );
}
