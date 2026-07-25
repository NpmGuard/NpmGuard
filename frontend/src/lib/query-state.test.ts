/**
 * Unit: react-query status → LoadState — query-state.ts.
 *
 * This mapping is where the degraded-state guarantee is either kept or lost, so
 * it is tested directly rather than only through a component.
 *
 * Input classes:
 *  Q1  three states, three arms   — pending → loading, error-without-data →
 *                                   failed, data → ok. `ok` carries the
 *                                   `ReadSucceeded` token; `failed` carries no
 *                                   `data` field at all.
 *  Q2  data survives a failed refresh — react-query reports `error` on a query
 *                                   that HOLDS data and whose refetch failed.
 *                                   Data we hold is data we read, so that maps to
 *                                   `ok` — tagged with `asOf` so the view can wear
 *                                   a StaleChip instead of silently claiming
 *                                   currency.
 *  Q3  failures are NAMED         — every `Failure` carries `what`; a contract
 *                                   violation says so and offers NO retry (the
 *                                   same payload fails the same way).
 *  Q4  allLoaded is a product     — one failed part fails the whole composite; one
 *                                   pending part makes it pending; a failure beats
 *                                   a pending sibling; only all-ok yields data.
 *  Q5  allLoaded names every failure — two failed parts name both, because naming
 *                                   one of two is a partial truth.
 *  Q6  actionFailure hides caps   — a 402 belongs to the paywall, so a call site
 *                                   gets `null` and does not double-report it.
 *
 * Blackbox: hand-built `QueryRead` values (the four fields the mapping reads) and
 * the public `LoadState` surface. No component, no client.
 */

import { CapExceededSchema } from "@npmguard/shared";
import { describe, expect, it, vi } from "vitest";
import { failed, loaded, LOADING, type LoadState } from "../components/ui/load-state.ts";
import { ApiError } from "./api-base.ts";
import { actionFailure, allLoaded, toLoadState, type QueryRead } from "./query-state.ts";
import { ContractViolationError } from "./wire.ts";

function read<T>(over: Partial<QueryRead<T>> = {}): QueryRead<T> {
  return {
    data: undefined,
    error: null,
    dataUpdatedAt: 0,
    isRefetchError: false,
    refetch: vi.fn(),
    ...over,
  } as QueryRead<T>;
}

const ENTITLEMENTS = {
  installationId: 7,
  accountLogin: "acme",
  plan: "free" as const,
  subscriptionStatus: "inactive",
  protectedRepos: { used: 1, limit: 1, remaining: 0 },
  publicRepoAudits: { used: 0, limit: 3, remaining: 3 },
  monthlyAudits: { used: 0, limit: 100, remaining: 100 },
};

describe("toLoadState — Q1 three states, three arms", () => {
  it("Q1: a pending query with no data is loading", () => {
    expect(toLoadState(read<string[]>(), "Repositories")).toEqual(LOADING);
  });

  it("Q1: an error with no data is failed, and the failed arm carries no data", () => {
    const state = toLoadState(read<string[]>({ error: new Error("boom") }), "Repositories");
    expect(state.status).toBe("failed");
    // The absence is the guarantee: there is no `data` to render on this arm, so
    // "show the empty state on error" is not expressible.
    expect(state).not.toHaveProperty("data");
  });

  it("Q1: data is ok, and carries the read-succeeded token", () => {
    const state = toLoadState(read({ data: ["a"] }), "Repositories");
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.data).toEqual(["a"]);
    // `EmptyState` demands this token, and only `loaded()` can mint one.
    expect(state.read).toBeDefined();
    expect(state.asOf).toBeUndefined();
  });
});

describe("toLoadState — Q2 data survives a failed refresh", () => {
  it("Q2: data plus a refetch error stays ok, tagged with asOf", () => {
    const at = Date.UTC(2026, 6, 25, 12, 0, 0);
    const state = toLoadState(
      read({ data: ["a"], error: new Error("offline"), isRefetchError: true, dataUpdatedAt: at }),
      "Repositories",
    );
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    // Real data, not current — the third fact, and the signal to pair it with a
    // StaleChip rather than throw the data away or claim it is fresh.
    expect(state.asOf).toBe(new Date(at).toISOString());
  });

  it("Q2: a successful refresh leaves asOf unset, so the chip is not permanent", () => {
    const state = toLoadState(read({ data: ["a"], dataUpdatedAt: 1 }), "Repositories");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.asOf).toBeUndefined();
  });
});

describe("toLoadState — Q3 failures are named", () => {
  it("Q3: an ApiError failure names the subject, the message and the status, and offers a retry", () => {
    const refetch = vi.fn();
    const state = toLoadState(
      read<string[]>({ error: new ApiError(502, { error: "bad gateway" }, "boom"), refetch }),
      "Alerts feed",
    );
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.failure.what).toBe("Alerts feed");
    expect(state.failure.detail).toContain("502");
    expect(state.failure.detail).toContain("bad gateway");
    state.failure.retry?.();
    expect(refetch).toHaveBeenCalled();
  });

  it("Q3: a 404 offers NO retry — the retry button and the retry policy agree", () => {
    const state = toLoadState<string[]>(
      read({ error: new ApiError(404, { error: "Repo not found" }, "not found") }),
      "acme/widget",
    );
    if (state.status !== "failed") throw new Error("unreachable");
    // A Retry that reproduces the same 404 is worse than none, and two policies
    // disagreeing about it is worse still.
    expect(state.failure.retry).toBeUndefined();
    expect(state.failure.what).toBe("acme/widget");
  });

  it("Q3: a contract violation offers NO retry — the same payload fails the same way", () => {
    const state = toLoadState<string[]>(
      read({ error: new ContractViolationError("GET /panel/repos", "repos.0.name: required", {}) }),
      "Repositories",
    );
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.failure.retry).toBeUndefined();
    expect(state.failure.detail).toContain("does not match the contract");
  });
});

describe("allLoaded — Q4 the composite is a product", () => {
  const ok = loaded(["repo"]);

  it("Q4: all parts ok yields the record, with a fresh read token", () => {
    const state = allLoaded({ repos: ok, installs: loaded([1]) });
    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.data).toEqual({ repos: ["repo"], installs: [1] });
    expect(state.read).toBeDefined();
  });

  it("Q4: one pending part makes the composite pending — no partial data escapes", () => {
    const state = allLoaded({ repos: ok, installs: LOADING as LoadState<number[]> });
    expect(state.status).toBe("loading");
    expect(state).not.toHaveProperty("data");
  });

  it("Q4: one failed part fails the composite, keeping that part's name", () => {
    const state = allLoaded({
      repos: ok,
      installs: failed<number[]>({ what: "Your GitHub workspace" }),
    });
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.failure.what).toBe("Your GitHub workspace");
  });

  it("Q4: a failure beats a pending sibling — a spinner over a known failure is a false promise", () => {
    const state = allLoaded({
      repos: LOADING as LoadState<string[]>,
      installs: failed<number[]>({ what: "Your GitHub workspace" }),
    });
    expect(state.status).toBe("failed");
  });

  it("Q4: a stale part makes the composite stale", () => {
    const state = allLoaded({ repos: loaded(["repo"], "2026-07-25T12:00:00.000Z"), installs: loaded([1]) });
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.asOf).toBe("2026-07-25T12:00:00.000Z");
  });
});

describe("allLoaded — Q5 every failure is named", () => {
  it("Q5: two failed parts name both, and one retry fires both", () => {
    const retryA = vi.fn();
    const retryB = vi.fn();
    const state = allLoaded({
      repos: failed<string[]>({ what: "Repositories", detail: "HTTP 502", retry: retryA }),
      alerts: failed<number[]>({ what: "Alerts feed", detail: "HTTP 500", retry: retryB }),
    });
    if (state.status !== "failed") throw new Error("unreachable");
    expect(state.failure.what).toBe("Repositories and Alerts feed");
    expect(state.failure.detail).toContain("HTTP 502");
    expect(state.failure.detail).toContain("HTTP 500");
    state.failure.retry?.();
    expect(retryA).toHaveBeenCalled();
    expect(retryB).toHaveBeenCalled();
  });
});

describe("actionFailure — Q6 caps belong to the paywall", () => {
  it("Q6: a 402 cap yields null, so a call site cannot double-report it", () => {
    const cap = CapExceededSchema.parse({
      error: "Protected-repository limit reached",
      cap: true,
      resource: "protected_repos",
      installationId: 7,
      entitlements: ENTITLEMENTS,
    });
    expect(actionFailure(new ApiError(402, cap, "cap"), "Changing protection")).toBeNull();
  });

  it("Q6: any other error becomes a named Failure", () => {
    const failure = actionFailure(new ApiError(500, { error: "boom" }, "boom"), "Changing protection");
    expect(failure?.what).toBe("Changing protection");
  });

  it("Q6: no error is no failure", () => {
    expect(actionFailure(null, "Changing protection")).toBeNull();
    expect(actionFailure(undefined, "Changing protection")).toBeNull();
  });
});
