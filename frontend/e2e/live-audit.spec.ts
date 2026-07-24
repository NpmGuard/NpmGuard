// S1 clean SAFE demo · S2 DANGEROUS demo · S3 reconnect / replay-idempotence
// ── Scenario map (TESTING.md, Pillar B) ──────────────────────────────────────
// S1 [SAFE inline]      Landing demo streams IN PLACE (URL stays "/"), reveals a
//                       terminal SAFE verdict — "No known threats", no hypotheses.
// S2 [DANGEROUS inline] Landing demo reveals a terminal DANGEROUS verdict with a
//                       CONFIRMED hypothesis card. Never SAFE.
// S3 [reconnect]        The Last-Event-ID cursor replay is idempotent — a
//                       reconnecting client re-reaches the SAME terminal verdict
//                       with NO duplicated events. Proven at the real SSE boundary
//                       (the UI /audit/:id resume that WOULD render this is blocked
//                       by a confirmed app bug — see the quarantined test below).
// Discipline: assert STRUCTURE + lifecycle (verdict pill, counts rail, headline,
// honest copy) — NEVER the captured LLM prose (it rots on re-record).
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from "@playwright/test";
import {
  DANGEROUS_DEMO,
  SAFE_DEMO,
  TERMINAL_MS,
  discoverDemoPackages,
  startDemoViaApi,
} from "./helpers.ts";

test("S1: the SAFE demo streams inline on Landing to a terminal SAFE verdict", async ({
  page,
  request,
}) => {
  await discoverDemoPackages(request);
  await page.goto("/");

  // Clicking a demo streams INLINE — the URL must NOT leave "/".
  await page.getByRole("button", { name: `watch demo audit of ${SAFE_DEMO}` }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");

  const reveal = page.locator(`[aria-label="live demo audit of ${SAFE_DEMO}"]`);
  await expect(reveal).toBeVisible();

  // Terminal SAFE: the verdict badge, the honest headline, the honest empty rail.
  await expect(reveal.locator(".report-verdict__badge")).toHaveText("SAFE", {
    timeout: TERMINAL_MS,
  });
  await expect(reveal.getByText("No known threats")).toBeVisible();
  await expect(reveal.getByText("No hypotheses raised")).toBeVisible();
  // Never a DANGEROUS pill for a clean package (all-caps is the verdict badge,
  // distinct from the Title-Case "Dangerous" legend chip).
  await expect(reveal.getByText("DANGEROUS", { exact: true })).toHaveCount(0);
});

test("S2: the DANGEROUS demo reveals a terminal DANGEROUS verdict + confirmed threat", async ({
  page,
  request,
}) => {
  await discoverDemoPackages(request);
  await page.goto("/");

  await page.getByRole("button", { name: `watch demo audit of ${DANGEROUS_DEMO}` }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");

  const reveal = page.locator(`[aria-label="live demo audit of ${DANGEROUS_DEMO}"]`);
  await expect(reveal).toBeVisible();

  await expect(reveal.locator(".report-verdict__badge")).toHaveText("DANGEROUS", {
    timeout: TERMINAL_MS,
  });
  // Honest headline (1 confirmed) + the counts rail (14 total) + the confirmed
  // hypothesis card. "Credential theft" is the CLAIM LABEL, not model prose.
  await expect(reveal.getByText("1 confirmed threat")).toBeVisible();
  await expect(reveal.getByRole("img", { name: "14 hypotheses" })).toBeVisible();
  await expect(reveal.getByText("Credential theft").first()).toBeVisible();
  // A confirmed threat is DANGEROUS — never coerced to SAFE.
  await expect(reveal.getByText("SAFE", { exact: true })).toHaveCount(0);
});

/** Parse an SSE replay body into ordered {seq,type,verdict?} frames. The engine
 * frames each event as `id: <seq>\nevent: <type>\ndata: <json>\n\n`; a done
 * session's /events replays the whole buffer and closes (follow=false). */
function parseSse(body: string): { seq: number; type: string; verdict?: string }[] {
  const out: { seq: number; type: string; verdict?: string }[] = [];
  for (const frame of body.split("\n\n")) {
    if (!frame.trim() || frame.startsWith(":")) continue; // skip heartbeats
    let seq: number | undefined;
    let type: string | undefined;
    let verdict: string | undefined;
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        try {
          verdict = (JSON.parse(line.slice(5).trim()) as { verdict?: string }).verdict;
        } catch {
          /* structure-only: a malformed data line never fails the parse */
        }
      }
    }
    if (seq !== undefined && type) out.push({ seq, type, verdict });
  }
  return out;
}

async function replay(request: Parameters<typeof startDemoViaApi>[0], auditId: string, since = -1) {
  const res = await request.get(`/api/audit/${auditId}/events?since=${since}`);
  expect(res.ok(), "the events replay should 200").toBeTruthy();
  return parseSse(await res.text());
}

test("S3: the Last-Event-ID cursor replay is idempotent and reaches the same terminal verdict", async ({
  request,
}) => {
  // A demo started via the API exposes the durable /audit/:id event buffer.
  const auditId = await startDemoViaApi(request, DANGEROUS_DEMO);

  // Wait for the run to go terminal (report flips 202 → 200) — a condition, not
  // a sleep. Once terminal, the full buffer is stable for replay.
  await expect
    .poll(async () => (await request.get(`/api/audit/${auditId}/report`)).status(), {
      timeout: TERMINAL_MS,
    })
    .toBe(200);

  // Two full replays of the same session must be byte-for-byte identical in the
  // (seq,type) sequence — the replay is deterministic / idempotent.
  const first = await replay(request, auditId);
  const second = await replay(request, auditId);
  expect(first.map((e) => `${e.seq}:${e.type}`)).toEqual(second.map((e) => `${e.seq}:${e.type}`));

  // No duplicate rows: every seq is unique and strictly ascending.
  const seqs = first.map((e) => e.seq);
  expect(new Set(seqs).size, "no event seq may repeat in a replay").toBe(seqs.length);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

  // Exactly one terminal verdict, and it IS the last frame — the same DANGEROUS
  // verdict every replay resolves to (structure, not prose).
  const terminals = first.filter((e) => e.type === "verdict_reached");
  expect(terminals, "exactly one terminal verdict").toHaveLength(1);
  expect(first[first.length - 1].type).toBe("verdict_reached");
  expect(terminals[0].verdict).toBe("DANGEROUS");

  // Cursor honored: a reconnect from a mid-stream cursor re-delivers ONLY events
  // AFTER it — the client (fold) never re-receives a seen seq, so no row dupes.
  const mid = seqs[Math.floor(seqs.length / 2)];
  const resumed = await replay(request, auditId, mid);
  expect(resumed.length, "the cursor replay must deliver the tail").toBeGreaterThan(0);
  expect(
    resumed.every((e) => e.seq > mid),
    "the cursor replay must not re-deliver events at or before the cursor",
  ).toBeTruthy();
  // The tail still carries the same terminal verdict.
  expect(resumed[resumed.length - 1].type).toBe("verdict_reached");
});

// This e2e FOUND a real app bug: a cold /audit/:id resume ping-ponged
// Landing↔AuditView forever (Landing's unmount cleanup reset the just-resumed
// session — the same root cause as the demo bug). FIXED in src: Landing now
// resets ONLY an inline demo on unmount, so a resumed audit survives the swap.
test(
  "S3: reloading /audit/:id reconnects to the same verdict with no duplicate rows",
  async ({ page, request }) => {
    const auditId = await startDemoViaApi(request, DANGEROUS_DEMO);
    const auditUrl = `/audit/${auditId}`;

    await page.goto(auditUrl);
    const feed = page.getByRole("log", { name: "Audit activity" });
    await expect(feed).toBeVisible();
    await expect
      .poll(() => page.locator(".audit-feed__row--phase").count(), { timeout: TERMINAL_MS })
      .toBeGreaterThan(0);

    await page.goto(auditUrl); // reload into the same session

    await expect(page.locator(".report-verdict__badge")).toHaveText("DANGEROUS", {
      timeout: TERMINAL_MS,
    });

    const phaseLabels = await page.locator(".audit-feed__row--phase .eyebrow").allTextContents();
    expect(phaseLabels.length).toBeGreaterThan(1);
    expect(new Set(phaseLabels).size).toBe(phaseLabels.length);
  },
);
