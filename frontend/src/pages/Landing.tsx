/**
 * Landing (/) — the entry surface. Four calm sections on warm paper:
 *   1. Hero on .dot-grid + an AuditLaunchBar that drives store.startAudit
 *      (402 → /pay).
 *   2. A live-demo strip: fetchDemoPackages(); real recordings become
 *      "watch demo" buttons that reveal an inline, contract-faithful
 *      <MiniAuditFeed/> below the bar (never navigates away). An EMPTY demo
 *      list renders honestly — just the package input, no fake dropdown.
 *   3. A verdict legend (tone-quad chips + factual copy).
 *   4. A "how it works" trust band (pay → pipeline → verdict).
 *
 * Every stream transition is fold-derived in the store; this page only
 * orchestrates start + reveal. All classes are namespaced `.pg-landing-`;
 * everything else composes base.css primitives.
 */

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../lib/api-base.ts";
import { fetchDemoPackages } from "../lib/api.ts";
import { parsePackageInput } from "../lib/types.ts";
import { useAuditStore } from "../stores/auditStore.ts";
import { MiniAuditFeed } from "../components/audit/MiniAuditFeed.tsx";

export function Landing() {
  const navigate = useNavigate();
  const startAudit = useAuditStore((s) => s.startAudit);
  const startDemo = useAuditStore((s) => s.startDemo);
  const reset = useAuditStore((s) => s.reset);

  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [demos, setDemos] = useState<string[]>([]);
  const [demosLoaded, setDemosLoaded] = useState(false);
  const [activeDemo, setActiveDemo] = useState<string | null>(null);
  const [demoStarting, setDemoStarting] = useState(false);

  useEffect(() => {
    void fetchDemoPackages()
      .then((r) => setDemos(r.packages))
      .catch(() => setDemos([]))
      .finally(() => setDemosLoaded(true));
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

  async function onAudit(event: FormEvent) {
    event.preventDefault();
    const { name, version } = parsePackageInput(input);
    if (!name) return;
    setError(null);
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
      setError(err instanceof Error ? err.message : "Could not start the audit");
    } finally {
      setSubmitting(false);
    }
  }

  async function onDemo(pkg: string) {
    if (demoStarting) return;
    setError(null);
    setActiveDemo(pkg);
    setDemoStarting(true);
    try {
      await startDemo(pkg);
    } catch (err) {
      setActiveDemo(null);
      setError(err instanceof Error ? err.message : "Could not start the demo");
    } finally {
      setDemoStarting(false);
    }
  }

  return (
    <div className="page__inner pg-landing fade-up">
      {/* 1 — Hero + launch bar */}
      <section className="pg-landing-hero dot-grid">
        <div className="pg-landing-hero__copy">
          <span className="eyebrow">Don't trust. Verify.</span>
          <h1 className="headline headline--lg pg-landing-hero__title">
            Evidence-backed security verdicts for every npm package.
          </h1>
          <p className="subtext pg-landing-hero__lede">
            NpmGuard runs a package through an LLM&nbsp;+&nbsp;sandbox pipeline and
            returns a single verdict — <strong>SAFE</strong> or{" "}
            <strong>DANGEROUS</strong> — backed by confirmed, reproducible evidence.
          </p>

          <form className="pg-landing-launch" onSubmit={onAudit}>
            <input
              className="input input--mono pg-landing-launch__input"
              placeholder="express  ·  @scope/pkg@1.2.3"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              name="package"
              aria-label="Package to audit"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="btn btn--dark pg-landing-launch__btn"
              disabled={!input.trim() || submitting}
            >
              {submitting ? "Starting…" : "Audit"}
            </button>
          </form>

          <p className="microtext pg-landing-launch__hint">
            Name only audits the latest version, or pin one with{" "}
            <span className="mono">@version</span>.
          </p>

          {error ? (
            <div className="banner banner--danger pg-landing-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </section>

      {/* 2 — Live demo strip (honest when empty) */}
      <section className="pg-landing-demo">
        <div className="section-title">
          <span className="eyebrow">See it run</span>
        </div>

        {!demosLoaded ? (
          <div className="row pg-landing-demo__loading">
            <span className="spinner" aria-hidden="true" />
            <span className="microtext" role="status">
              Loading recorded audits…
            </span>
          </div>
        ) : demos.length > 0 ? (
          <>
            <p className="subtext pg-landing-demo__lede">
              Watch a real recorded run — same pipeline, same feed, no wallet
              required.
            </p>
            <div className="pg-landing-demo__pkgs" role="group" aria-label="Demo audits">
              {demos.map((pkg) => (
                <button
                  key={pkg}
                  type="button"
                  className={`btn btn--sm pg-landing-demo__pkg${
                    activeDemo === pkg ? " pg-landing-demo__pkg--on" : ""
                  }`}
                  onClick={() => void onDemo(pkg)}
                  disabled={demoStarting && activeDemo !== pkg}
                  aria-label={`watch demo audit of ${pkg}`}
                  aria-pressed={activeDemo === pkg}
                >
                  <span className="mono">{pkg}</span>
                </button>
              ))}
            </div>

            {activeDemo ? (
              <div className="pg-landing-demo__feed fade-up">
                <MiniAuditFeed />
              </div>
            ) : null}
          </>
        ) : (
          <p className="subtext pg-landing-demo__empty">
            No recorded audits available yet — enter any package above to run a
            live one.
          </p>
        )}
      </section>

      {/* 3 — Verdict legend */}
      <section className="pg-landing-legend">
        <div className="section-title">
          <span className="eyebrow">What the verdicts mean</span>
        </div>
        <div className="pg-landing-legend__grid">
          <div className="card pg-landing-legend__chip">
            <span className="pill pill--safe">Safe</span>
            <p className="subtext">
              No confirmed threat. Every hypothesis was refuted or found benign
              under sandbox execution.
            </p>
          </div>
          <div className="card pg-landing-legend__chip">
            <span className="pill pill--danger">Dangerous</span>
            <p className="subtext">
              At least one malicious behaviour was confirmed with reproducible
              evidence. Do not install.
            </p>
          </div>
          <div className="card pg-landing-legend__chip">
            <span className="pill pill--suspect">Suspect</span>
            <p className="subtext">
              A file shows a risky capability under review — a signal on the way
              to a verdict, not a verdict itself.
            </p>
          </div>
          <div className="card pg-landing-legend__chip">
            <span className="pill pill--running">Running</span>
            <p className="subtext">
              The audit is live — installing, scanning files, and testing
              hypotheses in an isolated sandbox.
            </p>
          </div>
        </div>
      </section>

      {/* 4 — How it works / trust band */}
      <section className="pg-landing-how">
        <div className="section-title">
          <span className="eyebrow">How it works</span>
        </div>
        <div className="pg-landing-how__grid">
          <div className="card pg-landing-how__step">
            <span className="eyebrow eyebrow--faint">01 · Pay</span>
            <h3 className="headline headline--sm">Pay per audit</h3>
            <p className="subtext">
              A flat fee per package — card or crypto on Base. Verification is
              server-side; the wallet signs, the engine verifies.
            </p>
          </div>
          <div className="card pg-landing-how__step">
            <span className="eyebrow eyebrow--faint">02 · Pipeline</span>
            <h3 className="headline headline--sm">LLM + sandbox</h3>
            <p className="subtext">
              The package is installed and scanned, capabilities are inferred,
              then risky hypotheses are executed in an isolated container.
            </p>
          </div>
          <div className="card pg-landing-how__step">
            <span className="eyebrow eyebrow--faint">03 · Verdict</span>
            <h3 className="headline headline--sm">Evidence, not vibes</h3>
            <p className="subtext">
              You get SAFE or DANGEROUS with a rationale, per-hypothesis
              resolutions, and the exact files behind the call.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
