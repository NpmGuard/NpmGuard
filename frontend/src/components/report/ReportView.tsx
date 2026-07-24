/**
 * ReportView — the ONE report surface, rendered by three call sites:
 *   - the durable Report page (source = query; no session file access),
 *   - the Live Audit verdict reveal (source = fold),
 *   - a compact registry / landing embed.
 * Prop-driven and self-contained. Never fabricates counts — honest "—" / factual
 * words where a metric doesn't exist.
 */

import type { AuditReport } from "../../lib/engine-types.ts";
import {
  bySeverityDesc,
  capabilitiesFromReport,
  confirmedHypotheses,
  notableFiles,
  totalTraceMs,
  verdictHeadline,
} from "../../lib/report-helpers.ts";
import { formatDuration } from "../../lib/format.ts";
import { VerdictSummary } from "./VerdictSummary.tsx";
import { HypothesisCard } from "./HypothesisCard.tsx";
import { FileSummaryRow } from "./FileSummaryRow.tsx";

export interface ReportViewProps {
  report: AuditReport;
  packageName: string;
  version: string;
  variant?: "full" | "compact";
  onOpenFile?: (path: string) => void;
}

const COMPACT_CONFIRMED_LIMIT = 3;

export function ReportView({
  report,
  packageName,
  version,
  variant = "full",
  onOpenFile,
}: ReportViewProps) {
  const compact = variant === "compact";
  const headline = verdictHeadline(report);
  const confirmed = confirmedHypotheses(report);
  const capabilities = capabilitiesFromReport(report);

  // File section: capability-bearing files first, then the rest.
  const notable = notableFiles(report);
  const notableSet = new Set(notable.map((f) => f.file));
  const orderedFiles = [...notable, ...report.fileSummaries.filter((f) => !notableSet.has(f.file))];

  const allHypotheses = bySeverityDesc(report.hypotheses);
  const traceMs = totalTraceMs(report);

  return (
    <section className={`report-view${compact ? " report-view--compact" : ""}`}>
      <header className="report-view__head">
        <span className="report-view__pkg mono">
          {packageName}
          {version ? <span className="report-view__ver">@{version}</span> : null}
        </span>
        <span className="report-view__headline">{headline}</span>
      </header>

      <VerdictSummary verdict={report.verdict} rationale={report.rationale} counts={report.counts} />

      {report.dealbreaker ? (
        <div className="banner banner--danger report-view__dealbreaker" role="alert">
          <span className="eyebrow eyebrow--danger">{report.dealbreaker.check}</span>
          <span>{report.dealbreaker.detail}</span>
        </div>
      ) : null}

      {compact ? (
        confirmed.length > 0 ? (
          <div className="report-section">
            <div className="eyebrow eyebrow--faint">Confirmed</div>
            <div className="report-section__cards">
              {confirmed.slice(0, COMPACT_CONFIRMED_LIMIT).map((h) => (
                <HypothesisCard key={h.hypId} hyp={h} />
              ))}
            </div>
            {confirmed.length > COMPACT_CONFIRMED_LIMIT ? (
              <p className="microtext report-section__more">
                +{confirmed.length - COMPACT_CONFIRMED_LIMIT} more
              </p>
            ) : null}
          </div>
        ) : null
      ) : (
        <>
          {capabilities.length > 0 ? (
            <div className="report-section">
              <div className="eyebrow eyebrow--faint">Observed capabilities</div>
              <div className="report-view__caps">
                {capabilities.map((cap) => (
                  <span key={cap} className="tag">
                    {cap}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="report-section">
            <div className="section-title">
              <span className="eyebrow">Hypotheses</span>
            </div>
            {allHypotheses.length === 0 ? (
              <p className="subtext report-empty-line">No hypotheses raised</p>
            ) : (
              <div className="report-section__cards">
                {allHypotheses.map((h) => (
                  <HypothesisCard key={h.hypId} hyp={h} />
                ))}
              </div>
            )}
          </div>

          <div className="report-section">
            <div className="section-title">
              <span className="eyebrow">Files analyzed</span>
            </div>
            {orderedFiles.length === 0 ? (
              <p className="subtext report-empty-line">No files summarized</p>
            ) : (
              <div className="report-files">
                {orderedFiles.map((summary) => (
                  <FileSummaryRow key={summary.file} summary={summary} onOpen={onOpenFile} />
                ))}
              </div>
            )}
          </div>

          {report.trace.length > 0 ? (
            <div className="report-section">
              <div className="section-title">
                <span className="eyebrow">Timing</span>
                <span className="microtext">Completed in {formatDuration(traceMs)}</span>
              </div>
              <ul className="report-trace">
                {report.trace.map((phase) => (
                  <li key={phase.phase} className="report-trace__row">
                    <span className="report-trace__phase mono">{phase.phase}</span>
                    <span className="report-trace__ms microtext">
                      {formatDuration(phase.durationMs)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
