/**
 * ReportView — the ONE report surface, rendered by three call sites:
 *   - the durable Report page (source = query; no session file access),
 *   - the Live Audit verdict reveal (source = fold),
 *   - a compact registry / landing embed.
 * Prop-driven and self-contained. Never fabricates counts — honest "—" / factual
 * words where a metric doesn't exist.
 *
 * ── IT NO LONGER RENDERS AN IDENTITY HEADER, OR A HEADLINE ─────────────────
 *
 * Both were duplicates once `VerdictHeadline` landed. Every call site already
 * shows `package@version` in its own chrome — the report page's header, the
 * audit view's identity bar — so this component was printing it a second time
 * two lines below. And the one-line headline ("No known threats" / "N confirmed
 * threats") is now said better, and MANDATORILY, by the verdict's own caveat and
 * coverage line, which a page cannot forget to render. Two components saying the
 * same thing is how they eventually say different things.
 *
 * `verdictHeadline()` went with it: this was its only caller, and a helper kept
 * alive for nobody is the same dead weight as a dead branch. The `packageName`
 * and `version` props went too — nothing here reads them any more, and a prop
 * every call site dutifully threads to nowhere is a small lie about what this
 * component needs.
 */

import type { AuditReport } from "@npmguard/shared";
import {
  byImportanceDesc,
  capabilitiesFromReport,
  confirmedHypotheses,
  notableFiles,
  totalTraceMs,
} from "../../lib/report-helpers.ts";
import { formatDuration } from "../../lib/format.ts";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import { SectionLabel } from "../panel/layout.tsx";
import { VerdictSummary } from "./VerdictSummary.tsx";
import { HypothesisCard } from "./HypothesisCard.tsx";
import { FileSummaryRow } from "./FileSummaryRow.tsx";

export interface ReportViewProps {
  report: AuditReport;
  variant?: "full" | "compact";
  onOpenFile?: (path: string) => void;
}

const COMPACT_CONFIRMED_LIMIT = 3;

export function ReportView({ report, variant = "full", onOpenFile }: ReportViewProps) {
  const compact = variant === "compact";
  const confirmed = confirmedHypotheses(report);
  const capabilities = capabilitiesFromReport(report);

  // File section: capability-bearing files first, then the rest.
  const notable = notableFiles(report);
  const notableSet = new Set(notable.map((f) => f.file));
  const orderedFiles = [...notable, ...report.fileSummaries.filter((f) => !notableSet.has(f.file))];

  // Most important first: a CONFIRMED finding, then what could not be decided,
  // then live work, and the refuted ones last. Severity alone ranked thirteen
  // disproved CRITICALs above the one real threat.
  const allHypotheses = byImportanceDesc(report.hypotheses);
  const traceMs = totalTraceMs(report);

  return (
    <section className="grid gap-4">
      <VerdictSummary verdict={report.verdict} rationale={report.rationale} counts={report.counts} />

      {report.dealbreaker ? (
        // The one place on this surface that keeps full danger red, and it earns
        // it: a dealbreaker IS a claim about the package, which is exactly what
        // §0 rule 3 reserves red for.
        <Card severity="danger" role="alert" className="grid gap-1 p-4">
          <span className="font-mono text-2xs font-medium tracking-wide text-danger-text uppercase">
            {report.dealbreaker.check}
          </span>
          <span className="text-sm text-text">{report.dealbreaker.detail}</span>
        </Card>
      ) : null}

      {compact ? (
        confirmed.length > 0 ? (
          <Section label="Confirmed">
            <div className="grid gap-2">
              {confirmed.slice(0, COMPACT_CONFIRMED_LIMIT).map((h) => (
                <HypothesisCard key={h.hypId} hyp={h} />
              ))}
            </div>
            {confirmed.length > COMPACT_CONFIRMED_LIMIT ? (
              <p className="text-2xs text-text-3">
                +{confirmed.length - COMPACT_CONFIRMED_LIMIT} more
              </p>
            ) : null}
          </Section>
        ) : null
      ) : (
        <>
          {capabilities.length > 0 ? (
            <Section label="Observed capabilities">
              <div className="flex flex-wrap gap-1">
                {capabilities.map((cap) => (
                  <Badge key={cap}>{cap}</Badge>
                ))}
              </div>
            </Section>
          ) : null}

          <Section label="Hypotheses">
            {allHypotheses.length === 0 ? (
              <p className="text-sm text-text-3">No hypotheses raised</p>
            ) : (
              <div className="grid gap-2">
                {allHypotheses.map((h) => (
                  <HypothesisCard key={h.hypId} hyp={h} />
                ))}
              </div>
            )}
          </Section>

          <Section label="Files analyzed">
            {orderedFiles.length === 0 ? (
              <p className="text-sm text-text-3">No files summarized</p>
            ) : (
              <Card className="overflow-hidden">
                {orderedFiles.map((summary) => (
                  <FileSummaryRow key={summary.file} summary={summary} onOpen={onOpenFile} />
                ))}
              </Card>
            )}
          </Section>

          {report.trace.length > 0 ? (
            <Section label="Timing" meta={`Completed in ${formatDuration(traceMs)}`}>
              <Card className="overflow-hidden">
                {report.trace.map((phase) => (
                  <div
                    key={phase.phase}
                    className="flex items-center justify-between gap-3 border-b border-border-faint px-3 py-1.5 last:border-b-0"
                  >
                    <span className="font-mono text-2xs text-text-2">{phase.phase}</span>
                    <span className="font-mono text-2xs tabular-nums text-text-3">
                      {formatDuration(phase.durationMs)}
                    </span>
                  </div>
                ))}
              </Card>
            </Section>
          ) : null}
        </>
      )}
    </section>
  );
}

/** A titled report section. The label is a real `<h3>` — these were `<div>`s of
 * styled spans, so a screen reader's heading list on the product's most
 * information-dense page contained the package name and nothing else. */
function Section({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3>
          <SectionLabel>{label}</SectionLabel>
        </h3>
        {meta ? <span className="text-2xs text-text-3">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
