/** The empty-vs-degraded distinction, made unrepresentable rather than
 * remembered.
 *
 * The bug class this exists to kill (design doc N-3, brief §3.4): a fetch fails,
 * the catch block leaves the collection at `[]`, and the view renders a
 * confident "No dependencies audited yet". The user reads *absence of threats*
 * where the truth was *absence of knowledge*. In a security product that is not
 * a cosmetic bug — it is the product lying.
 *
 * Convention cannot fix this, because the failing code path is the one nobody
 * looks at. So the distinction is carried by types:
 *
 *   - `EmptyState` requires a `ReadSucceeded` token.
 *   - The only way to obtain one is `loaded(data)` — you must be holding the
 *     data you actually read.
 *   - The token's brand is not exported, so it cannot be forged, spread in from
 *     an object literal, or defaulted.
 *   - `DegradedState` requires a `Failure`, which requires `what` — a name for
 *     the thing that failed. There is no way to render a degraded state without
 *     naming the failure.
 *
 * A `Failure` is not assignable where a `ReadSucceeded` is required and vice
 * versa, so "render the empty state on error" is a type error, not a code
 * review catch. */

declare const readSucceeded: unique symbol;

/** Proof that a read completed. Obtainable only from {@link loaded}. */
export type ReadSucceeded = { readonly [readSucceeded]: true };

/** Why a read failed, in terms the user can act on.
 *
 * `what` is required and is deliberately the *subject*, not the symptom:
 * "Alerts feed", not "Something went wrong". Brief §3.4 rule 1 — a user can
 * only route around a failure they can identify. */
export type Failure = {
  /** The subject that could not be read: `"Alerts feed"`, `"Dependency list"`. */
  what: string;
  /** How it failed, at engineering fidelity: `"GET /panel/alerts failed (502)"`. */
  detail?: string;
  /** Correlation id, so a support conversation can start from a fact. */
  requestId?: string;
  /** ISO timestamp of the last data that *did* load, if any survives. */
  lastGoodAt?: string;
  /** Present iff retrying is meaningful. Absent renders no retry button —
   * a dead button is worse than none. */
  retry?: () => void;
};

/** The four states any remote read can be in. There is no fifth, and in
 * particular there is no "loaded but maybe failed" — that is the state this
 * union exists to delete. */
export type LoadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly data: T; readonly read: ReadSucceeded; readonly asOf?: string }
  | { readonly status: "failed"; readonly failure: Failure };

export const LOADING: LoadState<never> = { status: "loading" };

/** Wrap data that was genuinely read. `asOf` lets the consumer decide whether
 * to pair the view with a `StaleChip` — stale data is real data, a third fact
 * distinct from both empty and failed. */
export function loaded<T>(data: T, asOf?: string): LoadState<T> {
  return { status: "ok", data, read: {} as ReadSucceeded, asOf };
}

export function failed<T>(failure: Failure): LoadState<T> {
  return { status: "failed", failure };
}

/** Emptiness is a property of *successfully read* data, which is why this takes
 * the state and not the data: there is no way to ask "is it empty?" about a
 * read that failed, because the question is meaningless. */
export function isEmpty<T>(state: LoadState<T>, empty: (data: T) => boolean): boolean {
  return state.status === "ok" && empty(state.data);
}

/** The default emptiness test: arrays by length, maps/sets by size, `null` and
 * `undefined` as empty. Anything else is non-empty — a scalar that loaded is
 * information. */
export function isEmptyValue(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (data instanceof Map || data instanceof Set) return data.size === 0;
  return false;
}
