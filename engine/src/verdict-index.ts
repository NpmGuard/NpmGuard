import { getDb, nowIso } from "./db.js";
import { listAllReports, setReportSavedHook } from "./report-store.js";
import { assessAuditReport } from "./proof-quality.js";

// Derived index of data/reports/ (spec §5.1): fast (name, version) → verdict
// lookups for rollups and cache-first scans. Report files stay authoritative;
// this table is rebuildable at any time and is refreshed by a saveReport hook.

/** Severity order for rollups (spec §5.10). Unknown strings rank as UNKNOWN. */
const SEVERITY: Record<string, number> = {
  SAFE: 0,
  UNKNOWN: 1,
  SUSPECT: 2,
  DANGEROUS: 3,
};

export function verdictSeverity(verdict: string | null | undefined): number {
  if (!verdict) return SEVERITY.UNKNOWN!;
  return SEVERITY[verdict] ?? SEVERITY.UNKNOWN!;
}

export function getVerdict(
  name: string,
  version: string,
): {
  verdict: string;
  reason: string;
  evidenceCount: number;
  auditedAt: string;
} | null {
  const row = getDb()
    .prepare(
      `SELECT verdict, reason, evidence_count, audited_at
       FROM package_verdicts WHERE name = ? AND version = ?`,
    )
    .get(name, version) as {
      verdict: string;
      reason: string;
      evidence_count: number;
      audited_at: string;
    } | undefined;
  return row
    ? {
        verdict: row.verdict,
        reason: row.reason,
        evidenceCount: row.evidence_count,
        auditedAt: row.audited_at,
      }
    : null;
}

export function upsertVerdict(
  name: string,
  version: string,
  verdict: string,
  reason = "",
  evidenceCount = 0,
  auditedAt: string = nowIso(),
): void {
  getDb()
    .prepare(
      `INSERT INTO package_verdicts (
         name, version, verdict, reason, evidence_count, audited_at
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, version) DO UPDATE SET
         verdict = excluded.verdict,
         reason = excluded.reason,
         evidence_count = excluded.evidence_count,
         audited_at = excluded.audited_at`,
    )
    .run(name, version, verdict, reason, evidenceCount, auditedAt);
}

/** Full rebuild from disk — run at startup; cheap at current report counts. */
export function rebuildVerdictIndex(): number {
  const reports = listAllReports();
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO package_verdicts (
       name, version, verdict, reason, evidence_count, audited_at
     )
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name, version) DO UPDATE SET
       verdict = excluded.verdict,
       reason = excluded.reason,
       evidence_count = excluded.evidence_count,
       audited_at = excluded.audited_at`,
  );
  db.transaction(() => {
    for (const r of reports) {
      upsert.run(
        r.packageName,
        r.version,
        r.verdict,
        r.reason,
        r.evidenceCount,
        r.auditedAt,
      );
    }
  })();
  console.log(`[verdict-index] rebuilt from ${reports.length} reports`);
  return reports.length;
}

/** Keep the index in sync as new reports land (any path: panel, CLI, CRE). */
export function installReportHook(): void {
  setReportSavedHook((packageName, version, report) => {
    try {
      const assessment = assessAuditReport(report);
      upsertVerdict(
        packageName,
        version,
        assessment.classification,
        assessment.summary,
        assessment.evidence.length,
      );
    } catch (err) {
      console.error("[verdict-index] hook failed:", err instanceof Error ? err.message : err);
    }
  });
}
