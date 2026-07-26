/**
 * Landing (/) — one command, and proof that it works.
 *
 * ── Why the page is shaped like this ────────────────────────────────────────
 *
 * The product's whole claim is that it RUNS the package and shows you what
 * happened. A grid of feature cards cannot make that claim — it can only assert
 * it, which is what every security vendor's homepage already does. A recorded
 * investigation playing in a frame IS the claim, made out of the same events a
 * real audit emits, in the same renderer.
 *
 * So there are exactly two things above the fold: the command that starts an
 * audit, and an evidence graph replaying a real one. Everything below explains
 * the same artifact rather than introducing new ones.
 *
 * ── The teaching decision this page implements ──────────────────────────────
 *
 * There is no tour, no checklist and no coach marks. The embedded replay teaches
 * the product by being it: a viewer who watches suspicious lines become a
 * hypothesis, a hypothesis become a sandbox run, and a run become a cited
 * verdict has learned the entire model without being told it.
 *
 * ── Two honesty rules this page has broken before ───────────────────────────
 *
 * 1. The verdict legend must teach the vocabulary the product actually speaks:
 *    three OUTCOMES (SAFE, DANGEROUS, ERROR) with progress named as a separate
 *    axis. It once advertised SUSPECT, which nothing can emit, and omitted
 *    ERROR, which teaches a visitor that an audit always concludes.
 * 2. A failed read of the replay gallery is a failure to reach the ENGINE, not
 *    a statement that no recordings exist. It is a `LoadState`, and a failed
 *    read renders a named degraded region.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Play } from "lucide-react";
import type { Outcome } from "@npmguard/shared";
import { ApiError } from "../lib/api-base.ts";
import { fetchDemoPackages } from "../lib/api.ts";
import { parsePackageInput } from "../lib/types.ts";
import { useAuditStore } from "../stores/auditStore.ts";
import { Button } from "../components/ui/button.tsx";
import { DegradedRegion } from "../components/ui/degraded-state.tsx";
import { LaunchInput } from "../components/ui/launch-input.tsx";
import { failed, loaded, type LoadState } from "../components/ui/load-state.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { ProgressStamp, VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import { cn } from "../lib/cn.ts";

/** The three OUTCOMES a verdict can be. Progress is a separate axis, below. */
const OUTCOMES: { outcome: Outcome; body: string }[] = [
  {
    outcome: "SAFE",
    body: "Every suspicion was armed as an experiment, run under the full oracle, and refuted. That is coverage, not proof of absence.",
  },
  {
    outcome: "DANGEROUS",
    body: "At least one hypothesis was confirmed by sandbox events the judgment cites. You can open the run and read them.",
  },
  {
    outcome: "ERROR",
    body: "The audit could not conclude. Never rendered as SAFE and never in danger red — an audit that broke says nothing about the package.",
  },
];

const STEPS = [
  {
    title: "Read the source",
    body: "Every source file is read once. Clean files become a coverage count, not a wall of green badges.",
  },
  {
    title: "Arm a falsifiable experiment",
    body: "A suspicion is compiled into setup, a trigger, and an oracle — bait planted, gates defeated, the code made to run.",
  },
  {
    title: "Run it and judge the evidence",
    body: "Syscalls, packets, filesystem diffs and Node instrumentation. A verdict cites exact events or it does not stand.",
  },
];

export function Landing() {
  const navigate = useNavigate();
  const startAudit = useAuditStore((s) => s.startAudit);
  const startDemo = useAuditStore((s) => s.startDemo);
  const error = useAuditStore((s) => s.error);
  const [target, setTarget] = useState("");
  const [launching, setLaunching] = useState(false);
  const [demos, setDemos] = useState<LoadState<string[]>>({ status: "loading" });

  useEffect(() => {
    let live = true;
    fetchDemoPackages()
      .then((response) => live && setDemos(loaded(response.packages)))
      .catch((err: unknown) =>
        live &&
        setDemos(
          // NOT `[]`. An empty gallery and an unreachable engine are different
          // facts, and only one of them is about the product.
          failed({
            what: "Recorded audits",
            detail: err instanceof Error ? err.message : "The engine could not be reached",
          }),
        ),
      );
    return () => {
      live = false;
    };
  }, []);

  async function launch(raw: string) {
    const { name, version } = parsePackageInput(raw);
    if (!name) return;
    setLaunching(true);
    try {
      await startAudit(name, version ?? undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        navigate(`/pay?package=${encodeURIComponent(name)}${version ? `&version=${version}` : ""}`);
        return;
      }
      throw err;
    } finally {
      setLaunching(false);
    }
  }

  const flagship = demos.status === "ok" ? demos.data[0] : null;

  return (
    <>
      <section className="border-b border-border">
        <div className="mx-auto w-full max-w-[1160px] px-4 pt-16 pb-12 md:px-6 md:pt-24 lg:px-8">
          <p className="flex items-center gap-3 font-mono text-2xs tracking-[0.18em] text-text-3 uppercase">
            <span aria-hidden="true" className="h-px w-8 bg-accent" />
            npm supply-chain auditing
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl leading-[1.05] font-bold tracking-tight text-text md:text-5xl">
            Find out what an npm package <em className="text-accent-text not-italic">actually
            does</em> <span className="text-text-3">when you install it.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-md leading-relaxed text-text-2">
            npmguard reads the source, turns each suspicion into an experiment, runs the package
            under a full-oracle sandbox, and gives you a verdict that cites the exact events it
            rests on.
          </p>

          <div className="mt-8 max-w-2xl">
            <LaunchInput
              label="Audit a package"
              placeholder="express@5.1.0"
              action="Audit"
              busyLabel="Starting…"
              busy={launching}
              value={target}
              onValueChange={setTarget}
              onSubmit={() => void launch(target)}
              hint="A package name, optionally with a version. Unversioned resolves to latest."
            />
            {error ? (
              // Violet, never red: a failed START is our plumbing, and red is
              // reserved for claims about a package.
              <p className="mt-2 text-2xs text-error-text">{error}</p>
            ) : null}
          </div>
        </div>
      </section>

      {/* The framed preview. Wide, immediately below the command, and playing a
          REAL recorded audit through the real renderer. */}
      <section aria-labelledby="landing-replay" className="border-b border-border bg-sunken">
        <div className="mx-auto w-full max-w-[1160px] px-4 py-12 md:px-6 lg:px-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="font-mono text-2xs tracking-[0.18em] text-text-3 uppercase">
                Evidence, not assertion
              </p>
              <h2 id="landing-replay" className="mt-2 text-2xl font-bold tracking-tight text-text">
                Watch a real investigation
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-2">
                Not an animation of a report. These are the frames an audit emitted, replayed in
                the same renderer a live audit uses — pause it, scrub it, open any node.
              </p>
            </div>
            {flagship ? (
              <Button onClick={() => void startDemo(flagship)}>
                <Play aria-hidden="true" className="size-icon-sm" />
                Play {flagship}
              </Button>
            ) : null}
          </div>

          {/* Stamped `.dark`: the replay frame is the lacquer panel on the paper
              page — the one place the landing shows the product's night face. */}
          <div className="dark mt-6 overflow-hidden rounded-xl border border-border bg-canvas shadow-pop">
            {demos.status === "failed" ? (
              <div className="p-4">
                <DegradedRegion title="Recorded audits" failure={demos.failure} />
              </div>
            ) : demos.status === "loading" ? (
              <Skeleton className="h-[420px] w-full" />
            ) : demos.data.length === 0 ? (
              <p className="p-8 text-center text-xs text-text-3">
                This engine ships no recorded audits. Start one above and watch it live.
              </p>
            ) : (
              <ReplayPoster packages={demos.data} onPlay={(name) => void startDemo(name)} />
            )}
          </div>
        </div>
      </section>

      <section className="border-b border-border">
        <div className="mx-auto grid w-full max-w-[1160px] gap-x-8 gap-y-10 px-4 py-16 md:grid-cols-3 md:px-6 lg:px-8">
          {STEPS.map((step, index) => (
            <div key={step.title} className="border-t-2 border-text pt-4">
              <span className="font-mono text-2xs text-accent-text tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 text-lg font-bold tracking-tight text-text">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-2">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="landing-verdicts">
        <div className="mx-auto w-full max-w-[1160px] px-4 py-14 md:px-6 lg:px-8">
          <p className="font-mono text-2xs tracking-[0.18em] text-text-3 uppercase">
            Three outcomes, one axis
          </p>
          <h2 id="landing-verdicts" className="mt-2 text-2xl font-bold tracking-tight text-text">
            What a verdict can say
          </h2>
          <ul className="mt-5 grid gap-5 md:grid-cols-3">
            {OUTCOMES.map((item) => (
              <li key={item.outcome} className="rounded-lg border border-border bg-surface p-4">
                <VerdictStamp outcome={item.outcome} />
                <p className="mt-2 text-xs leading-relaxed text-text-2">{item.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-5 flex flex-wrap items-center gap-2 text-2xs text-text-3">
            Progress is a separate axis and is always achromatic:
            <ProgressStamp state="running">running</ProgressStamp>
            <ProgressStamp state="queued">queued</ProgressStamp>
            — a phase completing is not a finding.
          </p>
          <Button asChild variant="ghost" className="mt-6">
            <a href="/how-it-works">
              Read the methodology
              <ArrowRight aria-hidden="true" className="size-icon-sm" />
            </a>
          </Button>
        </div>
      </section>
    </>
  );
}

/**
 * The preview frame's resting state.
 *
 * A still frame with a play control rather than an autoplaying canvas: an audit
 * replay is a thing you WATCH, and starting one moves the viewer to the
 * workspace where the controls, the transcript and the inspector are. Autoplay
 * in a letterbox would be a video of the product instead of the product.
 */
function ReplayPoster({
  packages,
  onPlay,
}: {
  packages: string[];
  onPlay: (name: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <span aria-hidden="true" className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-danger" />
          <span className="size-2.5 rounded-full bg-accent" />
          <span className="size-2.5 rounded-full bg-safe" />
        </span>
        <span className="font-mono text-2xs text-text-3">audit · recorded frames</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-2xs tracking-wide text-accent-text uppercase">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
          replayable
        </span>
      </div>
      <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_260px]">
      <div className="relative min-h-[320px] overflow-hidden p-6">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage: "radial-gradient(circle, var(--ng-border) 1px, transparent 1.2px)",
            backgroundSize: "24px 24px",
          }}
        />
        <ol className="relative grid gap-2 font-mono text-2xs">
          {[
            ["package", "the tarball, as published"],
            ["126 files cleared", "coverage, not a safety claim"],
            ["setup.js:18–42", "reads credential-shaped env vars"],
            ["credential-theft hypothesis", "compiled into an experiment"],
            ["setup → run → evidence", "full-oracle sandbox"],
            ["CONFIRMED", "cites e147, e151"],
          ].map(([label, hint], index) => (
            <li
              key={label}
              className={cn(
                "flex flex-wrap items-baseline gap-x-2 rounded border border-border bg-surface px-2.5 py-1.5",
                index === 5 && "border-danger-border",
              )}
              style={{ marginInlineStart: `${Math.min(index, 4) * 16}px` }}
            >
              <span className={cn("text-text", index === 5 && "text-danger-text")}>{label}</span>
              <span className="text-text-3">{hint}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="border-t border-border p-4 md:border-t-0 md:border-l">
        <h3 className="text-2xs tracking-wide text-text-3 uppercase">Recorded audits</h3>
        <ul className="mt-2 grid gap-1">
          {packages.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => onPlay(name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  "text-xs text-text-2 hover:bg-sunken hover:text-text",
                )}
              >
                <Play aria-hidden="true" className="size-icon-sm shrink-0 text-text-3" />
                <span className="truncate font-mono">{name}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-2xs leading-relaxed text-text-3">
          Completed audits are public and linkable. Nothing here is paywalled.
        </p>
      </div>
      </div>
    </div>
  );
}
