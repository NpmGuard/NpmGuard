import { getDb, nowIso } from "./db.js";
import { listAllReports, setReportSavedHook } from "./report-store.js";
import { classifyAuditReport } from "./proof-quality.js";

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
): { verdict: string; auditedAt: string } | null {
  const row = getDb()
    .prepare("SELECT verdict, audited_at FROM package_verdicts WHERE name = ? AND version = ?")
    .get(name, version) as { verdict: string; audited_at: string } | undefined;
  return row ? { verdict: row.verdict, auditedAt: row.audited_at } : null;
}

export function upsertVerdict(
  name: string,
  version: string,
  verdict: string,
  auditedAt: string = nowIso(),
): void {
  getDb()
    .prepare(
      `INSERT INTO package_verdicts (name, version, verdict, audited_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name, version) DO UPDATE SET
         verdict = excluded.verdict, audited_at = excluded.audited_at`,
    )
    .run(name, version, verdict, auditedAt);
}

/** Full rebuild from disk — run at startup; cheap at current report counts. */
export function rebuildVerdictIndex(): number {
  const reports = listAllReports();
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO package_verdicts (name, version, verdict, audited_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name, version) DO UPDATE SET
       verdict = excluded.verdict, audited_at = excluded.audited_at`,
  );
  db.transaction(() => {
    for (const r of reports) {
      upsert.run(r.packageName, r.version, r.verdict, r.auditedAt);
    }
  })();
  console.log(`[verdict-index] rebuilt from ${reports.length} reports`);
  return reports.length;
}

/** Keep the index in sync as new reports land (any path: panel, CLI, CRE). */
export function installReportHook(): void {
  setReportSavedHook((packageName, version, report) => {
    try {
      upsertVerdict(packageName, version, classifyAuditReport(report));
    } catch (err) {
      console.error("[verdict-index] hook failed:", err instanceof Error ? err.message : err);
    }
  });
}
