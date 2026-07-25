/**
 * react-query's status → the `LoadState` vocabulary the UI already speaks.
 *
 * This is the join between the two halves of the degraded-state fix:
 *
 *  - A query library gives every resource its OWN status, so "alerts failed
 *    while repos succeeded" is representable by construction instead of needing
 *    a bespoke `billingError` field per resource (design R-5.1).
 *  - `components/ui/load-state.ts` makes the *rendering* of that status honest:
 *    the `failed` arm carries no `data` at all, and `EmptyState` demands a
 *    `ReadSucceeded` token that only `loaded(data)` can mint.
 *
 * So there is exactly one vocabulary, and this file maps onto it. Do not add a
 * second one: a hook that returns `{data, isLoading, error}` hands every call
 * site three fields it can combine wrongly, and the bug class comes straight
 * back.
 *
 * HOW TO RENDER a `LoadState`, the rule this codebase follows:
 *
 *  - The region has a visible empty state worth showing → `<DataRegion>`. It
 *    switches exhaustively and `children` is a function of the NARROWED data, so
 *    the success branch cannot be reached while holding a failure.
 *  - The honest empty rendering is *nothing* (an alert banner, a plan ledger for
 *    an account that has no plans) → switch on `state.status` at the call site
 *    and render `<DegradedRegion>` on `failed`. `DataRegion` is wrong there
 *    because it would require empty copy that can never be shown, and dead copy
 *    is its own small lie.
 *
 * Either way the guarantee is structural, not remembered: on the `failed` arm
 * there is no `data` identifier in scope to render.
 */

import type { UseQueryResult } from "@tanstack/react-query";
import { failed, loaded, LOADING, type Failure, type LoadState } from "../components/ui/load-state.ts";
import { ApiError, capBody, errorDetail } from "./api-base.ts";
import { retryable } from "./query-client.ts";
import { ContractViolationError } from "./wire.ts";

/** The slice of a query result this module reads. Narrower than
 * `UseQueryResult` so a caller can hand-build one in a test without faking
 * twenty fields. */
export type QueryRead<T> = Pick<
  UseQueryResult<T>,
  "data" | "error" | "dataUpdatedAt" | "isRefetchError" | "refetch"
>;

/**
 * Turn an unknown thrown value into a `Failure` — which is to say, give it a
 * NAME. `what` is required by the type, so there is no path to a degraded state
 * that says only "something went wrong".
 *
 * `retry` is attached only when another attempt could change the answer, using
 * the SAME classification the automatic retry policy uses. `Failure.retry` is
 * optional precisely so that a hopeless case renders no button: a Retry that
 * reproduces the same 404 is worse than none, and offering it here while the
 * client refuses to retry automatically would be two policies disagreeing.
 */
export function failureOf(error: unknown, what: string, retry?: () => void): Failure {
  const offer = retry && retryable(error) ? { retry } : {};
  if (error instanceof ContractViolationError) {
    // Naming drift as drift matters: "not found" sends a reader to GitHub
    // permissions, "the response does not match the contract" sends them to
    // whoever changed the engine. Never retryable — same payload, same parse.
    return { what, detail: error.message };
  }
  if (error instanceof ApiError) {
    return {
      what,
      detail: `${errorDetail(error.body, error.message)} (HTTP ${error.status})`,
      ...offer,
    };
  }
  return {
    what,
    detail: error instanceof Error ? error.message : String(error),
    ...offer,
  };
}

/**
 * The single mapping. Three states in, three states out.
 *
 * Two decisions worth the ink, because both look like bugs until explained:
 *
 * 1. **Holding data wins over an error.** react-query keeps `status: "error"`
 *    on a query that already has data and whose *refetch* failed. `LoadState`
 *    has no "ok but the last refresh broke" arm — by design, since data we are
 *    holding IS data we read, and throwing it away to render hatch would lose
 *    real information over a transient blip. So data present ⇒ `ok`, and the
 *    failed refresh is carried by `asOf` instead (below).
 * 2. **`asOf` is set ONLY when the last refresh failed**, not merely when the
 *    data is past `staleTime`. `asOf` is the signal a caller uses to decide
 *    whether to pair the view with a `<StaleChip>`; if it were set on every
 *    stale-but-refetching query, every region would wear a chip and the chip
 *    would stop meaning anything. Set here it means one precise thing: "this is
 *    the last data we got, and we tried to refresh it and could not."
 */
export function toLoadState<T>(query: QueryRead<T>, what: string): LoadState<T> {
  if (query.data !== undefined) {
    const asOf = query.isRefetchError ? new Date(query.dataUpdatedAt).toISOString() : undefined;
    return loaded(query.data, asOf);
  }
  if (query.error) {
    return failed(failureOf(query.error, what, () => void query.refetch()));
  }
  return LOADING;
}

/**
 * AND several reads into one. The composite is `ok` only if EVERY part is,
 * which is what makes "render a confident view over a partial fetch"
 * unrepresentable rather than merely discouraged:
 *
 *   - the only way to reach the data is the `ok` arm;
 *   - the `ok` arm carries a `ReadSucceeded`, mintable only by `loaded()`;
 *   - `loaded()` is called here on one code path, after every part has been
 *     proven `ok`.
 *
 * Use it where a claim is a PRODUCT of two reads — the dashboard's "Install
 * NpmGuard on a GitHub account" is only true when the installations list read
 * empty AND the repo list read empty. Do NOT use it to bundle regions that
 * merely sit on the same page: that throws away the per-query status this whole
 * rework exists to gain, and reintroduces the all-or-nothing `refresh()`.
 */
export function allLoaded<T extends Record<string, unknown>>(parts: {
  [K in keyof T]: LoadState<T[K]>;
}): LoadState<T> {
  const states = Object.values(parts) as LoadState<unknown>[];

  // Failure beats pending. A failure is a fact the reader can act on; a spinner
  // over a known failure is a promise that it will resolve, and it will not.
  const failures = states.flatMap((state) => (state.status === "failed" ? [state.failure] : []));
  if (failures.length === 1) return failed(failures[0]!);
  if (failures.length > 1) {
    // Naming one of several failures is a partial truth, so name them all. The
    // retry fires every part that offered one.
    const retries = failures.flatMap((failure) => (failure.retry ? [failure.retry] : []));
    return failed({
      what: failures.map((failure) => failure.what).join(" and "),
      detail: failures.flatMap((failure) => (failure.detail ? [failure.detail] : [])).join(" · "),
      ...(retries.length > 0 ? { retry: () => retries.forEach((run) => run()) } : {}),
    });
  }

  if (states.some((state) => state.status === "loading")) return LOADING;

  // Every part is `ok`. The casts are contained to these three lines: the loop
  // above is the proof the compiler cannot carry through `Object.values`.
  const data = {} as T;
  let asOf: string | undefined;
  for (const key of Object.keys(parts) as (keyof T)[]) {
    const state = parts[key] as Extract<LoadState<T[keyof T]>, { status: "ok" }>;
    data[key] = state.data;
    // Any part that is stale makes the composite stale — the claim is only as
    // current as its least-current input.
    asOf ??= state.asOf;
  }
  return loaded(data, asOf);
}

/**
 * A mutation's error, as a `Failure` a call site can render — or `null` when
 * the paywall already owns it.
 *
 * 402 caps are handled ONCE, globally (`query-client.ts` patches the billing
 * ledger and opens the paywall). Every call site still sees the rejection on
 * its own mutation, so without this filter a capped "Protect" would render both
 * the upgrade dialog and a red "Protected-repository limit reached" banner
 * behind it — which reads as two separate problems.
 */
export function actionFailure(error: unknown, what: string): Failure | null {
  if (error === null || error === undefined) return null;
  if (capBody(error)) return null;
  return failureOf(error, what);
}
