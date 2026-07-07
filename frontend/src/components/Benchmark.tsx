import { Fragment, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

type BenchSource = "public" | "datadog";
type BenchCategory = "public" | "datadog-compromised" | "datadog-malicious-intent" | "baseline";

type BenchRow = {
  source?: BenchSource;
  packageName: string;
  version: string | null;
  fixtureName?: string | null;
  category?: BenchCategory;
  expectedVerdict?: "SAFE" | "DANGEROUS" | null;
  status: string;
  verdict: string | null;
  durationMs: number;
  error: string | null;
  capabilities?: string[];
  proofKinds?: string[];
  verifiedCapabilities?: string[];
  confirmedProofs?: number;
  runIndex?: number | null;
};

type BenchRun = {
  file: string;
  source?: BenchSource;
  updatedAt: string;
  startedAt: string | null;
  completedAt?: string | null;
  watchlist: string | null;
  datasetVersion?: string | null;
  engineSha?: string | null;
  modelId?: string | null;
  packageCount: number | null;
  limit: number | null;
  resultLimit: number | null;
  dryRun: boolean;
  counts: Record<string, number>;
  verdictCounts: Record<string, number>;
  categoryCounts?: Record<string, number>;
  totalRows: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  slowest: BenchRow[];
  rows: BenchRow[];
};

type BenchResponse = {
  runs: BenchRun[];
  resultsDir: string;
};

type Outcome = "SAFE" | "DANGEROUS" | "timeout" | "failed" | "detected" | "missed" | "unknown";
type Filter = "all" | Outcome;
type ExpectedGroup = "DANGEROUS" | "SAFE";

const PUBLIC_FILTERS: Filter[] = ["all", "SAFE", "DANGEROUS", "timeout", "failed"];
const DATADOG_FILTERS: Filter[] = ["all", "detected", "missed", "SAFE", "DANGEROUS", "timeout", "failed"];

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  SAFE: "Safe",
  DANGEROUS: "Dangerous",
  timeout: "Timeout",
  failed: "Failed",
  detected: "Detected",
  missed: "Missed",
  unknown: "Unknown",
};

function runSource(run: BenchRun): BenchSource {
  return run.source ?? run.rows[0]?.source ?? "public";
}

function benchmarkName(file: string): string {
  if (file === "v1.json") return "Benchmark v1";
  if (file === "v1.1.json") return "Benchmark v1.1";
  return file.replace(/\.json$/i, "");
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rowKey(row: BenchRow): string {
  return `${row.packageName}@${row.version ?? "unknown"}:${row.runIndex ?? 0}`;
}

function rowOutcome(row: BenchRow, source: BenchSource): Outcome {
  if (row.status === "timeout") return "timeout";
  if (row.status === "failed") return "failed";

  if (source === "datadog") {
    if (row.expectedVerdict === "SAFE") {
      if (row.verdict === "SAFE") return "SAFE";
      if (row.verdict === "DANGEROUS") return "DANGEROUS";
      return "unknown";
    }
    if (row.verdict === "DANGEROUS") return "detected";
    if (row.verdict === "SAFE") return "missed";
    return "unknown";
  }

  if (row.verdict === "DANGEROUS") return "DANGEROUS";
  if (row.verdict === "SAFE") return "SAFE";
  return row.status === "failed" ? "failed" : "unknown";
}

function expectedGroup(row: BenchRow): ExpectedGroup {
  return row.expectedVerdict ?? (row.source === "datadog" ? "DANGEROUS" : "SAFE");
}

function expectedGroupLabel(group: ExpectedGroup): string {
  return group === "DANGEROUS" ? "Expected dangerous" : "Expected safe";
}

function badgeColors(outcome: Outcome) {
  if (outcome === "SAFE" || outcome === "detected") {
    return { color: "var(--safe)", bg: "var(--safe-bg)" };
  }
  if (outcome === "DANGEROUS" || outcome === "missed") {
    return { color: "var(--danger)", bg: "var(--danger-bg)" };
  }
  if (outcome === "timeout") {
    return { color: "var(--warning)", bg: "var(--suspected-bg)" };
  }
  return { color: "var(--text-muted)", bg: "var(--bg-tertiary)" };
}

function categoryLabel(category: BenchCategory | undefined): string {
  if (category === "datadog-compromised") return "Compromised lib";
  if (category === "datadog-malicious-intent") return "Malicious intent";
  if (category === "baseline") return "Safe baseline";
  return "Public npm";
}

function countOutcomes(rows: BenchRow[], source: BenchSource): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const outcome = rowOutcome(row, source);
    acc[outcome] = (acc[outcome] ?? 0) + 1;
    return acc;
  }, {});
}

function groupRowsByExpectation(rows: BenchRow[]): Array<{ group: ExpectedGroup; rows: BenchRow[] }> {
  const groups: Record<ExpectedGroup, BenchRow[]> = {
    DANGEROUS: [],
    SAFE: [],
  };

  for (const row of rows) {
    groups[expectedGroup(row)].push(row);
  }

  return (["DANGEROUS", "SAFE"] as ExpectedGroup[])
    .filter((group) => groups[group].length > 0)
    .map((group) => ({ group, rows: groups[group] }));
}

export function Benchmark() {
  const [data, setData] = useState<BenchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeRunFile, setActiveRunFile] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    fetch("/api/bench/results")
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json() as Promise<BenchResponse>;
      })
      .then((payload) => {
        setData(payload);
        const preferred =
          payload.runs.find((run) => run.file === "v1.json") ??
          payload.runs.find((run) => runSource(run) === "datadog" && run.totalRows > 0) ??
          payload.runs.find((run) => run.totalRows > 0) ??
          payload.runs[0] ??
          null;
        if (preferred) {
          setActiveRunFile(preferred.file);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const selectableRuns = useMemo(() => data?.runs.filter((run) => run.totalRows > 0) ?? [], [data]);

  const activeRun = useMemo(() => {
    if (!data) return null;
    return data.runs.find((run) => run.file === activeRunFile) ?? selectableRuns[0] ?? data.runs[0] ?? null;
  }, [activeRunFile, data, selectableRuns]);

  const rows = useMemo(() => {
    if (!activeRun) return [];
    return filter === "all"
      ? activeRun.rows
      : activeRun.rows.filter((row) => rowOutcome(row, runSource(activeRun)) === filter);
  }, [activeRun, filter]);

  const groupedRows = useMemo(() => groupRowsByExpectation(rows), [rows]);

  if (error) return <StateMessage tone="var(--danger)" message={`Benchmark unavailable: ${error}`} />;
  if (!data) return <StateMessage message="Loading benchmark results..." />;
  if (!activeRun) return <StateMessage message="No benchmark result files found yet." />;

  const source = runSource(activeRun);
  const filterOptions = source === "datadog" ? DATADOG_FILTERS : PUBLIC_FILTERS;
  const outcomes = countOutcomes(activeRun.rows, source);
  const expectedDangerous = activeRun.rows.filter((row) => expectedGroup(row) === "DANGEROUS").length;
  const expectedSafe = activeRun.rows.filter((row) => expectedGroup(row) === "SAFE").length;
  const dangerousOutcomes = countOutcomes(
    activeRun.rows.filter((row) => expectedGroup(row) === "DANGEROUS"),
    source,
  );
  const safeOutcomes = countOutcomes(
    activeRun.rows.filter((row) => expectedGroup(row) === "SAFE"),
    source,
  );
  const detectedCount = source === "datadog" ? dangerousOutcomes.detected ?? 0 : outcomes.DANGEROUS ?? 0;
  const missedCount = source === "datadog" ? dangerousOutcomes.missed ?? 0 : 0;
  const cleanCount = source === "datadog" ? safeOutcomes.SAFE ?? 0 : outcomes.SAFE ?? 0;
  const falsePositiveCount = source === "datadog" ? safeOutcomes.DANGEROUS ?? 0 : outcomes.DANGEROUS ?? 0;
  const compromised = activeRun.categoryCounts?.["datadog-compromised"] ?? 0;
  const malicious = activeRun.categoryCounts?.["datadog-malicious-intent"] ?? 0;
  const baseline = activeRun.categoryCounts?.baseline ?? 0;
  const subtitle =
    "One benchmark run, grouped by expected package behavior. Dangerous samples measure recall; safe samples measure false-positive risk.";

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "28px", minWidth: 0 }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <header style={{ marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              alignItems: "flex-start",
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            <div style={{ maxWidth: 720 }}>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.7rem",
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginBottom: 8,
                }}
              >
                Evidence bench
              </div>
              <h1
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "1.75rem",
                  fontWeight: 750,
                  marginBottom: 7,
                  letterSpacing: 0,
                }}
              >
                Benchmark results
              </h1>
              <p style={{ color: "var(--text-dim)", lineHeight: 1.5 }}>
                {subtitle}
              </p>
            </div>

            <div style={{ minWidth: 280, maxWidth: 430, flex: "1 1 300px" }}>
              <RunPicker
                runs={selectableRuns.length > 0 ? selectableRuns : data.runs}
                activeFile={activeRun.file}
                onSelect={(file) => {
                  setActiveRunFile(file);
                  setFilter("all");
                }}
              />
            </div>
          </div>

          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}>
            Updated {formatDate(activeRun.updatedAt)} - {benchmarkName(activeRun.file)}
            {activeRun.datasetVersion ? ` - dataset ${activeRun.datasetVersion}` : ""}
            {activeRun.engineSha ? ` - engine ${activeRun.engineSha.slice(0, 12)}` : ""}
            {activeRun.watchlist ? ` - watchlist ${activeRun.watchlist}` : ""}
            {source === "datadog" ? ` - ${compromised} compromised / ${malicious} malicious-intent / ${baseline} safe` : ""}
          </div>
        </header>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(138px, 1fr))",
            gap: 10,
            marginBottom: 20,
          }}
        >
          <Metric label="Rows" value={String(activeRun.totalRows)} />
          <Metric label="Expected dangerous" value={String(expectedDangerous)} tone={expectedDangerous ? "var(--danger)" : undefined} />
          <Metric label="Detected" value={String(detectedCount)} tone={detectedCount ? "var(--safe)" : undefined} />
          <Metric label="Missed" value={String(missedCount)} tone={missedCount ? "var(--danger)" : undefined} />
          <Metric label="Expected safe" value={String(expectedSafe)} tone={expectedSafe ? "var(--safe)" : undefined} />
          <Metric label="False positives" value={String(falsePositiveCount)} tone={falsePositiveCount ? "var(--danger)" : undefined} />
          <Metric label="Clean safe" value={String(cleanCount)} tone={cleanCount ? "var(--safe)" : undefined} />
          <Metric label="P95" value={formatDuration(activeRun.p95DurationMs)} />
        </section>

        <section style={{ marginBottom: 22 }}>
          <SectionHeader title="Slowest rows" right={`avg ${formatDuration(activeRun.avgDurationMs)}`} />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            {activeRun.slowest.slice(0, 8).map((row) => (
              <SlowCard key={rowKey(row)} row={row} source={source} />
            ))}
          </div>
        </section>

        <section>
          <SectionHeader title="Benchmark rows" right={`${rows.length}/${activeRun.rows.length} shown`} />
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {filterOptions.map((item) => (
              <button
                key={item}
                onClick={() => setFilter(item)}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  padding: "5px 10px",
                  borderRadius: 4,
                  border: `1px solid ${filter === item ? "var(--accent)" : "var(--border-strong)"}`,
                  background: filter === item ? "var(--accent-bg)" : "var(--bg-secondary)",
                  color: filter === item ? "var(--accent-light)" : "var(--text-dim)",
                  cursor: "pointer",
                }}
              >
                {FILTER_LABELS[item]}
              </button>
            ))}
          </div>

          <div
            style={{
              overflow: "auto",
              border: "1px solid var(--border)",
              borderRadius: 6,
              maxHeight: "min(560px, calc(100vh - 430px))",
              minHeight: 260,
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono)",
                fontSize: "0.76rem",
                minWidth: 900,
              }}
            >
              <thead>
                <tr style={{ background: "var(--bg-secondary)", borderBottom: "1px solid var(--border)" }}>
                  <Th>Package</Th>
                  <Th>{source === "datadog" ? "Class" : "Version"}</Th>
                  <Th>Outcome</Th>
                  <Th>Evidence</Th>
                  <Th style={{ textAlign: "right" }}>Duration</Th>
                  <Th>Notes</Th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map(({ group, rows: groupItems }) => (
                  <Fragment key={group}>
                    <tr>
                      <td
                        colSpan={6}
                        style={{
                          position: "sticky",
                          top: 34,
                          zIndex: 1,
                          background: "var(--bg-tertiary)",
                          borderBottom: "1px solid var(--border)",
                          padding: "7px 10px",
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.7rem",
                          fontWeight: 800,
                          color: group === "DANGEROUS" ? "var(--danger)" : "var(--safe)",
                          textTransform: "uppercase",
                        }}
                      >
                        {expectedGroupLabel(group)} - {groupItems.length} rows
                      </td>
                    </tr>
                    {groupItems.map((row) => (
                      <tr key={rowKey(row)} style={{ borderBottom: "1px solid var(--border)" }}>
                        <Td strong style={{ maxWidth: 340, overflowWrap: "anywhere" }}>
                          {row.packageName}
                        </Td>
                        <Td>{row.source === "datadog" ? categoryLabel(row.category) : row.version ?? "-"}</Td>
                        <Td><OutcomeBadge row={row} source={source} /></Td>
                        <Td>{evidenceText(row, source)}</Td>
                        <Td style={{ textAlign: "right" }}>{formatDuration(row.durationMs)}</Td>
                        <Td muted style={{ maxWidth: 340, overflowWrap: "anywhere" }}>
                          {notesText(row, source)}
                        </Td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function evidenceText(row: BenchRow, source: BenchSource): string {
  if (source === "public") return row.status;
  const confirmed = row.confirmedProofs ?? 0;
  if (confirmed > 0) return `${confirmed} test-confirmed`;
  const proofs = row.proofKinds?.length ?? 0;
  if (proofs > 0) return `${proofs} proof attempts`;
  return row.status;
}

function notesText(row: BenchRow, source: BenchSource): string {
  if (row.error) return row.error.slice(0, 120);
  if (source === "public") return row.verdict ?? "-";
  const caps = row.capabilities ?? [];
  if (caps.length === 0) return "-";
  return caps.slice(0, 4).join(", ");
}

function RunPicker({
  runs,
  activeFile,
  onSelect,
}: {
  runs: BenchRun[];
  activeFile: string;
  onSelect: (file: string) => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border-strong)",
        borderRadius: 6,
        background: "var(--bg-secondary)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.68rem",
          color: "var(--text-muted)",
          textTransform: "uppercase",
        }}
      >
        Benchmark
      </div>
      <div style={{ maxHeight: 154, overflowY: "auto" }}>
        {runs.map((run) => {
          const active = run.file === activeFile;
          return (
            <button
              key={run.file}
              type="button"
              onClick={() => onSelect(run.file)}
              style={{
                width: "100%",
                border: 0,
                borderBottom: "1px solid var(--border)",
                background: active ? "var(--accent-bg)" : "transparent",
                color: active ? "var(--accent-light)" : "var(--text)",
                cursor: "pointer",
                textAlign: "left",
                padding: "9px 10px",
              }}
            >
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", fontWeight: 800 }}>
                {benchmarkName(run.file)}
              </div>
              <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "0.66rem", color: "var(--text-muted)" }}>
                {run.totalRows} rows
                {run.counts.detected != null ? ` - ${run.counts.detected} detected` : ""}
                {run.counts.missed != null ? ` - ${run.counts.missed} missed` : ""}
                {run.counts.clean != null ? ` - ${run.counts.clean} clean` : ""}
                {run.counts.false_positive != null ? ` - ${run.counts.false_positive} fp` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, tone = "var(--text)" }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 6, padding: 14 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-heading)", fontSize: "1.45rem", fontWeight: 750, color: tone, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

function SlowCard({ row, source }: { row: BenchRow; source: BenchSource }) {
  return (
    <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", borderRadius: 6, padding: 12, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.packageName}
        </div>
        <OutcomeBadge row={row} source={source} compact />
      </div>
      <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "0.72rem" }}>
        {source === "datadog" ? categoryLabel(row.category) : row.version ?? "-"} - {formatDuration(row.durationMs)}
      </div>
    </div>
  );
}

function OutcomeBadge({ row, source, compact = false }: { row: BenchRow; source: BenchSource; compact?: boolean }) {
  const outcome = rowOutcome(row, source);
  const colors = badgeColors(outcome);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: compact ? 0 : 84,
        fontFamily: "var(--font-mono)",
        fontSize: "0.68rem",
        fontWeight: 800,
        padding: compact ? "2px 6px" : "3px 8px",
        borderRadius: 4,
        color: colors.color,
        background: colors.bg,
        border: `1px solid ${colors.color}40`,
      }}
    >
      {FILTER_LABELS[outcome].toUpperCase()}
    </span>
  );
}

function SectionHeader({ title, right }: { title: string; right?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, gap: 12 }}>
      <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "1rem", fontWeight: 700 }}>{title}</h2>
      {right && <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}>{right}</span>}
    </div>
  );
}

function Th({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <th
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        background: "var(--bg-secondary)",
        padding: "9px 10px",
        color: "var(--text-muted)",
        textAlign: "left",
        fontWeight: 700,
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  strong = false,
  muted = false,
  style,
}: {
  children: ReactNode;
  strong?: boolean;
  muted?: boolean;
  style?: CSSProperties;
}) {
  return (
    <td style={{ padding: "9px 10px", color: muted ? "var(--text-muted)" : "var(--text)", fontWeight: strong ? 650 : 400, verticalAlign: "top", ...style }}>
      {children}
    </td>
  );
}

function StateMessage({ message, tone = "var(--text-dim)" }: { message: string; tone?: string }) {
  return (
    <div style={{ flex: 1, display: "grid", placeItems: "center", color: tone, fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
      {message}
    </div>
  );
}
