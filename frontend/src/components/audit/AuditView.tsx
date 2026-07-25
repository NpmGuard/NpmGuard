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
 * starting/queue status; running streams; done reveals the verdict; error is a
 * degraded state. Audit failure is an ERROR, never a SAFE verdict — and, since
 * the recomposition, never a RED one either: the run-status chip rendered
 * `pill--danger` "Failed", which is the same alarm colour a confirmed malicious
 * finding wears. See `VerdictReveal`'s header; the fix is the same there.
 *
 * ── §4.1's THREE ZONES ─────────────────────────────────────────────────────
 *
 * The brief's wireframe for this screen asks for an identity bar that never
 * moves, a sticky rail, a stream that is the only thing that scrolls, and — the
 * part that is easy to skip and is the reason the layout is worth following —
 * a verdict dock that is present from the first frame as an empty, labelled
 * slot, "so the verdict LANDS IN A PLACE THE EYE IS ALREADY WATCHING instead of
 * pushing the layout around when it arrives."
 *
 * The dock is therefore rendered unconditionally and labelled `Verdict` from
 * the first frame, holding an explicit "no verdict yet" line on the progress
 * axis while the audit runs. That line is also the honest one: an audit in
 * flight has no verdict, and an empty space says nothing at all.
 */

import { useAuditStore } from "../../stores/auditStore.ts";
import { PHASE_LABELS } from "../../lib/types.ts";
import { PanelPage, SectionLabel } from "../panel/layout.tsx";
import { Card } from "../ui/card.tsx";
import { DegradedSurface } from "../ui/degraded-state.tsx";
import { ProgressStamp, VerdictStamp } from "../ui/verdict-stamp.tsx";
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
  const replaying = useAuditStore((s) => s.replaying);
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
    // A dead link, not a failed package. `DegradedSurface` names it, keeps the
    // violet slot, and offers a way out — the three things §3.4 requires of a
    // surface-scale failure, and the reason this is no longer a hand-built box.
    return (
      <PanelPage>
        <DegradedSurface
          failure={{ what: "This audit", detail: error ?? undefined }}
          escape={{ label: "Back to home", href: "/" }}
        />
      </PanelPage>
    );
  }

  return (
    <PanelPage>
      {/* The identity bar never moves (§4.1): sticky at the top of the page
          plane, so the package under audit stays on screen while the stream
          scrolls under it. The `<h1>` names the page — an `aria-label` on the
          plane div would be dropped, since a bare div takes no accessible
          name. */}
      <header className="sticky top-0 z-10 -mx-4 grid gap-3 border-b border-border bg-canvas px-4 pt-1 pb-3 md:-mx-6 md:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {/* A replay is byte-identical to the run it replays, which is exactly why
              it has to say which one it is. "Live audit" over stored frames is the
              only untrue thing this view could say. */}
          <SectionLabel>{replaying ? "Replay" : "Live audit"}</SectionLabel>
          <h1 className="font-mono text-xl font-semibold break-all text-text">
            {packageName || "…"}
            {version ? <span className="text-text-3">@{version}</span> : null}
          </h1>
        </div>

        <PhaseRail />

        <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
          {status === "queued" ? (
            <ProgressStamp state="queued">{queuedText ?? "Starting…"}</ProgressStamp>
          ) : null}
          {status === "running" ? (
            <ProgressStamp state="running">
              {PHASE_LABELS[phase ?? ""] ?? "Running"}
            </ProgressStamp>
          ) : null}
          {/* "Completed" is PROGRESS — the run finished. It is deliberately not
              toned by the verdict: the verdict has its own dock below, and a
              green "Completed" chip beside a SAFE stamp doubles the green for a
              fact that is not about the package at all. */}
          {status === "done" ? <ProgressStamp state="queued">Completed</ProgressStamp> : null}
          {/* Violet, not red. The audit failed; the package is not implicated. */}
          {status === "error" ? <VerdictStamp outcome="ERROR" /> : null}
          {reconnecting ? (
            <span className="text-2xs text-text-3">Reconnecting…</span>
          ) : null}
        </div>
      </header>

      <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Pane label="Activity">
          <AuditFeed />
        </Pane>

        <aside className="grid gap-4">
          <Pane label="Files">
            <FileTree />
          </Pane>
          <Pane label="Hypotheses">
            <HypothesisList />
          </Pane>
        </aside>
      </div>

      {/* §4.1's verdict dock: present from the first frame as a labelled slot,
          so the verdict lands where the eye is already watching. */}
      <section aria-labelledby="audit-verdict-dock" className="mt-6">
        <h2 id="audit-verdict-dock">
          <SectionLabel>Verdict</SectionLabel>
        </h2>
        {verdict || error ? (
          <VerdictReveal />
        ) : (
          <p className="mt-2 text-sm text-text-3">
            No verdict yet — the audit is still running.
          </p>
        )}
      </section>
    </PanelPage>
  );
}

/** One titled pane of the audit layout. The head is a real heading so the
 * screen's three regions appear in a screen reader's heading list; they were
 * `<div>`s of styled spans, which left this page with one `<h1>` and nothing
 * else to navigate by. */
function Pane({ label, children }: { label: string; children: React.ReactNode }) {
  const id = `audit-pane-${label.toLowerCase()}`;
  return (
    <Card aria-labelledby={id} className="overflow-hidden">
      <div className="border-b border-border-faint px-3 py-2">
        <h2 id={id}>
          <SectionLabel>{label}</SectionLabel>
        </h2>
      </div>
      {children}
    </Card>
  );
}
