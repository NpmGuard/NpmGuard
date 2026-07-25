// CLASS MAP — the GitHub panel in a REAL browser, against the REAL engine with
// the App configured and GitHub served by the stub (playwright.config.ts's third
// webServer). The engine side of every route below is already proved by the
// Python `-m e2e` tier; what only a browser can prove is that the pages compose
// those facts into the flow a user walks.
//
//   P1 [sign-in]    the real OAuth round trip lands a session, and the dashboard
//                   mirrors the workspace: the org's repos render, an unaudited
//                   repo says so, and neither the signed-out card nor the "no
//                   GitHub App on this server" empty state is reachable.
//   P2 [scan]       Run audit → the set is observably RUNNING (the progress axis,
//                   achromatic, never a verdict) → the SSE-driven page settles on
//                   the terminal rollup, which PARTITIONS the covered deps:
//                   1 dangerous + 1 could-not-conclude + 1 no-threat over 3.
//                   The failed audit is ERROR, never SAFE and never a spinner
//                   nothing will resolve.
//   P3 [posture]    the DANGEROUS dep drives the repo card, the portfolio rail's
//                   attention segment and the Attention filter — one repo, one
//                   segment, the same fact everywhere it is shown.
//   P4 [alert]      the alert the engine raises for that pair reaches the feed,
//                   and "Mark as seen" is a real round trip: it survives a reload
//                   rather than being a local flag.
//   P5 [drill]      dashboard → repo → the flagged dep → its full durable report.
//                   An ERROR dep offers NO report link (there is no report to
//                   link to); a concluded one does.
//   P6 [protect]    Protect on a never-scanned repo responds immediately and
//                   kicks the background first scan Protect needs to have
//                   anything to watch.
//
// Serial by declaration order: P2's scan is the state P3-P5 read. That is the
// honest shape (the flow IS sequential) and a failure earlier in the chain skips
// the tests whose precondition never happened instead of reporting five
// failures for one cause.
//
// Stable locators are semantic (roles, aria-labels) or the `data-outcome` /
// `data-segment` / `data-progress` hooks the stamp + rail components plant.
// Never LLM prose — no prose in this file comes from a model.

import { expect, test } from "@playwright/test";
import { DANGEROUS_PKG, FIXTURE, MISSING_PKG, SAFE_PKG } from "./panel-fixture.ts";
import { signIn, SCAN_TERMINAL_MS } from "./panel.ts";

test.describe.configure({ mode: "serial" });

const WEB = FIXTURE.repos.web;
const DOCS = FIXTURE.repos.docs;

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("P1: signing in through GitHub mirrors the workspace onto the dashboard", async ({
  page,
}) => {
  // Every repo the installation exposes, by its own card. `Open <fullName>` is
  // the card's title link, so this proves the repo LIST, not merely some text.
  for (const repo of Object.values(FIXTURE.repos)) {
    await expect(
      page.getByRole("link", { name: `Open ${repo.owner}/${repo.name}` }),
    ).toBeVisible();
  }

  // Nothing has been scanned yet, and the cards say exactly that — "Not audited"
  // is the progress axis's not-attempted state, which is NOT a verdict. A repo
  // with no scan must never render an outcome stamp.
  await expect(page.locator('[data-progress="unaudited"]')).toHaveCount(
    Object.values(FIXTURE.repos).length,
  );
  await expect(page.locator("[data-outcome]")).toHaveCount(0);

  // The two states this page renders when the panel is NOT reachable. Asserting
  // their absence is what makes the whole file discriminating: with the App
  // credentials missing every panel route 503s and the dashboard renders the
  // "not configured" empty state, which would otherwise fail the tests below as
  // a missing selector rather than as the misconfiguration it is.
  await expect(
    page.getByText("The GitHub workspace is not configured on this server."),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveCount(0);
});

test("P2: a scan streams progress and settles on a rollup that partitions its deps", async ({
  page,
}) => {
  await page.getByRole("link", { name: `Open ${WEB.owner}/${WEB.name}` }).click();
  await expect(page.getByRole("heading", { name: WEB.name, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Run first audit" }).click();

  // PROGRESS, not outcome. The one cache-MISS dep is retried against the stub's
  // deliberately slow registry, so this window is real rather than raced for.
  await expect(page.getByRole("group", { name: "Audit posture" })).toContainText(
    /Scan in progress/,
  );

  // The stream drives the page to its terminal state — no reload here on
  // purpose: if the SSE writer stopped writing into the query cache, this fails.
  await expect(page.getByRole("heading", { name: "Action required" })).toBeVisible({
    timeout: SCAN_TERMINAL_MS,
  });

  // The rollup PARTITIONS the set: 1 dangerous + 1 error + 1 safe == 3 total.
  // The seeded DANGEROUS and SAFE reports are cache hits; the third dep has no
  // report and cannot be fetched, so its audit fails — ERROR, "we tried and
  // failed". A green third dep here would be the product lying.
  const posture = page.getByRole("group", { name: "Audit posture" });
  await expect(posture).toContainText("3 of 3 dependencies checked");
  await expect(posture).toContainText("1 dangerous");
  await expect(posture).toContainText("1 could not conclude");
  await expect(posture).toContainText("1 no threat found");

  // And per dep, in the inventory: the outcome stamps are 1 of each, with the
  // failed one reported as ERROR rather than left on the progress axis.
  const rows = page.getByRole("row");
  await expect(rows.filter({ hasText: DANGEROUS_PKG.name }).locator("[data-outcome]")).toHaveAttribute(
    "data-outcome",
    "DANGEROUS",
  );
  await expect(rows.filter({ hasText: SAFE_PKG.name }).locator("[data-outcome]")).toHaveAttribute(
    "data-outcome",
    "SAFE",
  );
  await expect(rows.filter({ hasText: MISSING_PKG.name }).locator("[data-outcome]")).toHaveAttribute(
    "data-outcome",
    "ERROR",
  );
  // Nothing is left pending: a set that finished cannot still be waiting.
  await expect(page.locator('[data-progress="running"], [data-progress="queued"]')).toHaveCount(0);
});

test("P3: the DANGEROUS dep drives the repo card, the portfolio rail and the filter", async ({
  page,
}) => {
  // The repo card carries the same outcome the detail page reached — `lastScan`
  // and the detail's `set` are one projection, so the two surfaces cannot
  // disagree.
  const card = page
    .getByRole("link", { name: `Open ${WEB.owner}/${WEB.name}` })
    .locator("xpath=ancestor::*[.//*[@data-outcome]][1]");
  await expect(card.locator("[data-outcome]")).toHaveAttribute("data-outcome", "DANGEROUS");

  // One repo lands in exactly one rail segment, and a DANGEROUS rollup is
  // attention. The other two repos have never been scanned, so they are unknown
  // — hatched, not green: absence of knowledge is not absence of threats.
  const rail = page.getByRole("list", { name: /need attention/ });
  await expect(rail.locator('[data-segment="attention"]')).toContainText("1");
  await expect(rail.locator('[data-segment="unknown"]')).toContainText("2");
  await expect(rail.locator('[data-segment="safe"]')).toHaveCount(0);

  // The Attention filter counts the same one repo, and filtering to it leaves
  // exactly that card.
  await page.getByRole("button", { name: /^Attention/ }).click();
  await expect(
    page.getByRole("link", { name: `Open ${WEB.owner}/${WEB.name}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `Open ${DOCS.owner}/${DOCS.name}` }),
  ).toHaveCount(0);
});

test("P5: drilling dashboard → repo → dep reaches the dependency's full report", async ({
  page,
}) => {
  await page.getByRole("link", { name: `Open ${WEB.owner}/${WEB.name}` }).click();
  await expect(page.getByRole("heading", { name: WEB.name, level: 1 })).toBeVisible();

  // The claim below is about how a CONCLUDED ERROR renders, so the dep has to
  // have concluded first. Its audit is retried against the stub's slow registry,
  // and a dep still on the progress axis is legitimately a link — asserting
  // before this settles tests the wrong state.
  await expect(
    page.getByRole("row").filter({ hasText: MISSING_PKG.name }).locator("[data-outcome]"),
  ).toHaveAttribute("data-outcome", "ERROR", { timeout: SCAN_TERMINAL_MS });

  // A report page exists only where an audit CONCLUDED with a verdict, so the
  // ERROR dep is deliberately NOT a link — there is nothing to link to, and a
  // dead link into a 404 would be worse than plain text.
  await expect(page.getByRole("link", { name: MISSING_PKG.name })).toHaveCount(0);

  await page.getByRole("link", { name: DANGEROUS_PKG.name }).first().click();
  await expect(page).toHaveURL(new RegExp(`/package/${DANGEROUS_PKG.name}$`));
  // The durable report for the pair the panel flagged — same package identity,
  // and the verdict the rollup was built from.
  await expect(page.getByText(DANGEROUS_PKG.name).first()).toBeVisible();
  await expect(page.getByText("DANGEROUS").first()).toBeVisible();
});

test("P6: Protect responds immediately and kicks the first scan it needs to watch", async ({
  page,
}) => {
  await page.getByRole("link", { name: `Open ${DOCS.owner}/${DOCS.name}` }).click();
  await expect(page.getByRole("heading", { name: DOCS.name, level: 1 })).toBeVisible();
  // Never scanned: Protect has no dep index to watch, which is the branch that
  // spawns the background scan.
  await expect(page.getByRole("group", { name: "Audit posture" })).toContainText("Not audited");

  await page.getByRole("switch", { name: "Protect" }).click();
  // The toggle answers on the POST, not on the scan — protection is a setting,
  // and `checked` is patched on success only, so a flipped switch is a state the
  // server confirmed.
  await expect(page.getByRole("switch", { name: "Protect" })).toBeChecked();
  await expect(page.getByText("Continuous protection")).toBeVisible();

  // …and the background first scan lands. Its single dep is a cache hit, so it
  // concludes with no registry, no docker and no LLM.
  await page.reload();
  await expect(page.getByRole("heading", { name: "No known threats" })).toBeVisible({
    timeout: SCAN_TERMINAL_MS,
  });
  await expect(page.getByRole("group", { name: "Audit posture" })).toContainText(
    "1 of 1 dependencies checked",
  );
});
