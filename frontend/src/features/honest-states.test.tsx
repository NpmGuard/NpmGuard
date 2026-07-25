/**
 * Component: empty vs degraded vs refused, across the recomposed feature
 * components.
 *
 * Every no-content call site is a fresh opportunity for the bug class this
 * codebase exists to have killed — a failed read rendering as an absence of
 * threats — so the guarantee is pinned at each one rather than assumed.
 * `Dashboard.test.tsx` does this for the page; this file does it for the
 * components the page composes, where the failure mode actually lives and is
 * silent.
 *
 * Input classes:
 *  H1  a failed ledger read is NAMED, never silence and never empty. `PlanLedger`
 *      renders nothing for an account with no plans, so "silence" is a real
 *      rendering here and the two must not collide.
 *  H2  a failed history read is NAMED; an EMPTY history read is silence. Same
 *      component, opposite facts, and the only arm that may render nothing is the
 *      one that HELD the data.
 *  H3  a failed snapshot read renders degraded and CANNOT reach the dependency
 *      empty copy — structurally, not by where a guard happens to sit.
 *  H4  a snapshot that READ and has zero deps renders the achromatic empty state —
 *      minted from that read's own token — with no degraded state anywhere.
 *  H5  a REFUSED MUTATION is the `error` slot, never `danger` red. §0 rule 3: red
 *      is a claim about a package, and "we could not start your audit" is our own
 *      plumbing. Two call sites.
 *  H6  a refused mutation is not a degraded region either — it carries no hatch.
 *      Hatch means "no signal here"; a refusal is a signal, because the request
 *      was answered. The three no-content vocabularies stay three.
 *  H7  a scan that covered LESS of the lockfile than the lockfile holds says so,
 *      in numbers, beside its rollup. This is the same failure class one level up
 *      from §0 rule 1: a cost-bound scan (D-1 / F-F6 — past the per-user budget a
 *      scan is served from cached verdicts, never refused) reported as a whole one
 *      overstates a clean result about a REPOSITORY. Its negative matters as much:
 *      a fully covered scan must NOT emit the caveat, or the sentence stops
 *      meaning anything and gets tuned out on the scan that needed it.
 *
 * Blackbox: msw at the HTTP boundary for the mutation classes, hand-built
 * `LoadState`s for the read classes; assertions on the accessibility tree and on
 * the `data-state` attributes the design system plants for exactly this purpose.
 */

import type { PublicRepoScan, PublicRepoScanDetailResponse } from "@npmguard/shared";
import { configure, fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { failed, loaded } from "../components/ui/load-state.ts";
import {
  auditSet,
  billingResponse,
  clearAbsoluteApiBase,
  makeTestClient,
  panelRepo,
  renderWithClient,
  SESSION_USER,
  useAbsoluteApiBase,
} from "../lib/test-harness.tsx";
import { billingKeys } from "./billing/keys.ts";
import { PlanLedger } from "./billing/components/PlanLedger.tsx";
import { PublicAuditDialog } from "./repos/components/PublicAuditDialog.tsx";
import { PublicAuditHistory } from "./repos/components/PublicAuditHistory.tsx";
import { PublicAuditReportDialog } from "./repos/components/PublicAuditReportDialog.tsx";
import { PublicScanResult } from "./repos/components/PublicScanResult.tsx";
import { RepoCard } from "./repos/components/RepoCard.tsx";
import { sessionKeys } from "./session/keys.ts";

const server = setupServer();
configure({ asyncUtilTimeout: 5000 });

beforeAll(() => {
  useAbsoluteApiBase();
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  clearAbsoluteApiBase();
});

const FAILURE = { what: "Plan & usage", detail: "GET /panel/billing failed (503)" };

function publicScan(over: Partial<PublicRepoScan> = {}): PublicRepoScan {
  return {
    id: 1,
    repo: {
      githubRepoId: 99,
      owner: "acme",
      name: "public-widget",
      fullName: "acme/public-widget",
      htmlUrl: "https://github.com/acme/public-widget",
      defaultBranch: "main",
      lockfilePath: "package-lock.json",
      lockfileSha: "deadbeef",
      lockfileDepCount: 2,
    },
    set: auditSet({ id: 1, origin: "public_repo_scan" }),
    requestedBy: 42,
    ...over,
  };
}

/** A snapshot that read cleanly and covers NOTHING. `total: 0` is the honest
 * shape for it — the rollup's partition holds trivially. */
const EMPTY_DETAIL: PublicRepoScanDetailResponse = {
  scan: publicScan({
    set: auditSet({
      id: 1,
      origin: "public_repo_scan",
      rollup: { outcome: null, total: 0, safe: 0, dangerous: 0, error: 0, pending: 0, cached: 0 },
    }),
  }),
  depsTruncated: false,
  deps: [],
};

/* ── H1 ─────────────────────────────────────────────────────────────────── */

describe("PlanLedger — H1 a failed read is named, never silence", () => {
  it("H1: failed renders the degraded region by name", () => {
    renderWithClient(<PlanLedger state={failed(FAILURE)} />);

    expect(screen.getByText(/Plan & usage unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/503/)).toBeInTheDocument();
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });

  it("H1: an account list that READ empty renders nothing at all", () => {
    renderWithClient(<PlanLedger state={loaded(billingResponse({ accounts: [] }))} />);
    expect(document.body.textContent).toBe("");
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });
});

/* ── H2 ─────────────────────────────────────────────────────────────────── */

describe("PublicAuditHistory — H2 failed and empty are opposite facts", () => {
  it("H2: failed renders the degraded region by name", () => {
    renderWithClient(
      <PublicAuditHistory
        state={failed({ what: "Public repository audits", detail: "GET failed (502)" })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/Public repository audits unavailable/)).toBeInTheDocument();
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });

  it("H2: a history that READ empty renders nothing, and is not degraded", () => {
    renderWithClient(<PublicAuditHistory state={loaded([])} onOpen={() => {}} />);
    expect(document.body.textContent).toBe("");
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });
});

/* ── H3 / H4 ────────────────────────────────────────────────────────────── */

describe("PublicAuditReportDialog — H3 a failed read cannot reach the empty copy", () => {
  it("H3: the dialog degrades by name and never says 'no npm dependencies'", async () => {
    server.use(
      http.get("/api/panel/public-repos/1", () =>
        HttpResponse.json({ error: "upstream" }, { status: 502 }),
      ),
    );
    renderWithClient(<PublicAuditReportDialog scanId={1} onClose={() => {}} />);

    expect(await screen.findByText(/Snapshot unavailable/)).toBeInTheDocument();
    // The title says so too — never "Loading snapshot" over a failed read.
    expect(screen.getByRole("heading", { name: "Snapshot unavailable" })).toBeInTheDocument();
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
    // The copy that a `catch { deps: [] }` would have produced. `EmptyState`
    // demands the read token, so this is unreachable by construction — asserted
    // from the outside, because "unreachable" is what regresses silently.
    expect(screen.queryByText(/No npm dependencies in this lockfile/)).toBeNull();
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
  });
});

describe("PublicAuditReportDialog — H4 a successful read of nothing IS empty", () => {
  it("H4: zero deps renders the achromatic empty state, not a degraded one", async () => {
    server.use(http.get("/api/panel/public-repos/1", () => HttpResponse.json(EMPTY_DETAIL)));
    renderWithClient(<PublicAuditReportDialog scanId={1} onClose={() => {}} />);

    const empty = await screen.findByText(/No npm dependencies in this lockfile/);
    expect(empty.closest('[data-state="empty"]')).not.toBeNull();
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
    // And no mystery bar over an empty population: the ribbon is withheld, and the
    // header stamp carries the fact in words instead.
    expect(screen.getByText("Nothing to audit")).toBeInTheDocument();
  });
});

/* ── H7 ────────────────────────────────────────────────────────────────── */

describe("PublicScanResult — H7 partial coverage is stated, never implied", () => {
  const covering = (total: number, lockfileDepCount: number): PublicRepoScanDetailResponse => ({
    scan: publicScan({
      repo: { ...publicScan().repo, lockfileDepCount },
      set: auditSet({
        id: 1,
        origin: "public_repo_scan",
        rollup: {
          outcome: "SAFE",
          total,
          safe: total,
          dangerous: 0,
          error: 0,
          pending: 0,
          cached: total,
        },
      }),
    }),
    depsTruncated: false,
    deps: [],
  });

  // Asserted over the rendered text rather than through `getByText`: both
  // sentences interleave `<span>`s of numbers with prose, and the default text
  // matcher skips an element whose text is split across children — so a query
  // that "passes" would be proving something about the DOM shape and not about
  // what a person reads.
  const rendered = () => document.body.textContent ?? "";

  it("H7: a scan short of the lockfile names both counts and says what it omits", () => {
    renderWithClient(<PublicScanResult state={loaded(covering(150, 900))} />);

    // The clean rollup is present AND qualified — the two have to be readable
    // together, because the caveat exists to stop the SAFE being read alone.
    expect(rendered()).toContain("no threat found");
    expect(rendered()).toContain("were not audited and this snapshot says nothing about them");
    expect(rendered()).toContain("150");
    expect(rendered()).toContain("900");
    expect(rendered()).toContain("750");
  });

  it("H7: full coverage emits no caveat at all", () => {
    renderWithClient(<PublicScanResult state={loaded(covering(900, 900))} />);
    expect(rendered()).toContain("no threat found");
    expect(rendered()).not.toContain("were not audited");
  });
});

/* ── H5 / H6 ────────────────────────────────────────────────────────────── */

/** The rendered notice for a refused mutation, whichever component owns it. */
function refusalNotice(): HTMLElement {
  const alert = screen.getByRole("alert");
  return alert;
}

describe("RepoCard — H5/H6 a refused mutation is the error slot, not danger", () => {
  it("H5: a rejected scan renders in the error slot and names what failed", async () => {
    server.use(
      http.post("/api/panel/repo/5/scan", () =>
        HttpResponse.json({ error: "engine unavailable" }, { status: 503 }),
      ),
    );
    renderWithClient(<RepoCard repo={panelRepo({ id: 5, lastScan: auditSet() })} />);

    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    const notice = refusalNotice();
    expect(notice).toHaveTextContent(/Starting the audit failed/);

    // §0 rule 3, from the outside: the `error` violet slot, and no `danger` token
    // anywhere on the notice. The legacy class here was `banner--danger`.
    expect(notice.className).toMatch(/error/);
    expect(notice.className).not.toMatch(/danger/);
  });

  it("H6: the refusal is NOT a degraded region — no hatch, because a refusal is a signal", async () => {
    server.use(
      http.post("/api/panel/repo/5/scan", () =>
        HttpResponse.json({ error: "engine unavailable" }, { status: 503 }),
      ),
    );
    renderWithClient(<RepoCard repo={panelRepo({ id: 5, lastScan: auditSet() })} />);

    fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());

    // A refusal shares the error HUE with a failed read but not its texture: the
    // hatch means "this region went missing", and this region did not.
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
    expect(document.querySelector('[style*="repeating-linear-gradient"]')).toBeNull();
    // Dismissible, and dismissing is the mutation's own `reset()`.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("PublicAuditDialog — H5 a rejected submit is the error slot too", () => {
  it("H5: the form's own failure renders in the error slot, never danger", async () => {
    // The cache is primed rather than fetched: the dialog reads `accounts[0]` in a
    // `useState` initialiser, and on the dashboard it is mounted only once billing
    // has already landed — so a cold client would be a state the product never has.
    const client = makeTestClient();
    client.setQueryData(sessionKeys.me(), { user: SESSION_USER, appEnabled: true });
    client.setQueryData(billingKeys.overview(), billingResponse());
    server.use(
      http.post("/api/panel/public-repos/scan", () =>
        HttpResponse.json({ error: "rate limited" }, { status: 429 }),
      ),
    );

    renderWithClient(<PublicAuditDialog onClose={() => {}} onStarted={() => {}} />, { client });

    fireEvent.change(screen.getByPlaceholderText("github.com/owner/repository"), {
      target: { value: "acme/widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Audit snapshot" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    const notice = refusalNotice();
    expect(notice.className).toMatch(/error/);
    expect(notice.className).not.toMatch(/danger/);
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });
});
