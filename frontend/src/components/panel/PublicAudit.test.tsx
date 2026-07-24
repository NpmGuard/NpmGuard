/**
 * Public-repo-audit story — three related components:
 *   PublicAuditHistory   (list of recent public snapshots)
 *   PublicAuditDialog    (start a read-only public repo scan)
 *   PublicAuditReportDialog (fetch + poll + render a snapshot report)
 *
 * Blackbox: rendered output + observable effects (onOpen/onStarted callbacks,
 * store.paywall, store.publicScanError, fetch calls via MSW). Honest-verdict
 * invariants are pinned: a DANGEROUS rollup is never coerced to SAFE; a running
 * scan is pending (no verdict), distinct from a real verdict; an empty lockfile
 * is an honest empty-state.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderRoute, resetPanelStore, authedSeed } from "../../test/render.tsx";
import {
  setupPanelServer,
  useHappyPanel,
  server,
  http,
  HttpResponse,
} from "../../test/panel-server.ts";
import {
  makeBilling,
  makeCapBody,
  makePublicScan,
  makePublicScanDep,
  makePublicScanDetail,
  makeRollup,
} from "../../test/panel-fixtures.ts";
import { usePanelStore } from "../../stores/panelStore.ts";
import { PublicAuditHistory } from "./PublicAuditHistory.tsx";
import { PublicAuditDialog } from "./PublicAuditDialog.tsx";
import { PublicAuditReportDialog } from "./PublicAuditReportDialog.tsx";

setupPanelServer();
beforeEach(() => resetPanelStore());

// ══════════════════════════════════════════════════════════════════════════
// PublicAuditHistory — prop { scans, onOpen }
// Class map:
//   H1: empty scans → renders nothing (no section)
//   H2: a done scan → verdict pill + "Report" affordance + rollup counts row
//   H3: a running scan → "Scanning" progress meter, NO verdict pill (pending
//       is distinct from a verdict), "View progress" affordance
//   H4: clicking a row's name button → onOpen(scanId)
// ══════════════════════════════════════════════════════════════════════════
describe("PublicAuditHistory", () => {
  it("H1: empty scans render no section at all", () => {
    renderRoute(<PublicAuditHistory scans={[]} onOpen={vi.fn()} />);
    expect(
      screen.queryByLabelText("Public repository audits"),
    ).not.toBeInTheDocument();
  });

  it("H2: a done scan shows its verdict pill and rollup counts", () => {
    const scan = makePublicScan({
      status: "done",
      total: 20,
      cached: 15,
      failed: 0,
      rollup: makeRollup({ verdict: "SAFE", safe: 20 }),
    });
    renderRoute(<PublicAuditHistory scans={[scan]} onOpen={vi.fn()} />);

    expect(screen.getByText("SAFE")).toBeInTheDocument();
    expect(
      screen.getByText("20 packages · 15 cached · 0 unresolved"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report" })).toBeInTheDocument();
  });

  it("H3: a running scan shows progress and NO verdict pill (pending is honest)", () => {
    const scan = makePublicScan({
      owner: "acme",
      name: "live-lib",
      fullName: "acme/live-lib",
      status: "running",
      total: 20,
      cached: 5,
      audited: 2,
      failed: 0,
      finishedAt: null,
    });
    renderRoute(<PublicAuditHistory scans={[scan]} onOpen={vi.fn()} />);

    expect(screen.getByText("Scanning")).toBeInTheDocument();
    expect(screen.getByText("7/20")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar", {
      name: "Scan progress for acme/live-lib",
    });
    expect(meter).toHaveAttribute("aria-valuenow", "7");
    expect(
      screen.getByRole("button", { name: "View progress" }),
    ).toBeInTheDocument();
    // A running scan is NOT a verdict — no SAFE/DANGEROUS pill is fabricated.
    expect(screen.queryByText("SAFE")).not.toBeInTheDocument();
    expect(screen.queryByText("DANGEROUS")).not.toBeInTheDocument();
  });

  it("H4: clicking a row's name button calls onOpen with the scan id", async () => {
    const onOpen = vi.fn();
    const scan = makePublicScan({ id: 777, owner: "acme", name: "widget" });
    renderRoute(<PublicAuditHistory scans={[scan]} onOpen={onOpen} />);

    fireEvent.click(screen.getByRole("button", { name: "acme/widget" }));
    expect(onOpen).toHaveBeenCalledWith(777);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PublicAuditDialog — store-driven; starts a public repo scan
//   POST /api/panel/public-repos/scan
// Class map (all seeded authed with a billing account so the allowance select
// has an installationId):
//   D1: 201 {scanId} success → onStarted(scanId), no error
//   D2: 402 cap → opens the paywall (store.paywall set), onStarted NOT called
//   D3: 500 generic error → publicScanError banner (role=alert), no onStarted
//   D4: 409 {scanId} "already running" → treated as SUCCESS: onStarted(scanId)
//   D5: empty repository input → submit is a no-op (button disabled)
// ══════════════════════════════════════════════════════════════════════════
describe("PublicAuditDialog", () => {
  const seedAuthed = () =>
    resetPanelStore(authedSeed({ billing: makeBilling() }));

  const REPO_INPUT = "github.com/owner/repository";

  it("D1: a 201 {scanId} start calls onStarted with that id and shows no error", async () => {
    useHappyPanel({ billing: makeBilling() });
    server.use(
      http.post("/api/panel/public-repos/scan", () =>
        HttpResponse.json({ scanId: 4242 }, { status: 201 }),
      ),
    );
    seedAuthed();
    const onStarted = vi.fn();
    renderRoute(<PublicAuditDialog onClose={vi.fn()} onStarted={onStarted} />);

    fireEvent.change(screen.getByPlaceholderText(REPO_INPUT), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Audit snapshot" }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(4242));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(usePanelStore.getState().paywall).toBeNull();
  });

  it("D2: a 402 cap opens the paywall and does NOT report a start", async () => {
    useHappyPanel({ billing: makeBilling() });
    server.use(
      http.post("/api/panel/public-repos/scan", () =>
        HttpResponse.json(makeCapBody("public_repo_audits"), { status: 402 }),
      ),
    );
    seedAuthed();
    const onStarted = vi.fn();
    renderRoute(<PublicAuditDialog onClose={vi.fn()} onStarted={onStarted} />);

    fireEvent.change(screen.getByPlaceholderText(REPO_INPUT), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Audit snapshot" }));

    await waitFor(() => expect(usePanelStore.getState().paywall).not.toBeNull());
    expect(usePanelStore.getState().paywall?.resource).toBe("public_repo_audits");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("D3: a 500 error surfaces an honest error banner and no start", async () => {
    useHappyPanel({ billing: makeBilling() });
    server.use(
      http.post("/api/panel/public-repos/scan", () =>
        HttpResponse.json({ error: "engine exploded" }, { status: 500 }),
      ),
    );
    seedAuthed();
    const onStarted = vi.fn();
    renderRoute(<PublicAuditDialog onClose={vi.fn()} onStarted={onStarted} />);

    fireEvent.change(screen.getByPlaceholderText(REPO_INPUT), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Audit snapshot" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("engine exploded");
    expect(onStarted).not.toHaveBeenCalled();
    expect(usePanelStore.getState().paywall).toBeNull();
  });

  it("D4: a 409 {scanId} 'already running' is treated as a successful start", async () => {
    useHappyPanel({ billing: makeBilling() });
    server.use(
      http.post("/api/panel/public-repos/scan", () =>
        HttpResponse.json(
          { error: "Scan already running", scanId: 3001 },
          { status: 409 },
        ),
      ),
    );
    seedAuthed();
    const onStarted = vi.fn();
    renderRoute(<PublicAuditDialog onClose={vi.fn()} onStarted={onStarted} />);

    fireEvent.change(screen.getByPlaceholderText(REPO_INPUT), {
      target: { value: "owner/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Audit snapshot" }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(3001));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(usePanelStore.getState().paywall).toBeNull();
  });

  it("D5: an empty repository keeps the submit disabled (no POST, no start)", async () => {
    let posted = false;
    useHappyPanel({ billing: makeBilling() });
    server.use(
      http.post("/api/panel/public-repos/scan", () => {
        posted = true;
        return HttpResponse.json({ scanId: 1 }, { status: 201 });
      }),
    );
    seedAuthed();
    const onStarted = vi.fn();
    renderRoute(<PublicAuditDialog onClose={vi.fn()} onStarted={onStarted} />);

    const submit = screen.getByRole("button", { name: "Audit snapshot" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(posted).toBe(false);
    expect(onStarted).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PublicAuditReportDialog — prop { scanId, onClose }
//   GET /api/panel/public-repos/:scanId (self-polls while running)
// Class map:
//   R1: a done SAFE snapshot → rollup summary + dependency rows + SAFE verdict
//   R2: a done DANGEROUS snapshot → DANGEROUS pill, never coerced to SAFE
//   R3: dependenciesTruncated → the truncation notice
//   R4: a running snapshot → "Running" pill + progress meter (pending, honest)
//   R5: an empty lockfile → honest "No npm dependencies" empty-state
//   R6: clicking Close calls onClose
// ══════════════════════════════════════════════════════════════════════════
describe("PublicAuditReportDialog", () => {
  const detailRoute = (detail: ReturnType<typeof makePublicScanDetail>) =>
    server.use(
      http.get("/api/panel/public-repos/:scanId", () => HttpResponse.json(detail)),
    );

  it("R1: a done SAFE snapshot renders the rollup and its dependency rows", async () => {
    detailRoute(
      makePublicScanDetail({
        scan: makePublicScan({
          fullName: "some-org/public-lib",
          status: "done",
          total: 20,
          rollup: makeRollup({ verdict: "SAFE", safe: 20 }),
        }),
        dependencies: [makePublicScanDep({ name: "chalk", version: "5.6.2" })],
      }),
    );
    renderRoute(<PublicAuditReportDialog scanId={3001} onClose={vi.fn()} />);

    expect(
      await screen.findByRole("heading", { name: "some-org/public-lib" }),
    ).toBeInTheDocument();
    expect(screen.getByText("chalk@5.6.2")).toBeInTheDocument();
    expect(screen.getByText("Packages")).toBeInTheDocument();
    // Verdict pills (header rollup + dep row) — both SAFE, honest.
    expect(screen.getAllByText("SAFE").length).toBeGreaterThanOrEqual(1);
  });

  it("R2: a done DANGEROUS snapshot renders DANGEROUS and never a SAFE verdict", async () => {
    detailRoute(
      makePublicScanDetail({
        scan: makePublicScan({
          fullName: "some-org/risky",
          status: "done",
          rollup: makeRollup({ verdict: "DANGEROUS", dangerous: 1, safe: 19 }),
        }),
        dependencies: [
          makePublicScanDep({
            name: "evil-pkg",
            version: "6.6.6",
            verdict: "DANGEROUS",
            reason: "postinstall exfiltrates env",
          }),
        ],
      }),
    );
    renderRoute(<PublicAuditReportDialog scanId={9} onClose={vi.fn()} />);

    await screen.findByRole("heading", { name: "some-org/risky" });
    expect(screen.getAllByText("DANGEROUS").length).toBeGreaterThanOrEqual(1);
    // Honest-verdict invariant: no SAFE pill is fabricated for a dangerous scan.
    expect(screen.queryByText("SAFE")).not.toBeInTheDocument();
  });

  it("R3: a truncated dependency list shows the truncation notice", async () => {
    detailRoute(
      makePublicScanDetail({
        scan: makePublicScan({ status: "done" }),
        dependenciesTruncated: true,
        dependencies: [makePublicScanDep()],
      }),
    );
    renderRoute(<PublicAuditReportDialog scanId={5} onClose={vi.fn()} />);

    expect(
      await screen.findByText(/highest-priority dependencies/i),
    ).toBeInTheDocument();
  });

  it("R4: a running snapshot shows a Running pill and progress (pending, not a verdict)", async () => {
    detailRoute(
      makePublicScanDetail({
        scan: makePublicScan({
          fullName: "some-org/in-flight",
          status: "running",
          total: 20,
          cached: 5,
          audited: 2,
          failed: 0,
          finishedAt: null,
        }),
      }),
    );
    renderRoute(<PublicAuditReportDialog scanId={11} onClose={vi.fn()} />);

    await screen.findByRole("heading", { name: "some-org/in-flight" });
    expect(screen.getByText("Running")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar", { name: "Snapshot progress" });
    expect(meter).toHaveAttribute("aria-valuenow", "7");
    expect(screen.getByText("7/20 resolved")).toBeInTheDocument();
  });

  it("R5: an empty lockfile renders an honest empty-state", async () => {
    detailRoute(
      makePublicScanDetail({
        scan: makePublicScan({ status: "done" }),
        dependencies: [],
      }),
    );
    renderRoute(<PublicAuditReportDialog scanId={3} onClose={vi.fn()} />);

    expect(
      await screen.findByText("No npm dependencies in this lockfile."),
    ).toBeInTheDocument();
  });

  it("R7: a failed detail fetch surfaces an honest error banner and fabricates no verdict", async () => {
    server.use(
      http.get("/api/panel/public-repos/:scanId", () =>
        HttpResponse.json({ error: "snapshot fetch failed" }, { status: 500 }),
      ),
    );
    renderRoute(<PublicAuditReportDialog scanId={42} onClose={vi.fn()} />);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("snapshot fetch failed");
    // Honest invariant: an errored load renders no rollup and no fabricated verdict.
    expect(screen.queryByText("SAFE")).not.toBeInTheDocument();
    expect(screen.queryByText("DANGEROUS")).not.toBeInTheDocument();
    expect(screen.queryByText("Packages")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Loading snapshot" }),
    ).toBeInTheDocument();
  });

  it("R6: clicking Close calls onClose", async () => {
    detailRoute(makePublicScanDetail({ scan: makePublicScan({ status: "done" }) }));
    const onClose = vi.fn();
    renderRoute(<PublicAuditReportDialog scanId={3001} onClose={onClose} />);

    await screen.findByRole("heading", { name: "some-org/public-lib" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
