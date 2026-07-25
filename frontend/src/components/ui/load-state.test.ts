/**
 * Unit: the read-state union — load-state.ts.
 *
 * The design doc's N-3 failure is not a rendering bug, it is a *modelling* bug:
 * `items: T[]` plus `error: Error | null` lets both be set, lets neither be set,
 * and lets `[]` mean either "nothing there" or "we never found out". This union
 * has no such state, and these tests pin the properties that make that true.
 *
 * Input classes:
 *  C1  constructors — `loaded` carries data and a success token; `failed` carries
 *      a named failure; `LOADING` carries neither.
 *  C2  the success token is not forgeable. `EmptyState` requires one, so if a
 *      plain object satisfied `ReadSucceeded` the entire enforcement would be
 *      decorative. Checked at COMPILE time via `@ts-expect-error` — a directive
 *      that stops erroring is itself an error under `tsc`, so this test fails the
 *      typecheck gate the moment the brand weakens.
 *  C3  a `Failure` is not assignable where a success is required, and vice versa —
 *      "render the empty state on error" must not typecheck.
 *  C4  `isEmpty` is only answerable about a successful read. A failed read is
 *      never empty, which is the runtime half of the same invariant.
 *  C5  `isEmptyValue` — arrays by length, maps/sets by size, nullish empty, and a
 *      scalar that loaded is information rather than emptiness.
 */

import { describe, expect, it } from "vitest";
import {
  failed,
  isEmpty,
  isEmptyValue,
  loaded,
  LOADING,
  type Failure,
  type LoadState,
  type ReadSucceeded,
} from "./load-state.ts";

describe("constructors", () => {
  it("C1: loaded carries the data and a success token", () => {
    const state = loaded([1, 2, 3]);
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.data).toStrictEqual([1, 2, 3]);
    expect(state.read).toBeDefined();
  });

  it("C1: failed carries a named failure and nothing that looks like data", () => {
    const state = failed<number[]>({ what: "Alerts feed", detail: "GET /panel/alerts failed (502)" });
    expect(state.status).toBe("failed");
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.failure.what).toBe("Alerts feed");
    // There is no `data` on this arm at all — not `[]`, not `null`. A consumer
    // cannot reach for a fallback that does not exist.
    expect("data" in state).toBe(false);
  });

  it("C1: loading is neither", () => {
    expect(LOADING.status).toBe("loading");
  });
});

describe("the success token", () => {
  it("C2: cannot be forged from an object literal", () => {
    // @ts-expect-error a plain object is not a ReadSucceeded — the brand is a
    // module-private unique symbol, so this is the line that makes EmptyState's
    // `read` prop load-bearing rather than ornamental.
    const forged: ReadSucceeded = {};
    expect(forged).toBeDefined();
  });

  it("C2: cannot be forged from a truthy value", () => {
    // @ts-expect-error same, for the "just pass true" workaround.
    const forged: ReadSucceeded = true;
    expect(forged).toBeDefined();
  });
});

describe("failure and success are not interchangeable", () => {
  it("C3: a Failure is not a ReadSucceeded", () => {
    const failure: Failure = { what: "Dependency list" };
    // @ts-expect-error this is the "render the empty state on error" bug, and it
    // is a type error rather than a code review catch.
    const asSuccess: ReadSucceeded = failure;
    expect(asSuccess).toBeDefined();
  });

  it("C3: the ok arm has no failure and the failed arm has no data", () => {
    const ok = loaded(["a"]);
    const bad = failed<string[]>({ what: "Dependency list" });
    // @ts-expect-error no `failure` on a successful read.
    void ok.failure;
    // @ts-expect-error no `data` on a failed read — this is the whole point.
    void bad.data;
    expect(ok.status).not.toBe(bad.status);
  });
});

describe("isEmpty", () => {
  it("C4: a successful read of nothing is empty", () => {
    expect(isEmpty(loaded<number[]>([]), (data) => data.length === 0)).toBe(true);
  });

  it("C4: a FAILED read is never empty", () => {
    // The discriminating case, and the one that is easy to get wrong: a failed fetch
    // whose collection was left at `[]` answered "yes, empty" and rendered "no
    // results". Here the predicate is not even consulted.
    const state: LoadState<number[]> = failed({ what: "Dependency list" });
    let predicateCalled = false;
    const result = isEmpty(state, (data) => {
      predicateCalled = true;
      return data.length === 0;
    });
    expect(result).toBe(false);
    expect(predicateCalled).toBe(false);
  });

  it("C4: a loading read is not empty either", () => {
    expect(isEmpty(LOADING as LoadState<number[]>, (data) => data.length === 0)).toBe(false);
  });
});

describe("isEmptyValue", () => {
  it("C5: collections by size, nullish empty, scalars are information", () => {
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue([0])).toBe(false);
    expect(isEmptyValue(new Map())).toBe(true);
    expect(isEmptyValue(new Set(["a"]))).toBe(false);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
    // A zero that was READ is a measurement. Treating it as emptiness is the
    // fabricated-zero mistake from the other direction.
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue("")).toBe(false);
    expect(isEmptyValue({ total: 0 })).toBe(false);
  });
});
