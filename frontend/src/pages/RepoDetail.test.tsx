/**
 * Component: the repo detail page's load states — pages/RepoDetail.tsx.
 *
 * The page's four hand-rolled phases (`"loading" | "ready" | "missing" |
 * "error"`) plus a `loadError` string are gone; the read's own state is the
 * authority. What has to survive that change is the DISTINCTION the phases
 * encoded, and in particular that a repo we cannot see never renders as a repo
 * with nothing in it.
 *
 * Input classes:
 *  T1  404 → degraded, with a way out and NO retry — the App has lost access or the
 *                                     repo is gone. Retrying reproduces it, so no
 *                                     dead button is offered; "Back to dashboard" is.
 *  T2  5xx → degraded, WITH a retry — the one class of failure another attempt can
 *                                     answer differently.
 *  T3  ok → the inventory renders    — and the dependency count comes from the set's
 *                                     server-side rollup, not a client recount.
 *  T4  ok with zero deps → EMPTY, not degraded — "no dependency baseline yet" is a
 *                                     claim only a successful read can support.
 *
 *  T5  a failed read reaches NO empty state and NO posture claim. The page has a
 *                                     second `EmptyState` (the "nothing matches this
 *                                     filter" branch) and a `SeverityRibbon`, and each
 *                                     is a way to look confident over data that was
 *                                     never read.
 *  T6  the PENDING part of the posture is hatched, never coloured, and the page says
 *                                     so in words. Painting pending BLUE is how a
 *                                     half-finished scan reads as a settled posture —
 *                                     §2.2 rule 2 makes the progress axis achromatic
 *                                     for exactly this.
 *
 * Blackbox: msw at the boundary, assertions on the accessibility tree and the
 * `data-state` markers.
 */

import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Route, Routes } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  auditSet,
  clearAbsoluteApiBase,
  panelRepo,
  renderWithClient,
  useAbsoluteApiBase,
} from "../lib/test-harness.tsx";
import { RepoDetail } from "./RepoDetail.tsx";

const server = setupServer();

/** jsdom implements no `EventSource`, and a RUNNING set makes the page open the
 * progress stream — so without this the T6 cases die in `connectScanStream` with
 * `ReferenceError: EventSource is not defined` and the failure reads like a
 * component bug. `lib/sse.ts` accepts an injected ctor, but `useRepoDetailStream`
 * does not thread one through, so the global is the only seam from out here.
 *
 * Inert on purpose: T6 is about how a running set is DRAWN, and driving frames
 * through it would be testing the stream reducer, which `lib/sse.test.ts` and
 * `features/repos/hooks.test.tsx` already own. */
class InertEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  // A plain field, not a parameter property: `erasableSyntaxOnly` is on, and a
  // parameter property is the one class syntax that cannot be erased.
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  close(): void {}
}

const realEventSource = globalThis.EventSource;

beforeAll(() => {
  useAbsoluteApiBase();
  globalThis.EventSource = InertEventSource as unknown as typeof EventSource;
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  clearAbsoluteApiBase();
  globalThis.EventSource = realEventSource;
});

const DEP = {
  name: "left-pad",
  version: "1.3.0",
  direct: true,
  range: "^1.3.0",
  outcome: "DANGEROUS" as const,
  verdictReason: "Credential exfiltration confirmed",
  evidenceCount: 3,
  auditedAt: "2026-07-25T11:04:00.000Z",
  jobState: null,
  cached: false,
};

/** The page reads `:owner/:name` from the router, and its query is `enabled` on
 * them being non-empty — so the route has to be real, not just the component. */
function renderDetail() {
  return renderWithClient(
    <Routes>
      <Route path="/repo/:owner/:name" element={<RepoDetail />} />
    </Routes>,
    { initialEntries: ["/repo/acme/widget"] },
  );
}

function respondWith(body: Record<string, unknown>, status = 200) {
  server.use(http.get("/api/panel/repo/:owner/:name", () => HttpResponse.json(body, { status })));
}

describe("RepoDetail — T1 a 404 is a failed read with a way out", () => {
  it("T1: renders the degraded surface, names the read, and offers no dead retry", async () => {
    respondWith({ error: "Repo not found" }, 404);
    renderDetail();

    const surface = await screen.findByRole("alert");
    expect(surface).toHaveAttribute("data-degraded", "surface");
    // Never an empty-state box: "no dependencies" and "we could not see this
    // repository" must not look the same.
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Back to dashboard/ })).toBeInTheDocument();
  });
});

describe("RepoDetail — T2 a 5xx is a failed read worth retrying", () => {
  it("T2: renders the degraded surface WITH a retry", async () => {
    respondWith({ error: "upstream" }, 502);
    renderDetail();

    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});

describe("RepoDetail — T3/T4 a successful read", () => {
  it("T3: renders the inventory from the set's own rollup", async () => {
    respondWith({
      repo: panelRepo({ lastScan: auditSet() }),
      set: auditSet({
        rollup: {
          outcome: "DANGEROUS",
          total: 1,
          safe: 0,
          dangerous: 1,
          error: 0,
          pending: 0,
          cached: 0,
        },
      }),
      depsTruncated: false,
      deps: [DEP],
      alerts: [],
    });
    renderDetail();

    expect(await screen.findByText("Action required")).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 dependencies checked/)).toBeInTheDocument();
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });

  it("T4: a repo with no scan renders the empty baseline copy, not a degraded state", async () => {
    respondWith({
      repo: panelRepo({ lastScan: null }),
      set: null,
      depsTruncated: false,
      deps: [],
      alerts: [],
    });
    renderDetail();

    expect(await screen.findByText("Not audited")).toBeInTheDocument();
    expect(screen.getByText(/No dependency baseline yet/)).toBeInTheDocument();
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });
});

describe("RepoDetail — T5 a failed read claims nothing", () => {
  it("T5: no empty state and no posture is rendered over a read that failed", async () => {
    respondWith({ error: "upstream" }, 502);
    renderDetail();

    await screen.findByRole("alert");
    // Neither of the page's two empty states. "No dependency baseline yet" would
    // be a claim about this repository's lockfile from a read that never returned
    // one, and "no dependencies match this view" would be a claim about a filter
    // over rows we do not have.
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    expect(screen.queryByText(/No dependency baseline yet/)).toBeNull();
    expect(screen.queryByText(/No dependencies match this view/)).toBeNull();
    // And no posture: a ribbon over zeroes is a chart of an unknown denominator,
    // which reads as "nothing wrong here".
    expect(screen.queryByText("No known threats")).toBeNull();
    expect(screen.queryByRole("group", { name: "Audit posture" })).toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });

  it("T5: an unaudited repo draws no posture bar either", async () => {
    // The neighbouring case, and the reason the ribbon is guarded on a population
    // rather than rendered always: `SeverityRibbon`'s own all-zero fallback is a
    // bare hatched bar, and a bar with no numbers beside "Not audited" invites the
    // reader to interpret a texture. The honest rendering of no data is no bar.
    respondWith({
      repo: panelRepo({ lastScan: null }),
      set: null,
      depsTruncated: false,
      deps: [],
      alerts: [],
    });
    renderDetail();

    await screen.findByText("Not audited");
    expect(document.querySelector("[data-segment]")).toBeNull();
  });
});

describe("RepoDetail — T6 progress is never a verdict", () => {
  const RUNNING_SET = auditSet({
    status: "running",
    finishedAt: null,
    rollup: { outcome: null, total: 20, safe: 5, dangerous: 0, error: 0, pending: 15, cached: 2 },
  });

  it("T6: the pending segment is hatched and carries no outcome hue", async () => {
    respondWith({
      repo: panelRepo({ lastScan: RUNNING_SET }),
      set: RUNNING_SET,
      depsTruncated: false,
      deps: [],
      alerts: [],
    });
    renderDetail();

    await screen.findByText(/Scan in progress/);
    const pending = document.querySelector("[data-segment='pending']");
    expect(pending).not.toBeNull();
    // The one property that stops an in-flight scan reading as green. The rail this
    // replaced used `--running` blue here, which is both a hue on the progress axis
    // (§2.2 forbids it) and one that failed the §2.3 colourblind separation check
    // against error-violet.
    expect(pending?.getAttribute("style")).toMatch(/repeating-linear-gradient/);
    expect(pending?.className).not.toMatch(/safe|danger|error/);
  });

  it("T6: the page says in words that the posture may still change", async () => {
    respondWith({
      repo: panelRepo({ lastScan: RUNNING_SET }),
      set: RUNNING_SET,
      depsTruncated: false,
      deps: [],
      alerts: [],
    });
    renderDetail();

    // Texture is not a sentence. §4.2 puts this line under the ribbon precisely so
    // the progress axis states its own incompleteness rather than relying on a
    // reader to decode a hatch — and it survives greyscale, print and no-CSS.
    expect(await screen.findByText(/still running — posture may change/)).toBeInTheDocument();
    // 5 of 20 safe so far, and the page must not round that up to a verdict.
    expect(screen.queryByText("No known threats")).toBeNull();
  });
});
