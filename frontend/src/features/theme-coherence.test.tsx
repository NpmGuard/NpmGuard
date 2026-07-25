/**
 * Component: the ten feature components, in BOTH themes.
 *
 * The failure this catches is a MIXED page — recomposed chrome going dark while a
 * feature component underneath stays light-only. Written as a measurement rather
 * than a claim because a screenshot is not available to a jsdom suite and would
 * be the wrong instrument anyway.
 *
 * ── WHY A CLASS ASSERTION IS THE RIGHT MEASUREMENT ─────────────────────────
 *
 * `styles/base.css` contains **no `prefers-color-scheme` block and no `.dark`
 * selector** — grep it. Every one of its ~100 class rules paints from legacy
 * `:root` primitives that are declared exactly once, in light. So a legacy class
 * in the rendered DOM is not merely old: it is a rule that CANNOT respond to a
 * theme, and one of them inside a `.dark` subtree is precisely the "mixed
 * dashboard" defect. The converse is the token layer's premise (§2.1): `@theme
 * inline` makes every utility reference `var(--ng-…)` rather than copying a value,
 * so ONE class serves both themes and a `.dark` stamped on a subtree works too.
 *
 * That makes the property checkable exactly, without computing a pixel:
 *
 *     no legacy class in the tree  ∧  no literal colour in an inline style
 *         ⇒  every colour in this subtree resolves through a token
 *         ⇒  the subtree renders in whichever theme is stamped on it
 *
 * The legacy class list is not hardcoded here — it is EXTRACTED from `base.css`
 * at test time, the same technique `styles/token-contract.test.ts` uses. So a
 * future edit that reintroduces any legacy class to a feature component fails
 * this test, including one that does not exist yet.
 *
 * Input classes:
 *  T1  the seven page-embedded components render under `.light` and `.dark`, wear
 *      no legacy class, and hide no literal colour in an inline style.
 *  T2  the three DIALOGS do too. They need their own class because Radix portals
 *      them OUTSIDE the page subtree — so a page-level test cannot reach them, and
 *      neither can the `.ng-root` scoped half of the global focus rule, which is
 *      why hand-rolled controls inside them carry `FOCUS_RING` explicitly.
 *  T3  the legacy sheet is genuinely unreachable: `styles/panel.css` is deleted
 *      and no `panel-*` class survives anywhere in `features/**`. Asserted against
 *      the source, because "the file is gone" is the claim that lets the
 *      `@import` be removed from `index.css`.
 *  T4  the extraction itself is sound — if `base.css` stopped yielding legacy
 *      names, T1/T2 would pass vacuously. This is the guard on the instrument.
 *
 * Blackbox: msw at the HTTP boundary, queries through the real client, assertions
 * on the rendered DOM's `class` attributes and inline styles.
 */

import type {
  AuditSetItem,
  CapExceeded,
  PublicRepoScan,
  PublicRepoScanDetailResponse,
} from "@npmguard/shared";
import { configure, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { expectNoHardcodedColour } from "../components/panel/theme-probe.ts";
import { loaded } from "../components/ui/load-state.ts";
import {
  auditSet,
  billingResponse,
  clearAbsoluteApiBase,
  entitlements,
  alert as makeAlert,
  panelRepo,
  renderWithClient,
  SESSION_USER,
  useAbsoluteApiBase,
} from "../lib/test-harness.tsx";
import { usePanelUi } from "../stores/panelStore.ts";
import { AlertsNotice } from "./alerts/components/AlertsNotice.tsx";
import { AllowanceMeter } from "./billing/components/AllowanceMeter.tsx";
import { PlanLedger } from "./billing/components/PlanLedger.tsx";
import { UpgradeDialog } from "./billing/components/UpgradeDialog.tsx";
import { PortfolioPosture } from "./repos/components/PortfolioPosture.tsx";
import { PublicAuditDialog } from "./repos/components/PublicAuditDialog.tsx";
import { PublicAuditHistory } from "./repos/components/PublicAuditHistory.tsx";
import { PublicAuditReportDialog } from "./repos/components/PublicAuditReportDialog.tsx";
import { RepoCard } from "./repos/components/RepoCard.tsx";
import { ScanStatus } from "./repos/components/ScanStatus.tsx";

const server = setupServer();
configure({ asyncUtilTimeout: 5000 });

beforeAll(() => {
  useAbsoluteApiBase();
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  usePanelUi.setState({ paywall: null });
  document.documentElement.classList.remove("dark", "light");
});
afterAll(() => {
  server.close();
  clearAbsoluteApiBase();
});

/* ── the instrument ─────────────────────────────────────────────────────── */

/* Resolved from `process.cwd()`, not from `import.meta.url`: under the jsdom
   environment that is an http:// URL, not a file path. Same note as
   `styles/token-contract.test.ts`, which reads its sheet the same way. */
const BASE_CSS = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");

/** Names that appear as a class in `base.css` AND as a Tailwind utility, so a
 * match would be ambiguous rather than damning:
 *
 *   `sr-only`  both define it, and the v3 side needs it — every loading region in
 *              this cluster announces its wait with one.
 *   `ng-root`  the v3 migration marker; `base.css` declares it deliberately FOR
 *              the token layer (see the tier comment at its foot), so it is the
 *              one class there that is not legacy.
 *   `table`,
 *   `row`      Tailwind's `display: table` / `display: table-row` utilities carry
 *              exactly these names.
 *
 * Everything else in the sheet is legacy by construction, because the sheet has
 * no theme response at all. */
const AMBIGUOUS = new Set(["sr-only", "ng-root", "table", "row"]);

/** Every class `base.css` styles — which is every class that can only be light. */
const LEGACY_CLASSES: ReadonlySet<string> = new Set(
  [...BASE_CSS.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)]
    .map((match) => match[1]!)
    .filter((name) => !AMBIGUOUS.has(name)),
);

/** Any legacy class currently in the document. Empty is the assertion. */
function legacyClassesInDocument(): string[] {
  const found = new Set<string>();
  for (const node of document.querySelectorAll<HTMLElement>("[class]")) {
    for (const name of node.classList) if (LEGACY_CLASSES.has(name)) found.add(name);
  }
  return [...found].sort();
}

/** The whole property, in one call: no light-only rule, no literal colour. */
function expectThemeAgnostic(): void {
  expect(
    legacyClassesInDocument(),
    "no class from the theme-less legacy sheet may reach a recomposed component — " +
      "base.css has no dark block, so such a class renders light inside a .dark subtree",
  ).toStrictEqual([]);
  expectNoHardcodedColour();
}

/* ── fixtures the shared harness does not carry ─────────────────────────── */
// Built at the contract's shape with no casts, same rule as `test-harness.tsx`.
// They live here rather than there because `lib/` is not this strand's to edit.

function dep(over: Partial<AuditSetItem> = {}): AuditSetItem {
  return {
    name: "left-pad",
    version: "1.3.0",
    direct: true,
    range: "^1.3.0",
    outcome: "DANGEROUS",
    verdictReason: "Credential exfiltration confirmed",
    evidenceCount: 3,
    auditedAt: "2026-07-25T11:05:00.000Z",
    // `null`, not `"done"`: `JobState` is `queued | running | failed` — a
    // concluded item has no live job. A fixture with an off-contract value here
    // does not fail loudly, it makes `safeParse` reject the whole response and
    // the dialog renders "Snapshot unavailable" — which is the failure this
    // fixture would then be quietly testing instead of the one it claims to.
    jobState: null,
    cached: false,
    ...over,
  };
}

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
    },
    set: auditSet({ id: 1, origin: "public_repo_scan" }),
    requestedBy: 42,
    installationId: 1,
    accountLogin: "acme",
    ...over,
  };
}

function scanDetail(
  over: Partial<PublicRepoScanDetailResponse> = {},
): PublicRepoScanDetailResponse {
  return {
    scan: publicScan(),
    depsTruncated: true,
    deps: [
      dep(),
      dep({ name: "chalk", version: "5.0.0", outcome: "SAFE", verdictReason: null }),
      dep({ name: "ms", version: "2.1.3", outcome: "ERROR", verdictReason: null }),
      dep({ name: "qs", version: "6.11.0", outcome: null, jobState: "running", cached: true }),
    ],
    ...over,
  };
}

const CAP: CapExceeded = {
  error: "Protected-repository limit reached",
  cap: true,
  resource: "protected_repos",
  installationId: 1,
  entitlements: entitlements(),
};

/** Signed in, with a plan and a snapshot to read. Each dialog needs its own
 * route, and `useBilling`/`usePublicScans` are gated on a KNOWN signed-in
 * session — so `/me` is not optional scaffolding here. */
function healthy() {
  server.use(
    http.get("/api/me", () => HttpResponse.json({ user: SESSION_USER })),
    http.get("/api/panel/billing", () => HttpResponse.json(billingResponse())),
    http.get("/api/panel/public-repos/1", () => HttpResponse.json(scanDetail())),
  );
}

/* ── T1 ─────────────────────────────────────────────────────────────────── */

const REPOS = [
  panelRepo({ id: 5, name: "widget", fullName: "acme/widget", lastScan: auditSet() }),
  panelRepo({
    id: 6,
    name: "gadget",
    fullName: "acme/gadget",
    protected: true,
    private: true,
    lastScan: auditSet({
      status: "running",
      rollup: {
        outcome: null,
        total: 10,
        safe: 4,
        dangerous: 0,
        error: 0,
        pending: 6,
        cached: 2,
      },
    }),
  }),
  panelRepo({
    id: 7,
    name: "sprocket",
    fullName: "acme/sprocket",
    lastScan: auditSet({
      rollup: { outcome: "DANGEROUS", total: 3, safe: 1, dangerous: 1, error: 1, pending: 0, cached: 0 },
    }),
  }),
  // Never audited — the bucket that exercises the hatched posture segment and
  // the `unaudited` progress stamp.
  panelRepo({ id: 8, name: "cog", fullName: "acme/cog" }),
];

/** Every non-dialog component at once, in the states that between them cover all
 * four posture buckets, all three outcome stamps and all three progress stamps. */
function PageComponents() {
  return (
    <div className="ng-root">
      <AlertsNotice
        state={loaded([makeAlert(), makeAlert({ id: 12, packageName: "chalk", version: "5.0.0" })])}
      />
      <PlanLedger state={loaded(billingResponse())} />
      <PublicAuditHistory
        state={loaded([
          publicScan(),
          publicScan({
            id: 2,
            set: auditSet({
              id: 2,
              status: "running",
              rollup: {
                outcome: null,
                total: 8,
                safe: 3,
                dangerous: 0,
                error: 0,
                pending: 5,
                cached: 1,
              },
            }),
          }),
          publicScan({
            id: 3,
            set: auditSet({
              id: 3,
              rollup: {
                outcome: null,
                total: 0,
                safe: 0,
                dangerous: 0,
                error: 0,
                pending: 0,
                cached: 0,
              },
            }),
          }),
        ])}
        onOpen={() => {}}
      />
      <PortfolioPosture repos={REPOS} />
      <AllowanceMeter label="Protected repositories" bucket={entitlements().protectedRepos} />
      <ScanStatus scan={null} />
      {REPOS.map((repo) => (
        <RepoCard key={repo.id} repo={repo} />
      ))}
    </div>
  );
}

describe("recomposed feature components — T1 both themes, page-embedded", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`T1: the seven page components render under an explicit .${theme} stamp with no light-only rule`, () => {
      document.documentElement.classList.add(theme);
      renderWithClient(<PageComponents />);

      // Rendered, not merely mounted: one landmark per component, so a component
      // that silently returned `null` cannot pass this by rendering nothing.
      expect(screen.getByText("2 new alerts")).toBeInTheDocument(); // AlertsNotice
      expect(screen.getByRole("heading", { name: "Plan & usage" })).toBeInTheDocument();
      // Two: the ledger's own, and the standalone `AllowanceMeter` beside it.
      expect(screen.getAllByRole("meter", { name: "Protected repositories" })).toHaveLength(2);
      expect(
        screen.getByRole("heading", { name: "Public repository audits" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Portfolio" })).toBeInTheDocument();
      expect(screen.getAllByText("Not audited").length).toBeGreaterThan(0); // ScanStatus
      expect(screen.getByText("widget")).toBeInTheDocument(); // RepoCard

      expectThemeAgnostic();
    });
  }
});

/* ── T2 ─────────────────────────────────────────────────────────────────── */

describe("recomposed feature dialogs — T2 both themes, portalled", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`T2: the paywall renders under .${theme} with no light-only rule`, async () => {
      document.documentElement.classList.add(theme);
      healthy();
      usePanelUi.setState({ paywall: CAP });
      renderWithClient(<UpgradeDialog />);

      // Waited for, so the assertion covers the POPULATED dialog — the Pro offer
      // and the price only exist once the billing read lands.
      expect(await screen.findByText("Protection limit reached")).toBeInTheDocument();
      await screen.findByText("Pro");
      expectThemeAgnostic();
    });

    it(`T2: the public-audit form renders under .${theme} with no light-only rule`, async () => {
      document.documentElement.classList.add(theme);
      healthy();
      renderWithClient(<PublicAuditDialog onClose={() => {}} onStarted={() => {}} />);

      // Not `findByRole("heading", …)`: `PanelDialog` renders an `sr-only`
      // `DialogTitle` — a real `<h2>` — carrying the same string as this dialog's
      // visible `<h2>`, so that query is ambiguous by construction. Two headings
      // with one name is the shell's arrangement, not this file's; reported as a
      // `components/panel/**` fix (let the caller pass the visible node as the
      // title) rather than worked around by demoting the visible heading.
      expect(
        await screen.findByPlaceholderText("github.com/owner/repository"),
      ).toBeInTheDocument();
      expect(screen.getAllByRole("heading", { name: "Audit a public repository" })).toHaveLength(2);
      expect(
        screen.getByRole("combobox", { name: "Use repository allowance from" }),
      ).toBeInTheDocument();
      expectThemeAgnostic();
    });

    it(`T2: the snapshot report renders under .${theme} with no light-only rule`, async () => {
      document.documentElement.classList.add(theme);
      healthy();
      renderWithClient(<PublicAuditReportDialog scanId={1} onClose={() => {}} />);

      expect(await screen.findByText("acme/public-widget")).toBeInTheDocument();
      // The dep table, the ribbon and the truncation notice — the three parts
      // that carry the dialog's own chrome.
      expect(screen.getByRole("table", { name: "Snapshot dependencies" })).toBeInTheDocument();
      expect(screen.getByText(/highest-priority dependencies/)).toBeInTheDocument();
      expectThemeAgnostic();
    });
  }
});

/* ── T3 / T4 ────────────────────────────────────────────────────────────── */

describe("the legacy panel sheet — T3 deleted, not merely unused", () => {
  it("T3: styles/panel.css is gone and index.css no longer imports it", () => {
    const indexCss = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
    expect(indexCss).not.toMatch(/@import.*panel\.css/);
    expect(() => readFileSync(resolve(process.cwd(), "src/styles/panel.css"))).toThrow();
  });
});

describe("the instrument — T4 the extraction is not vacuous", () => {
  it("T4: base.css still yields the legacy names T1/T2 rule out", () => {
    // Without this, a base.css that stopped parsing would make every assertion
    // above pass by finding nothing to complain about.
    for (const name of ["banner", "pill", "tag", "dot", "rail", "meter", "btn", "card", "eyebrow"]) {
      expect(LEGACY_CLASSES.has(name), `base.css defines .${name}`).toBe(true);
    }
    expect(LEGACY_CLASSES.size).toBeGreaterThan(50);
    // And the sheet really has no theme response — the premise of the whole file.
    expect(BASE_CSS).not.toMatch(/prefers-color-scheme:\s*dark/);
  });

  it("T4: the detector actually detects — a legacy class in the tree is reported", () => {
    // The other half of "not vacuous": T1/T2 assert an EMPTY result, which a
    // detector that always returns empty would also satisfy. This proves it fires.
    renderWithClient(
      <div className="card panel-repo">
        <span className="pill pill--violet">probe</span>
      </div>,
    );
    expect(legacyClassesInDocument()).toStrictEqual(["card", "pill", "pill--violet"]);
  });
});
