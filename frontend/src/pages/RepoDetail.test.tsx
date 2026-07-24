/**
 * RepoDetail page — component-integration test over the /api/panel/repo/:owner/:name
 * boundary (MSW) + the real react-router MemoryRouter + the singleton panel store.
 *
 * Blackbox: every assertion is on rendered output the user sees (the computed
 * posture heading, the counts-rail aria-label, tile values, queue rows, the
 * inventory table + filters, action buttons, the paywall dialog) or on an
 * observable effect (navigation to a sink route, a POST-then-reload, an SSE
 * patch). No implementation details, no captured prose, no animation waits.
 *
 * HONEST-VERDICT invariants pinned here:
 *   - A DANGEROUS dep is NEVER coerced to "No known threats"/SAFE, even when the
 *     scan summary itself reports verdict:"SAFE" (C7).
 *   - A 404 / 500 load is an honest missing/error state, never a fabricated
 *     verdict (C2/C3).
 *   - A pending dep (verdict null) reads as "Coverage incomplete", distinct from
 *     a real SAFE verdict (C9).
 *
 * ── class map ──────────────────────────────────────────────────────────────
 * C1  loading: spinner "Loading repository…" first, then a 200 → ready hero
 * C2  404 → "Repository unavailable" missing state (no fabricated verdict)
 * C3  500 → role=alert error banner + "Try again"
 * C4  overview: running scan → "Scan in progress · N%"
 * C5  overview: scan.status "failed" → "Scan interrupted"
 * C6  overview: no scan & no deps → "Not audited"
 * C7  overview: a DANGEROUS dep → "Action required" (never SAFE, even if scan says SAFE)
 * C8  overview: a SUSPECT dep → "Review recommended"
 * C9  overview: a pending dep → "Coverage incomplete" (pending ≠ verdict)
 * C10 overview: all SAFE → "No known threats"
 * C11 counts rail aria-label enumerates the mix; the 5 tiles show the right numbers
 * C12 review queue with alerts → alert rows; clicking navigates to /package/<name>
 * C13 review queue with NO alerts but flagged deps → dep rows; click navigates
 * C14 review queue is hidden when flagged === 0
 * C15 inventory search narrows the table to matching deps
 * C16 inventory filters (All/Flagged/Direct/Pending) carry counts; Flagged narrows
 * C17 inventory severity sort: a DANGEROUS dep sorts before a SAFE one
 * C18 inventory pagination: >100 deps → "Load 100 more" reveals page two
 * C19 inventory empty deps → "No dependency baseline yet"
 * C20 inventory filter matching nothing → "No dependencies match this view"
 * C21 action: Run audit → POST scan → busy then reload (new dep appears)
 * C22 action: Protect toggle optimistically flips the tag
 * C23 action: a 402 cap on protect opens the paywall, with NO action-error banner
 * C24 action: a non-cap failure shows a role=alert action-error banner (dismissable)
 * C25 action: Re-sync → POST resync → reload
 * C26 running-scan SSE: a dep message patches the matching dep row
 * C27 running-scan SSE: a progress message updates the posture counters
 * C28 running-scan SSE: a done message triggers a full reload
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import {
  renderRoute,
  resetPanelStore,
  authedSeed,
  installMockEventSource,
} from "../test/render.tsx";
import {
  setupPanelServer,
  server,
  http,
  HttpResponse,
  delay,
} from "../test/panel-server.ts";
import {
  makeRepoDetail,
  makeRepo,
  makeScan,
  makeDep,
  dangerousDep,
  pendingDep,
  makeAlert,
  makeCapBody,
} from "../test/panel-fixtures.ts";
import type { RepoDetailResponse } from "../lib/engine-types.ts";
import { RepoDetail } from "./RepoDetail.tsx";

setupPanelServer();

const DETAIL_ROUTE = "/api/panel/repo/:owner/:name";
const ENTRY = { path: "/repo/:owner/:name", entries: ["/repo/octo-org/web-app"] };

let es: ReturnType<typeof installMockEventSource>;

beforeEach(() => {
  resetPanelStore(authedSeed());
  // jsdom has no EventSource; RepoDetail opens a scan stream whenever the scan
  // is running, so install the fake for every test to avoid a ctor crash.
  es = installMockEventSource();
});

afterEach(() => {
  es.restore();
});

/** Register the repo-detail GET to answer one static body. */
function serveDetail(detail: RepoDetailResponse) {
  server.use(http.get(DETAIL_ROUTE, () => HttpResponse.json(detail)));
}

/** Render the page and wait until it leaves the loading phase (hero present). */
async function renderReady(detail: RepoDetailResponse) {
  serveDetail(detail);
  const result = renderRoute(<RepoDetail />, ENTRY);
  await screen.findByRole("region", { name: "Audit posture" });
  return result;
}

function postureHeading() {
  return within(screen.getByRole("region", { name: "Audit posture" })).getByRole("heading", {
    level: 2,
  });
}

// ── phases ──────────────────────────────────────────────────────────────────

describe("RepoDetail — load phases", () => {
  it("C1: shows the loading spinner first, then the ready hero on a 200", async () => {
    serveDetail(makeRepoDetail());
    renderRoute(<RepoDetail />, ENTRY);
    // The initial synchronous render is the loading phase (fetch still pending).
    expect(screen.getByRole("status")).toHaveTextContent(/Loading repository/i);
    await screen.findByRole("region", { name: "Audit posture" });
    expect(postureHeading()).toHaveTextContent("No known threats");
  });

  it("C2: a 404 renders the honest 'Repository unavailable' missing state", async () => {
    server.use(http.get(DETAIL_ROUTE, () => new HttpResponse(null, { status: 404 })));
    renderRoute(<RepoDetail />, ENTRY);
    expect(await screen.findByText("Repository unavailable")).toBeInTheDocument();
    // Honest: no posture hero, no fabricated verdict.
    expect(screen.queryByRole("region", { name: "Audit posture" })).not.toBeInTheDocument();
  });

  it("C3: a 500 renders a role=alert error banner with 'Try again'", async () => {
    server.use(http.get(DETAIL_ROUTE, () => new HttpResponse(null, { status: 500 })));
    renderRoute(<RepoDetail />, ENTRY);
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Audit posture" })).not.toBeInTheDocument();
  });
});

// ── overview posture label ────────────────────────────────────────────────────

describe("RepoDetail — overview posture", () => {
  it("C4: a running scan reads 'Scan in progress · N%'", async () => {
    await renderReady(
      makeRepoDetail({
        scan: makeScan({ status: "running", verdict: null, total: 10, cached: 2, audited: 3, failed: 0 }),
        deps: [pendingDep({ name: "target-pkg", jobState: "running" })],
      }),
    );
    // completed = 2+3+0 = 5 / 10 → 50%
    expect(postureHeading()).toHaveTextContent(/Scan in progress.*50%/);
  });

  it("C5: a failed scan reads 'Scan interrupted'", async () => {
    await renderReady(
      makeRepoDetail({ scan: makeScan({ status: "failed", verdict: null }), deps: [makeDep()] }),
    );
    expect(postureHeading()).toHaveTextContent("Scan interrupted");
  });

  it("C6: no scan and no deps reads 'Not audited'", async () => {
    await renderReady(makeRepoDetail({ scan: null, deps: [] }));
    expect(postureHeading()).toHaveTextContent("Not audited");
  });

  it("C7: a DANGEROUS dep reads 'Action required' and is NEVER coerced to SAFE", async () => {
    // The scan summary itself claims verdict:"SAFE" — the honest posture must
    // still surface the dangerous dependency, not the stale scan verdict.
    await renderReady(
      makeRepoDetail({
        scan: makeScan({ status: "done", verdict: "SAFE" }),
        deps: [dangerousDep()],
      }),
    );
    expect(postureHeading()).toHaveTextContent("Action required");
    // HONEST invariant: dangerous is never labelled safe.
    expect(postureHeading()).not.toHaveTextContent(/No known threats/i);
    expect(postureHeading()).not.toHaveTextContent(/SAFE/i);
  });

  it("C8: a SUSPECT dep reads 'Review recommended'", async () => {
    await renderReady(
      makeRepoDetail({ deps: [makeDep({ name: "grey-pkg", verdict: "SUSPECT" })] }),
    );
    expect(postureHeading()).toHaveTextContent("Review recommended");
  });

  it("C9: a pending dep reads 'Coverage incomplete' (pending ≠ a real verdict)", async () => {
    await renderReady(makeRepoDetail({ deps: [pendingDep()] }));
    expect(postureHeading()).toHaveTextContent("Coverage incomplete");
  });

  it("C9: an UNKNOWN-only repo reads 'Coverage incomplete' and is NEVER coerced to SAFE", async () => {
    // The other arm of the "Coverage incomplete" branch: a dep whose verdict is
    // the real string "UNKNOWN" (not pending/null). UNKNOWN ≠ SAFE — dropping
    // this arm would let an all-UNKNOWN repo fall through to "No known threats",
    // a fabricated clean verdict. flagged === 0 here, so nothing else pins it.
    await renderReady(
      makeRepoDetail({
        scan: makeScan({ status: "done", verdict: "SAFE" }),
        deps: [makeDep({ name: "murky-pkg", verdict: "UNKNOWN" })],
      }),
    );
    expect(postureHeading()).toHaveTextContent("Coverage incomplete");
    // HONEST invariant: an unknown-coverage dep is never labelled safe.
    expect(postureHeading()).not.toHaveTextContent(/No known threats/i);
  });

  it("C10: all-SAFE deps read 'No known threats'", async () => {
    await renderReady(makeRepoDetail({ deps: [makeDep(), makeDep({ name: "safe-2" })] }));
    expect(postureHeading()).toHaveTextContent("No known threats");
  });
});

// ── counts rail + tiles ───────────────────────────────────────────────────────

describe("RepoDetail — counts rail + tiles", () => {
  it("C11: the rail aria-label enumerates the mix and the 5 tiles show the counts", async () => {
    await renderReady(
      makeRepoDetail({
        scan: makeScan({ status: "done", verdict: "SAFE" }),
        deps: [
          dangerousDep({ name: "evil-pkg", version: "6.6.6" }),
          makeDep({ name: "suspect-pkg", version: "2.0.0", verdict: "SUSPECT" }),
          makeDep({ name: "unknown-pkg", version: "3.0.0", verdict: "UNKNOWN" }),
          makeDep({ name: "safe-a", version: "1.0.0", verdict: "SAFE" }),
          makeDep({ name: "safe-b", version: "1.1.0", verdict: "SAFE" }),
          pendingDep({ name: "pending-pkg", version: "0.1.0" }),
        ],
      }),
    );

    const region = screen.getByRole("region", { name: "Audit posture" });
    expect(within(region).getByRole("img")).toHaveAttribute(
      "aria-label",
      "1 dangerous, 1 suspect, 1 unknown, 2 safe, 1 pending",
    );

    const tileValue = (label: string) => {
      const tile = within(region).getByText(label).closest(".panel-tile");
      expect(tile).not.toBeNull();
      return tile as HTMLElement;
    };
    expect(within(tileValue("Dangerous")).getByText("1")).toBeInTheDocument();
    expect(within(tileValue("Suspect")).getByText("1")).toBeInTheDocument();
    expect(within(tileValue("Unknown")).getByText("1")).toBeInTheDocument();
    expect(within(tileValue("Safe")).getByText("2")).toBeInTheDocument();
    expect(within(tileValue("Pending")).getByText("1")).toBeInTheDocument();
  });
});

// ── review queue ──────────────────────────────────────────────────────────────

describe("RepoDetail — review queue", () => {
  it("C12: with alerts present it lists alert rows; a click navigates to /package/<name>", async () => {
    await renderReady(
      makeRepoDetail({
        deps: [dangerousDep({ name: "evil-pkg", version: "6.6.6" })], // makes flagged > 0
        alerts: [makeAlert({ packageName: "malware-x", version: "9.9.9", verdict: "DANGEROUS" })],
      }),
    );
    const queue = screen.getByRole("region", { name: "Review queue" });
    const row = within(queue).getByText("malware-x@9.9.9");
    expect(within(queue).getByText("DANGEROUS")).toBeInTheDocument();

    fireEvent.click(row.closest("button") as HTMLElement);
    expect(await screen.findByTestId("route-package")).toBeInTheDocument();
  });

  it("C13: with NO alerts but flagged deps it falls back to dep rows; a click navigates", async () => {
    await renderReady(
      makeRepoDetail({
        deps: [dangerousDep({ name: "evil-pkg", version: "6.6.6" })],
        alerts: [],
      }),
    );
    const queue = screen.getByRole("region", { name: "Review queue" });
    const row = within(queue).getByText("evil-pkg@6.6.6");

    fireEvent.click(row.closest("button") as HTMLElement);
    expect(await screen.findByTestId("route-package")).toBeInTheDocument();
  });

  it("C14: the review queue is hidden when nothing is flagged", async () => {
    await renderReady(makeRepoDetail({ deps: [makeDep()], alerts: [] }));
    expect(screen.queryByRole("region", { name: "Review queue" })).not.toBeInTheDocument();
  });
});

// ── dependency inventory ──────────────────────────────────────────────────────

describe("RepoDetail — dependency inventory", () => {
  it("C15: the search box narrows the table to matching deps", async () => {
    await renderReady(
      makeRepoDetail({
        deps: [
          makeDep({ name: "alpha-lib", version: "1.0.0" }),
          makeDep({ name: "beta-lib", version: "2.0.0" }),
        ],
      }),
    );
    const inv = screen.getByRole("region", { name: "Dependency inventory" });
    expect(within(inv).getByText("alpha-lib")).toBeInTheDocument();
    expect(within(inv).getByText("beta-lib")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search dependencies"), { target: { value: "alpha" } });
    await waitFor(() => expect(within(inv).queryByText("beta-lib")).not.toBeInTheDocument());
    expect(within(inv).getByText("alpha-lib")).toBeInTheDocument();
  });

  it("C16: the filters carry counts and 'Flagged' narrows to flagged deps", async () => {
    await renderReady(
      makeRepoDetail({
        deps: [
          dangerousDep({ name: "evil", version: "6.6.6", direct: true }),
          makeDep({ name: "safe1", version: "1.0.0", direct: true, verdict: "SAFE" }),
          makeDep({ name: "safe2", version: "1.1.0", direct: false, verdict: "SAFE" }),
          pendingDep({ name: "pend", version: "0.1.0", direct: true }),
        ],
      }),
    );
    const group = screen.getByRole("group", { name: "Filter dependencies" });
    expect(within(group).getByRole("button", { name: "All 4" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Flagged 1" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Direct 3" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Pending 1" })).toBeInTheDocument();

    const inv = screen.getByRole("region", { name: "Dependency inventory" });
    fireEvent.click(within(group).getByRole("button", { name: "Flagged 1" }));
    await waitFor(() => expect(within(inv).queryByText("safe1")).not.toBeInTheDocument());
    expect(within(inv).getByText("evil")).toBeInTheDocument();
  });

  it("C17: severity sort places a DANGEROUS dep before a SAFE one", async () => {
    // Names chosen so alphabetical order (zzz > aaa) would REVERSE the rows —
    // proving the ordering is by severity, not by name.
    await renderReady(
      makeRepoDetail({
        deps: [
          makeDep({ name: "aaa-safe", version: "1.0.0", verdict: "SAFE" }),
          dangerousDep({ name: "zzz-danger", version: "6.6.6" }),
        ],
      }),
    );
    const inv = screen.getByRole("region", { name: "Dependency inventory" });
    const rows = within(inv).getAllByRole("row");
    // rows[0] is the header; first data row must be the dangerous dep.
    expect(rows[1]).toHaveTextContent("zzz-danger");
    expect(rows[2]).toHaveTextContent("aaa-safe");
  });

  it("C18: with >100 deps a 'Load 100 more' button reveals page two", async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      makeDep({ name: `dep-${String(i).padStart(3, "0")}`, version: "1.0.0", direct: true, verdict: "SAFE" }),
    );
    await renderReady(makeRepoDetail({ deps: many }));
    const inv = screen.getByRole("region", { name: "Dependency inventory" });

    expect(within(inv).getByText("dep-000")).toBeInTheDocument();
    expect(within(inv).queryByText("dep-149")).not.toBeInTheDocument();

    fireEvent.click(within(inv).getByRole("button", { name: "Load 100 more" }));
    expect(await within(inv).findByText("dep-149")).toBeInTheDocument();
    expect(within(inv).queryByRole("button", { name: "Load 100 more" })).not.toBeInTheDocument();
  });

  it("C19: empty deps render 'No dependency baseline yet'", async () => {
    await renderReady(makeRepoDetail({ deps: [] }));
    const inv = screen.getByRole("region", { name: "Dependency inventory" });
    expect(within(inv).getByText("No dependency baseline yet")).toBeInTheDocument();
  });

  it("C20: a filter matching nothing renders 'No dependencies match this view'", async () => {
    await renderReady(makeRepoDetail({ deps: [makeDep({ name: "only-safe", verdict: "SAFE" })] }));
    const group = screen.getByRole("group", { name: "Filter dependencies" });
    fireEvent.click(within(group).getByRole("button", { name: "Flagged 0" }));
    expect(await screen.findByText("No dependencies match this view")).toBeInTheDocument();
  });
});

// ── actions ───────────────────────────────────────────────────────────────────

describe("RepoDetail — actions", () => {
  it("C21: Run audit POSTs a scan, shows busy, then reloads the detail", async () => {
    let calls = 0;
    server.use(
      http.get(DETAIL_ROUTE, () => {
        calls += 1;
        return HttpResponse.json(
          makeRepoDetail({
            scan: makeScan({ status: "done", verdict: "SAFE" }),
            deps: calls === 1 ? [makeDep()] : [dangerousDep()],
          }),
        );
      }),
      http.post("/api/panel/repo/:repoId/scan", async () => {
        await delay(10);
        return HttpResponse.json({ scanId: 6001 });
      }),
    );
    renderRoute(<RepoDetail />, ENTRY);
    await screen.findByRole("region", { name: "Audit posture" });
    expect(postureHeading()).toHaveTextContent("No known threats");

    fireEvent.click(screen.getByRole("button", { name: "Run audit again" }));
    // Busy → the reload replaces the deps → the reloaded detail is DANGEROUS.
    await waitFor(() => expect(postureHeading()).toHaveTextContent("Action required"));
  });

  it("C22: the Protect toggle optimistically flips the tag", async () => {
    server.use(
      http.get(DETAIL_ROUTE, () =>
        HttpResponse.json(makeRepoDetail({ repo: makeRepo({ protected: false }) })),
      ),
      http.post("/api/panel/repo/:repoId/protect", () => HttpResponse.json({ ok: true })),
    );
    renderRoute(<RepoDetail />, ENTRY);
    await screen.findByRole("region", { name: "Audit posture" });
    expect(screen.getByText("Manual monitoring")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Protect" }));
    expect(await screen.findByText("Continuous protection")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protected" })).toBeInTheDocument();
  });

  it("C23: a 402 cap on protect opens the paywall with NO action-error banner", async () => {
    server.use(
      http.get(DETAIL_ROUTE, () =>
        HttpResponse.json(makeRepoDetail({ repo: makeRepo({ protected: false }) })),
      ),
      http.post("/api/panel/repo/:repoId/protect", () =>
        HttpResponse.json(makeCapBody("protected_repos"), { status: 402 }),
      ),
    );
    renderRoute(<RepoDetail />, ENTRY);
    await screen.findByRole("region", { name: "Audit posture" });

    fireEvent.click(screen.getByRole("button", { name: "Protect" }));
    expect(await screen.findByRole("dialog", { name: "Upgrade to Pro" })).toBeInTheDocument();
    // The cap must NOT masquerade as a plain action error, and must NOT flip the tag.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Protect" })).toBeInTheDocument();
    expect(screen.queryByText("Continuous protection")).not.toBeInTheDocument();
  });

  it("C24: a non-cap failure shows a dismissable role=alert action-error banner", async () => {
    server.use(
      http.get(DETAIL_ROUTE, () =>
        HttpResponse.json(makeRepoDetail({ repo: makeRepo({ protected: false }) })),
      ),
      http.post("/api/panel/repo/:repoId/protect", () => new HttpResponse(null, { status: 500 })),
    );
    renderRoute(<RepoDetail />, ENTRY);
    await screen.findByRole("region", { name: "Audit posture" });

    fireEvent.click(screen.getByRole("button", { name: "Protect" }));
    const banner = await screen.findByRole("alert");
    expect(screen.queryByRole("dialog", { name: "Upgrade to Pro" })).not.toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: "Dismiss error" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("C25: Re-sync POSTs a resync then reloads the detail", async () => {
    let calls = 0;
    server.use(
      http.get(DETAIL_ROUTE, () => {
        calls += 1;
        return HttpResponse.json(
          makeRepoDetail({
            scan: makeScan({ status: "done", verdict: "SAFE" }),
            deps: calls === 1 ? [makeDep()] : [dangerousDep()],
          }),
        );
      }),
      http.post("/api/panel/repo/:repoId/resync", () => HttpResponse.json({ scanId: 7001 })),
    );
    renderRoute(<RepoDetail />, ENTRY);
    await screen.findByRole("region", { name: "Audit posture" });
    expect(postureHeading()).toHaveTextContent("No known threats");

    fireEvent.click(screen.getByRole("button", { name: /Re-sync/ }));
    await waitFor(() => expect(postureHeading()).toHaveTextContent("Action required"));
  });
});

// ── running-scan SSE ──────────────────────────────────────────────────────────

describe("RepoDetail — running-scan SSE", () => {
  const runningDetail = (over: Partial<RepoDetailResponse> = {}) =>
    makeRepoDetail({
      scan: makeScan({ status: "running", verdict: null, total: 10, cached: 2, audited: 3, failed: 0 }),
      deps: [pendingDep({ name: "target-pkg", version: "1.0.0", jobState: "running" })],
      ...over,
    });

  it("C26: a dep SSE message patches the matching dep row", async () => {
    await renderReady(runningDetail());
    const inv = screen.getByRole("region", { name: "Dependency inventory" });
    // Before: the pending dep shows the "Auditing" (running) status pill.
    expect(within(within(inv).getByText("target-pkg").closest("tr") as HTMLElement).getByText("Auditing")).toBeInTheDocument();

    await act(async () => {
      es.last()?.emit({
        type: "dep",
        name: "target-pkg",
        version: "1.0.0",
        verdict: "DANGEROUS",
        verdictReason: "postinstall exfiltrates env",
        evidenceCount: 3,
        jobState: null,
      });
    });

    const row = within(inv).getByText("target-pkg").closest("tr") as HTMLElement;
    expect(within(row).getByText("DANGEROUS")).toBeInTheDocument();
  });

  it("C27: a progress SSE message updates the posture counters", async () => {
    await renderReady(runningDetail());
    expect(postureHeading()).toHaveTextContent(/Scan in progress.*50%/); // 5/10

    await act(async () => {
      es.last()?.emit({
        type: "progress",
        status: "running",
        total: 10,
        cached: 5,
        audited: 4,
        failed: 0,
      });
    });
    // completed = 9/10 → 90%
    await waitFor(() => expect(postureHeading()).toHaveTextContent(/Scan in progress.*90%/));
  });

  it("C28: a done SSE message triggers a full reload", async () => {
    let calls = 0;
    server.use(
      http.get(DETAIL_ROUTE, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(runningDetail())
          : HttpResponse.json(
              makeRepoDetail({
                scan: makeScan({ status: "done", verdict: "SAFE" }),
                deps: [makeDep({ name: "target-pkg", version: "1.0.0", verdict: "SAFE" })],
              }),
            );
      }),
    );
    renderRoute(<RepoDetail />, ENTRY);
    await screen.findByRole("region", { name: "Audit posture" });
    expect(postureHeading()).toHaveTextContent(/Scan in progress/);

    await act(async () => {
      es.last()?.emit({ type: "done" });
    });
    await waitFor(() => expect(postureHeading()).toHaveTextContent("No known threats"));
  });
});
