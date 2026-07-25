/**
 * Component: the dashboard over a PARTIAL fetch — pages/Dashboard.tsx.
 *
 * The design doc's goal G6, tested where it can actually regress. The old page
 * fetched five resources through one `Promise.allSettled` and reduced them to one
 * `loading` plus one `error`, so any single failure either took the whole page
 * down or vanished. The specific lie: alerts failing left `alerts` at `[]`, the
 * banner returned `null`, and the reader concluded *no threats* from *no
 * knowledge*.
 *
 * Every case below fails one sub-fetch and asserts BOTH halves — that the failed
 * region says so by name, and that the regions which succeeded still render.
 * Asserting only the first would pass on a page that degraded everything.
 *
 * Input classes (one per degraded path):
 *  D1  alerts fail, repos succeed   — the repo list renders AND the alerts region is
 *                                     degraded and named. Silence is not an option.
 *  D2  repos fail, alerts succeed   — the alerts banner renders AND the repo region is
 *                                     degraded — never "No auditable repositories
 *                                     found", which is a claim about GitHub we cannot
 *                                     make from a failed read.
 *  D3  billing fails                — the plan ledger is degraded and named; the rest of
 *                                     the page is untouched.
 *  D4  installations fail           — the grid's empty copy depends on BOTH lists, so a
 *                                     failed installations read degrades the grid rather
 *                                     than picking one of the two sentences at random.
 *  D5  empty ≠ failed               — a successful read of zero repos renders the EMPTY
 *                                     state (achromatic, `data-state="empty"`), and the
 *                                     failed read renders `data-state="degraded"`. The
 *                                     two are distinguishable from the outside.
 *  D6  session read fails           — no sign-in card over an unreadable session, because
 *                                     that invites a click that cannot work.
 *
 * Blackbox: msw at the HTTP boundary, queries through the real client, assertions
 * on the accessibility tree and the `data-state` attributes the design system
 * plants for exactly this purpose.
 */

import { configure, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  alert,
  auditSet,
  billingResponse,
  clearAbsoluteApiBase,
  panelRepo,
  renderWithClient,
  SESSION_USER,
  useAbsoluteApiBase,
} from "../lib/test-harness.tsx";
import { Dashboard } from "./Dashboard.tsx";

const server = setupServer();

// Six real fetches, six schema parses and a full page render per case, with the
// suite running four workers wide. RTL's 1s default is not a meaningful budget
// for that, and a timeout here reads as a false "the region never resolved".
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

const REPOS = [panelRepo({ id: 5, name: "widget", fullName: "acme/widget", lastScan: auditSet() })];

/** Every panel route answering healthily. Each test overrides exactly the one it
 * is failing, so a passing assertion cannot be an accident of a second failure. */
function healthy(over: {
  repos?: () => Response;
  alerts?: () => Response;
  billing?: () => Response;
  orgs?: () => Response;
} = {}) {
  server.use(
    http.get("/api/me", () => HttpResponse.json({ user: SESSION_USER })),
    http.get("/api/panel/orgs", over.orgs ?? (() =>
      HttpResponse.json({
        installations: [{ id: 1, accountLogin: "acme", accountType: "Organization", suspended: false }],
        installUrl: "https://github.com/apps/npmguard/installations/new",
      }))),
    http.get("/api/panel/repos", over.repos ?? (() => HttpResponse.json({ repos: REPOS }))),
    http.get("/api/panel/alerts", over.alerts ?? (() => HttpResponse.json({ alerts: [alert()] }))),
    http.get("/api/panel/billing", over.billing ?? (() => HttpResponse.json(billingResponse()))),
    http.get("/api/panel/public-repos", () => HttpResponse.json({ scans: [] })),
  );
}

const fails = (status: number) => () => HttpResponse.json({ error: "upstream" }, { status });

describe("Dashboard — D1 alerts fail while repos succeed", () => {
  it("D1: the repo list still renders, and the alerts region says it is unavailable", async () => {
    healthy({ alerts: fails(502) });
    renderWithClient(<Dashboard />);

    // The half that worked is still shown — degrading everything would be a
    // different bug with the same shape.
    expect(await screen.findByText("widget")).toBeInTheDocument();

    // The half that failed NAMES itself. This is the assertion the old page could
    // not pass: it rendered nothing at all here.
    const degraded = await screen.findByText(/Alerts feed unavailable/);
    expect(degraded).toBeInTheDocument();
    // …and it is unmistakably not an empty state.
    expect(degraded.closest('[data-state="degraded"]')).not.toBeNull();
  });
});

describe("Dashboard — D2 repos fail while alerts succeed", () => {
  it("D2: the alerts banner renders, and the repo region never claims 'no repositories'", async () => {
    healthy({ repos: fails(500) });
    renderWithClient(<Dashboard />);

    expect(await screen.findByText(/left-pad/)).toBeInTheDocument();
    expect(await screen.findByText(/Repositories unavailable/)).toBeInTheDocument();
    // The empty copy is a claim about GitHub. A failed read cannot support it.
    expect(screen.queryByText(/No auditable repositories found/)).toBeNull();
    expect(screen.queryByText(/Install NpmGuard on a GitHub account/)).toBeNull();
  });
});

describe("Dashboard — D3 billing fails", () => {
  it("D3: the plan ledger degrades by name while the rest of the page stands", async () => {
    healthy({ billing: fails(503) });
    renderWithClient(<Dashboard />);

    expect(await screen.findByText("widget")).toBeInTheDocument();
    expect(await screen.findByText(/Plan & usage unavailable/)).toBeInTheDocument();
  });
});

describe("Dashboard — D4 installations fail", () => {
  it("D4: the grid degrades rather than guessing which empty sentence is true", async () => {
    healthy({ orgs: fails(502), repos: () => HttpResponse.json({ repos: [] }) });
    renderWithClient(<Dashboard />);

    expect(await screen.findByText(/Your GitHub workspace unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/No auditable repositories found/)).toBeNull();
  });
});

describe("Dashboard — D5 an empty read and a failed read stay distinguishable", () => {
  it("D5: zero repositories renders the EMPTY state, not a degraded one", async () => {
    healthy({ repos: () => HttpResponse.json({ repos: [] }) });
    renderWithClient(<Dashboard />);

    const empty = await screen.findByText(/No auditable repositories found/);
    expect(empty.closest('[data-state="empty"]')).not.toBeNull();
    expect(document.querySelector('[data-state="degraded"]')).toBeNull();
  });

  it("D5: a failed repositories read renders the DEGRADED state, not an empty one", async () => {
    healthy({ repos: fails(500) });
    renderWithClient(<Dashboard />);

    await screen.findByText(/Repositories unavailable/);
    expect(document.querySelector('[data-state="empty"]')).toBeNull();
    expect(document.querySelector('[data-state="degraded"]')).not.toBeNull();
  });
});

describe("Dashboard — D6 an unreadable session is not a signed-out session", () => {
  it("D6: a 500 on /me names the failure instead of offering a sign-in that cannot work", async () => {
    server.use(http.get("/api/me", fails(500)));
    renderWithClient(<Dashboard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Your GitHub session/);
    expect(screen.queryByText(/Sign in with GitHub/)).toBeNull();
  });

  it("D6: a 401 IS a signed-out session, and does render the sign-in card", async () => {
    server.use(http.get("/api/me", () => HttpResponse.json({ error: "Not signed in" }, { status: 401 })));
    renderWithClient(<Dashboard />);

    expect(await screen.findByText(/Sign in with GitHub/)).toBeInTheDocument();
  });
});
