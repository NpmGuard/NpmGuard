// Screenshot capture for the design-review before/after matrix.
// Usage: node design-review/capture.mjs [outDir]   (default: design-review/after)
// Requires the dev servers: frontend on :3000, engine on :8000.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:3000";
const EXECUTABLE =
  process.env.CHROMIUM_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`;

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, process.argv[2] ?? "after");
mkdirSync(outDir, { recursive: true });

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 375, height: 812 };

const setTheme = async (page, dark) => {
  await page.evaluate((d) => document.documentElement.classList.toggle("urushi", d), dark);
  await page.waitForTimeout(300); // let background transitions finish before shooting
};

const shot = async (page, name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`  ✓ ${name}`);
};

// Static routes: capture light + dark without re-navigating (theme is a class toggle).
const STATIC_SCREENS = [
  { route: "/", name: "landing" },
  { route: "/packages", name: "packages" },
  { route: "/benchmark", name: "benchmark" },
  { route: "/package/event-stream", name: "report-dangerous" },
];

const browser = await chromium.launch({ executablePath: EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: DESKTOP });

  console.log("desktop 1440×900");
  for (const { route, name } of STATIC_SCREENS) {
    await page.goto(BASE + route, { waitUntil: "networkidle" });
    await page.waitForTimeout(400); // let fonts/transitions settle
    await setTheme(page, false);
    await shot(page, `${name}-light-desktop`);
    await setTheme(page, true);
    await shot(page, `${name}-dark-desktop`);
  }

  // Live audit: click the first critical demo card, capture mid-flight and verdict.
  console.log("live audit replay");
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await setTheme(page, false);
  await page.click("button.landing-card.crit");
  await page.waitForURL("**/audit/**");
  await page.waitForTimeout(12_000);
  await shot(page, "audit-live-light-desktop");
  await setTheme(page, true);
  await shot(page, "audit-live-dark-desktop");
  await setTheme(page, false);
  // Once a verdict is reached, ReportView takes over and renders the
  // certificate strip — that's the reliable "replay finished" signal.
  await page.waitForSelector(".audit-certificate", { timeout: 120_000 });
  await page.waitForTimeout(1_500);
  await shot(page, "audit-verdict-light-desktop");
  await setTheme(page, true);
  await shot(page, "audit-verdict-dark-desktop");

  console.log("mobile 375×812");
  const mobile = await browser.newPage({ viewport: MOBILE, isMobile: true, hasTouch: true });
  for (const { route, name } of STATIC_SCREENS) {
    if (name === "benchmark") continue;
    await mobile.goto(BASE + route, { waitUntil: "networkidle" });
    await mobile.waitForTimeout(400);
    await setTheme(mobile, false);
    await shot(mobile, `${name}-light-mobile`);
  }
} finally {
  await browser.close();
}
console.log(`done → ${outDir}`);
