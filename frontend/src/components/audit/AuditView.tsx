/**
 * AuditView — the live streaming audit screen (the most important surface).
 * Hypothesis-centric: the dev engine streams phase / file / hypothesis events +
 * hypothesis_resolved (never agent transcripts). ALL stream state is derived in
 * the fold and read from useAuditStore — never re-derived here.
 *
 * Composition: page shell → AuditHeader (pkg@version + PhaseRail + run status)
 * → two-column layout (AuditFeed | side panel: FileTree + HypothesisList,
 * collapses to one column on narrow) → VerdictReveal at the terminal.
 *
 * Four render states keyed off the fold: queued (running, no phase yet) shows a
 * starting/queue status pill; running streams; done reveals the verdict; error
 * banners. Audit failure is an ERROR, never a SAFE verdict.
 */

import { useNavigate } from "react-router";
import { useAuditStore } from "../../stores/auditStore.ts";
import { PHASE_LABELS } from "../../lib/types.ts";
import { verdictTone } from "../../lib/report-helpers.ts";
import { PhaseRail } from "./PhaseRail.tsx";
import { AuditFeed } from "./AuditFeed.tsx";
import { FileTree } from "./FileTree.tsx";
import { HypothesisList } from "./HypothesisList.tsx";
import { VerdictReveal } from "./VerdictReveal.tsx";

type AuditStatus = "queued" | "running" | "done" | "error";

export function AuditView() {
  const packageName = useAuditStore((s) => s.packageName);
  const version = useAuditStore((s) => s.inventoryMeta?.metadata.version ?? null);
  const running = useAuditStore((s) => s.running);
  const phase = useAuditStore((s) => s.phase);
  const verdict = useAuditStore((s) => s.verdict);
  const error = useAuditStore((s) => s.error);
  const reconnecting = useAuditStore((s) => s.reconnecting);
  const reset = useAuditStore((s) => s.reset);
  const navigate = useNavigate();
  const queuedText = useAuditStore(
    (s) => s.pipelineLog.find((e) => e.text.startsWith("Queued · position"))?.text,
  );

  const status: AuditStatus = error
    ? "error"
    : verdict
      ? "done"
      : running && phase === null
        ? "queued"
        : "running";

  // An error with nothing ever streamed (e.g. a stale/expired /audit/:id link)
  // is a dead end, not a live audit — surface it honestly rather than render an
  // empty audit shell.
  if (status === "error" && !packageName && !running && !verdict && phase === null) {
    return (
      <div className="empty-state audit-view fade-up" role="alert" style={{ minHeight: "50vh" }}>
        <div className="empty-state__icon" aria-hidden="true">
          !
        </div>
        <p className="headline headline--sm">Audit unavailable</p>
        <p className="subtext">{error}</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            reset();
            navigate("/");
          }}
        >
          Back to home
        </button>
      </div>
    );
  }

  return (
    <section
      className="page__inner audit-view fade-up"
      aria-label={`live audit of ${packageName || "package"}`}
    >
      <header className="audit-header">
        <div className="audit-header__title">
          <span className="eyebrow">Live audit</span>
          <h1 className="headline mono audit-header__pkg">
            {packageName || "…"}
            {version ? <span className="audit-header__ver">@{version}</span> : null}
          </h1>
        </div>

        <PhaseRail />

        <div className="audit-runstatus" role="status" aria-live="polite">
          {status === "queued" ? (
            <span className="status-pill">
              <span className="spinner" aria-hidden="true" />
              <strong>{queuedText ?? "Starting…"}</strong>
            </span>
          ) : null}
          {status === "running" ? (
            <span className="pill pill--running">
              <span className="dot dot--running" aria-hidden="true" />
              {PHASE_LABELS[phase ?? ""] ?? "Running"}
            </span>
          ) : null}
          {status === "done" && verdict ? (
            <span className={`pill pill--${verdictTone(verdict)}`}>Completed</span>
          ) : null}
          {status === "error" ? <span className="pill pill--danger">Failed</span> : null}
          {reconnecting ? (
            <span className="microtext audit-runstatus__reconnect">Reconnecting…</span>
          ) : null}
        </div>
      </header>

      <div className="audit-layout">
        <div className="audit-layout__main card">
          <div className="audit-panel__head">
            <span className="eyebrow eyebrow--faint">Activity</span>
          </div>
          <AuditFeed />
        </div>

        <aside className="audit-side">
          <section className="card audit-side__section">
            <div className="audit-panel__head">
              <span className="eyebrow eyebrow--faint">Files</span>
            </div>
            <FileTree />
          </section>

          <section className="card audit-side__section">
            <div className="audit-panel__head">
              <span className="eyebrow eyebrow--faint">Hypotheses</span>
            </div>
            <HypothesisList />
          </section>
        </aside>
      </div>

      {verdict || error ? <VerdictReveal /> : null}
    </section>
  );
}
