/** Usage-bucket allowance — an adapter over `ui/meter`, nothing more.
 *
 * The whole body of this component is now a translation from `UsageBucket` into
 * `Meter`'s two honest channels, and that is deliberate: the state machine
 * (`normal` / `near-limit` / `over-limit` / `unmetered` / `unknown`) is DERIVED
 * from the numbers inside the primitive, so no call site can render a state its
 * numbers do not support.
 *
 * Three things changed and each is a §3.2 correction rather than restyling:
 *
 * 1. **`role="meter"`, not `role="progressbar"`.** §3.2 draws this distinction
 *    explicitly: a progressbar measures a task advancing toward completion, a
 *    meter measures a value inside a known range. A quota does not "finish", and
 *    `progressbar` told a screen-reader user that "3 of 3 repositories used" was
 *    100% *done* — the opposite of what it means.
 * 2. **Unlimited draws no bar.** `usageFraction` painted a 5% sliver for an
 *    unmetered bucket, which is a fabricated magnitude for a ceiling that does
 *    not exist; `Meter`'s `unmetered` arm prints "No limit on this plan" instead.
 *    That helper is deleted — a second implementation of the fill fraction beside
 *    the primitive's own is exactly the "two projections of one number" defect
 *    this codebase keeps removing.
 * 3. **Exhausted is the `error` violet, not `danger` red.** §0 rule 3 keeps red
 *    for claims about a package; a spent allowance is "we could not check", the
 *    same *we don't know* slot as audit ERROR. `Meter` owns that mapping, so it
 *    cannot drift per call site — see its docblock, which also records where to
 *    overrule it deliberately.
 *
 * `remaining === null` is the contract's spelling of "unlimited" (limit 0), and
 * `max: null` is `Meter`'s. That is the one mapping this file exists to make;
 * `usageLabel` still supplies the `∞` reading as `valueText`, so the visible and
 * the announced value stay the same string. */

import type { UsageBucket } from "@npmguard/shared";
import { Meter } from "../../../components/ui/meter.tsx";
import { usageLabel } from "../quota.ts";

interface AllowanceMeterProps {
  label: string;
  bucket: UsageBucket;
}

export function AllowanceMeter({ label, bucket }: AllowanceMeterProps) {
  return (
    <Meter
      label={label}
      value={bucket.used}
      max={bucket.remaining === null ? null : bucket.limit}
      valueText={usageLabel(bucket)}
    />
  );
}
