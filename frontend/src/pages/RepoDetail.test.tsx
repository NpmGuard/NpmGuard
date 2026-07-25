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

beforeAll(() => {
  useAbsoluteApiBase();
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  clearAbsoluteApiBase();
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
    // Never the empty-state box it used to be: "no dependencies" and "we could
    // not see this repository" must not look the same.
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
