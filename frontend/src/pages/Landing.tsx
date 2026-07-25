/**
 * Landing (/) — the entry surface. Four calm sections:
 *   1. Hero on a dot grid + a LaunchInput that drives store.startAudit
 *      (402 → /pay).
 *   2. A live-demo strip: fetchDemoPackages(); real recordings become
 *      "watch demo" buttons that reveal an inline, contract-faithful
 *      <MiniAuditFeed/> below the bar (never navigates away). An EMPTY demo
 *      list renders honestly — just the package input, no fake dropdown.
 *   3. The verdict legend.
 *   4. A "how it works" trust band (pay → pipeline → verdict).
 *
 * Every stream transition is fold-derived in the store; this page only
 * orchestrates start + reveal.
 *
 * ── PRESENTATION: what the recomposition onto the token layer changed ───────
 *
 * `styles/landing.css` is gone. Two of the changes are outright bugs, and both
 * of them were on the page that forms a first-time visitor's entire mental
 * model of the product:
 *
 * ★ 1. THE LEGEND ADVERTISED A STATE THAT NO LONGER EXISTS. It listed four
 *      peers — Safe, Dangerous, **Suspect**, Running. `SUSPECT` was deleted
 *      from the codebase (platform-v3 §8b); nothing can ever emit it. So the
 *      one surface whose job is teaching the verdict vocabulary was teaching a
 *      word the product does not say.
 *
 *      Worse, it taught the WRONG SHAPE. Four peers on one axis conflates the
 *      two axes §0 separates: Safe/Dangerous are outcomes, Running is progress.
 *      And `ERROR` — a first-class outcome, the state that carries the whole
 *      credibility argument — was absent, so a visitor learned that an audit
 *      always concludes. The legend is now three outcomes (SAFE, DANGEROUS,
 *      ERROR) with progress named separately as the second axis.
 *
 *      SAFE's copy also gains its §0 caveat. "No confirmed threat" is not "this
 *      package is safe", and the landing page is exactly where overstating a
 *      clean result costs the most credibility.
 *
 * ★ 2. `fetchDemoPackages().catch(() => setDemos([]))` — the canonical N-3 bug,
 *      verbatim. A failed fetch left the list at `[]` and the page rendered "No
 *      recorded audits available yet", which is a claim about the engine we had
 *      just failed to reach. It is a `LoadState` now, and a failed read renders
 *      a named degraded region instead.
 *
 * A third, smaller: the launch error rendered `banner--danger` — red for a
 * failed start, which is our plumbing and not a claim about the package.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../lib/api-base.ts";
import { fetchDemoPackages } from "../lib/api.ts";
import { parsePackageInput } from "../lib/types.ts";
import { useAuditStore } from "../stores/auditStore.ts";
import { MiniAuditFeed } from "../components/audit/MiniAuditFeed.tsx";
import { PanelPage, SectionLabel } from "../components/panel/layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { DataRegion } from "../components/ui/data-region.tsx";
import { DegradedRegion } from "../components/ui/degraded-state.tsx";
import { LaunchInput } from "../components/ui/launch-input.tsx";
import { failed, loaded, type LoadState } from "../components/ui/load-state.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { ProgressStamp, VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import type { Outcome } from "@npmguard/shared";
import { cn } from "../lib/cn.ts";

/** The hero's decorative dot grid, on tokens rather than the legacy `.dot-grid`.
 * `border` and not a dedicated token: the dots are the same hairline the rest of
 * the system draws with, so they track the theme without a second knob. */
const DOT_GRID: React.CSSProperties = {
  backgroundImage: "radial-gradient(circle, var(--ng-border) 1px, transparent 1.2px)",
  backgroundSize: "24px 24px",
};

/** The three OUTCOMES, which are what a verdict can be. Progress is a separate
 * axis and is described separately below — see the file header. */
const OUTCOMES: { outcome: Outcome; body: string }[] = [
  {
    outcome: "SAFE",
    body: "No confirmed threat was found. Every hypothesis was refuted or found benign under sandbox execution — which is not the same as proof that the package is harmless.",
  },
  {
    outcome: "DANGEROUS",
    body: "At least one malicious behaviour was confirmed with reproducible evidence. Do not install.",
  },
  {
    outcome: "ERROR",
    body: "The audit could not reach a conclusion — a load crash, a timeout, a sandbox that would not start. Not safe, not dangerous: unknown, and it says so.",
  },
];

const STEPS = [
  {
    eyebrow: "01 · Pay",
    title: "Pay per audit",
    body: "A flat fee per package — card or crypto on Base. Verification is server-side; the wallet signs, the engine verifies.",
  },
  {
    eyebrow: "02 · Pipeline",
    title: "LLM + sandbox",
    body: "The package is installed and scanned, capabilities are inferred, then risky hypotheses are executed in an isolated container.",
  },
  {
    eyebrow: "03 · Verdict",
    title: "Evidence, not vibes",
    body: "You get a verdict with a rationale, per-hypothesis resolutions, and the exact files behind the call.",
  },
];

function Section({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12 grid gap-3" aria-labelledby={id}>
      <h2 id={id}>
        <SectionLabel>{label}</SectionLabel>
      </h2>
      {children}
    </section>
  );
}

export function Landing() {
  const navigate = useNavigate();
  const startAudit = useAuditStore((s) => s.startAudit);
  const startDemo = useAuditStore((s) => s.startDemo);
  const reset = useAuditStore((s) => s.reset);

  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [launchFailure, setLaunchFailure] = useState<string | null>(null);

  const [demos, setDemos] = useState<LoadState<string[]>>({ status: "loading" });
  const [activeDemo, setActiveDemo] = useState<string | null>(null);
  const [demoStarting, setDemoStarting] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      setDemos({ status: "loading" });
      void fetchDemoPackages()
        .then((r) => live && setDemos(loaded(r.packages)))
        .catch(
          (err) =>
            live &&
            // NOT `setDemos([])`. "The engine offers no recordings" and "we
            // could not ask the engine" are different facts, and the second one
            // used to render as the first.
            setDemos(
              failed({
                what: "Recorded audits",
                detail: err instanceof Error ? err.message : undefined,
                retry: load,
              }),
            ),
        );
    };
    load();
    return () => {
      live = false;
    };
  }, []);

  // Tear down ONLY an inline demo that lived on this page. A real audit that
  // took over the view (AuditView), or a session resumed via /audit/:id, must
  // NOT be reset when Landing unmounts — that would kill the very stream it
  // started/resumed (and ping-pong Landing↔AuditView forever).
  useEffect(() => {
    return () => {
      if (useAuditStore.getState().demoInline) reset();
    };
  }, [reset]);

  async function onAudit() {
    const { name, version } = parsePackageInput(input);
    if (!name) return;
    setLaunchFailure(null);
    setSubmitting(true);
    try {
      await startAudit(name, version ?? undefined);
      const auditId = useAuditStore.getState().auditId;
      if (auditId) {
        navigate(`/audit/${auditId}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        navigate(
          `/pay?package=${encodeURIComponent(name)}${version ? `&version=${encodeURIComponent(version)}` : ""}`,
        );
        return;
      }
      setLaunchFailure(err instanceof Error ? err.message : "Could not start the audit");
    } finally {
      setSubmitting(false);
    }
  }

  async function onDemo(pkg: string) {
    if (demoStarting) return;
    setLaunchFailure(null);
    setActiveDemo(pkg);
    setDemoStarting(true);
    try {
      await startDemo(pkg);
    } catch (err) {
      setActiveDemo(null);
      setLaunchFailure(err instanceof Error ? err.message : "Could not start the demo");
    } finally {
      setDemoStarting(false);
    }
  }

  return (
    <PanelPage>
      {/* 1 — Hero + launch bar */}
      <section
        style={DOT_GRID}
        className="rounded-2xl border border-border px-5 py-7 shadow-card sm:px-10 sm:py-12 lg:px-14 lg:py-16"
      >
        <div className="grid max-w-[680px] gap-3.5">
          <SectionLabel>Don't trust. Verify.</SectionLabel>
          <h1 className="max-w-[15ch] text-4xl leading-tight font-semibold text-text">
            Evidence-backed security verdicts for every npm package.
          </h1>
          <p className="max-w-[56ch] text-md leading-relaxed text-text-2">
            NpmGuard runs a package through an LLM&nbsp;+&nbsp;sandbox pipeline and returns a
            single verdict — <strong className="font-semibold text-text">SAFE</strong> or{" "}
            <strong className="font-semibold text-text">DANGEROUS</strong> — backed by confirmed,
            reproducible evidence.
          </p>

          <LaunchInput
            className="mt-2"
            name="package"
            label="Package to audit"
            placeholder="express  ·  @scope/pkg@1.2.3"
            value={input}
            onValueChange={setInput}
            onSubmit={() => void onAudit()}
            busy={submitting}
            action="Audit"
            busyLabel="Starting…"
            hint={
              <>
                Name only audits the latest version, or pin one with{" "}
                <span className="font-mono text-text-2">@version</span>.
              </>
            }
          />

          {launchFailure ? (
            // `error` violet: failing to START an audit is our plumbing, not a
            // finding about the package (§0 rule 3).
            <DegradedRegion
              className="max-w-[520px]"
              failure={{ what: "Audit start", detail: launchFailure }}
            />
          ) : null}
        </div>
      </section>

      {/* 2 — Live demo strip (honest when empty, honest when it failed) */}
      <Section id="pg-landing-demo" label="See it run">
        <DataRegion
          state={demos}
          title="Recorded audits"
          loading={
            <div className="flex flex-wrap gap-2">
              {/* Dimensions match the real buttons below. */}
              <Skeleton className="h-control-sm w-28 rounded-md" />
              <Skeleton className="h-control-sm w-36 rounded-md" />
            </div>
          }
          empty={{
            message: "No recorded audits are available on this engine yet.",
            hint: "Enter any package above to run a live one.",
          }}
        >
          {(packages) => (
            <>
              <p className="mb-3 max-w-[56ch] text-sm text-text-2">
                Watch a real recorded run — same pipeline, same feed, no wallet required.
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Demo audits">
                {packages.map((pkg) => (
                  <Button
                    key={pkg}
                    variant="outline"
                    size="sm"
                    onClick={() => void onDemo(pkg)}
                    disabled={demoStarting && activeDemo !== pkg}
                    aria-label={`watch demo audit of ${pkg}`}
                    aria-pressed={activeDemo === pkg}
                    className={cn(
                      "font-mono",
                      // A selection, not a filled CTA — the button stays a way
                      // back to the other recording, not the page's main action.
                      activeDemo === pkg &&
                        "border-accent-border bg-accent-wash text-accent-text hover:bg-accent-wash",
                    )}
                  >
                    {pkg}
                  </Button>
                ))}
              </div>

              {activeDemo ? (
                <div className="mt-4">
                  <MiniAuditFeed />
                </div>
              ) : null}
            </>
          )}
        </DataRegion>
      </Section>

      {/* 3 — Verdict legend: three OUTCOMES, then progress as a second axis */}
      <Section id="pg-landing-legend" label="What the verdicts mean">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {OUTCOMES.map((entry) => (
            <Card key={entry.outcome} className="grid content-start gap-2.5 p-4">
              <span className="justify-self-start">
                <VerdictStamp outcome={entry.outcome} />
              </span>
              <p className="text-sm text-text-2">{entry.body}</p>
            </Card>
          ))}
        </div>
        {/* The second axis, stated as a second axis rather than as a fourth
            verdict. This sentence is the whole correction. */}
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-2">
          <ProgressStamp state="running">Running</ProgressStamp>
          <span className="max-w-[62ch]">
            Progress is a separate axis. An audit that is still installing, scanning and testing
            has no verdict yet — that is not a fourth outcome, it is the absence of one.
          </span>
        </p>
      </Section>

      {/* 4 — How it works / trust band */}
      <Section id="pg-landing-how" label="How it works">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((step) => (
            <Card key={step.eyebrow} className="grid content-start gap-2 p-5">
              <SectionLabel>{step.eyebrow}</SectionLabel>
              <h3 className="text-base font-semibold text-text">{step.title}</h3>
              <p className="text-sm text-text-2">{step.body}</p>
            </Card>
          ))}
        </div>
      </Section>
    </PanelPage>
  );
}
