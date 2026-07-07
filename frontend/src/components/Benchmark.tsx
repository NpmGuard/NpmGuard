import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

type BenchSource = "public" | "datadog";
type BenchCategory = "public" | "datadog-compromised" | "datadog-malicious-intent";

type BenchRow = {
  source?: BenchSource;
  packageName: string;
  version: string | null;
  fixtureName?: string | null;
  category?: BenchCategory;
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

const PUBLIC_FILTERS: Filter[] = ["all", "SAFE", "DANGEROUS", "timeout", "failed"];
const DATADOG_FILTERS: Filter[] = ["all", "detected", "missed", "timeout", "failed"];

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
    if (row.verdict === "DANGEROUS") return "detected";
    if (row.verdict === "SAFE") return "missed";
    return "unknown";
  }

  if (row.verdict === "DANGEROUS") return "DANGEROUS";
  if (row.verdict === "SAFE") return "SAFE";
  return row.status === "failed" ? "failed" : "unknown";
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
  return "Public npm";
}

function countOutcomes(rows: BenchRow[], source: BenchSource): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const outcome = rowOutcome(row, source);
    acc[outcome] = (acc[outcome] ?? 0) + 1;
    return acc;
  }, {});
}

function sourceSummary(runs: BenchRun[], source: BenchSource) {
  const matching = runs.filter((run) => runSource(run) === source);
  return {
    runs: matching.length,
    rows: matching.reduce((sum, run) => sum + run.totalRows, 0),
  };
}

export function Benchmark() {
  const [data, setData] = useState<BenchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<BenchSource>("datadog");
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
          payload.runs.find((run) => runSource(run) === "datadog" && run.totalRows > 0) ??
          payload.runs.find((run) => run.totalRows > 0) ??
          payload.runs[0] ??
          null;
        if (preferred) {
          setActiveSource(runSource(preferred));
          setActiveRunFile(preferred.file);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const runsForSource = useMemo(() => {
    if (!data) return [];
    return data.runs.filter((run) => runSource(run) === activeSource);
  }, [activeSource, data]);

  const activeRun = useMemo(() => {
    if (!data) return null;
    return runsForSource.find((run) => run.file === activeRunFile) ?? runsForSource[0] ?? data.runs[0] ?? null;
  }, [activeRunFile, data, runsForSource]);

  const rows = useMemo(() => {
    if (!activeRun) return [];
    return filter === "all"
      ? activeRun.rows
      : activeRun.rows.filter((row) => rowOutcome(row, runSource(activeRun)) === filter);
  }, [activeRun, filter]);

  if (error) return <StateMessage tone="var(--danger)" message={`Benchmark unavailable: ${error}`} />;
  if (!data) return <StateMessage message="Loading benchmark results..." />;
  if (!activeRun) return <StateMessage message="No benchmark result files found yet." />;

  const source = runSource(activeRun);
  const filterOptions = source === "datadog" ? DATADOG_FILTERS : PUBLIC_FILTERS;
  const outcomes = countOutcomes(activeRun.rows, source);
  const datadogSummary = sourceSummary(data.runs, "datadog");
  const publicSummary = sourceSummary(data.runs, "public");
  const confirmedRows = activeRun.rows.filter((row) => (row.confirmedProofs ?? 0) > 0).length;
  const compromised = activeRun.categoryCounts?.["datadog-compromised"] ?? 0;
  const malicious = activeRun.categoryCounts?.["datadog-malicious-intent"] ?? 0;
  const subtitle =
    source === "datadog"
      ? "Known malicious npm packages from Datadog's public corpus. Each row asks: did NpmGuard flag it, and how much evidence came back?"
      : "Production-like audits against currently published npm packages, used to watch latency and false positive risk.";

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
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <SourceButton
                  label="Malware corpus"
                  detail={`${datadogSummary.rows} rows`}
                  active={source === "datadog"}
                  onClick={() => {
                    const next = data.runs.find((run) => runSource(run) === "datadog");
                    setActiveSource("datadog");
                    setActiveRunFile(next?.file ?? null);
                    setFilter("all");
                  }}
                />
                <SourceButton
                  label="Public packages"
                  detail={`${publicSummary.rows} rows`}
                  active={source === "public"}
                  onClick={() => {
                    const next = data.runs.find((run) => runSource(run) === "public");
                    setActiveSource("public");
                    setActiveRunFile(next?.file ?? null);
                    setFilter("all");
                  }}
                />
              </div>
              <select
                value={activeRun.file}
                onChange={(e) => {
                  setActiveRunFile(e.target.value);
                  setFilter("all");
                }}
                style={{
                  width: "100%",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.75rem",
                  color: "var(--text)",
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 4,
                  padding: "8px 9px",
                }}
              >
                {runsForSource.map((run) => (
                  <option key={run.file} value={run.file}>
                    {run.file}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}>
            Updated {formatDate(activeRun.updatedAt)} - file {activeRun.file}
            {activeRun.datasetVersion ? ` - dataset ${activeRun.datasetVersion}` : ""}
            {activeRun.engineSha ? ` - engine ${activeRun.engineSha.slice(0, 12)}` : ""}
            {activeRun.watchlist ? ` - watchlist ${activeRun.watchlist}` : ""}
            {source === "datadog" ? ` - ${compromised} compromised / ${malicious} malicious-intent` : ""}
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
          {source === "datadog" ? (
            <>
              <Metric label="Rows" value={String(activeRun.totalRows)} />
              <Metric label="Detected" value={String(outcomes.detected ?? 0)} tone={outcomes.detected ? "var(--safe)" : undefined} />
              <Metric label="Missed" value={String(outcomes.missed ?? 0)} tone={outcomes.missed ? "var(--danger)" : undefined} />
              <Metric label="Test-confirmed" value={String(confirmedRows)} tone={confirmedRows ? "var(--accent-light)" : undefined} />
              <Metric label="Timeout" value={String(outcomes.timeout ?? 0)} tone={outcomes.timeout ? "var(--warning)" : undefined} />
              <Metric label="P95" value={formatDuration(activeRun.p95DurationMs)} />
            </>
          ) : (
            <>
              <Metric label="Rows" value={String(activeRun.totalRows)} />
              <Metric label="Safe" value={String(outcomes.SAFE ?? 0)} tone={outcomes.SAFE ? "var(--safe)" : undefined} />
              <Metric label="Dangerous" value={String(outcomes.DANGEROUS ?? 0)} tone={outcomes.DANGEROUS ? "var(--danger)" : undefined} />
              <Metric label="Timeout" value={String(outcomes.timeout ?? 0)} tone={outcomes.timeout ? "var(--warning)" : undefined} />
              <Metric label="Failed" value={String(outcomes.failed ?? 0)} tone={outcomes.failed ? "var(--text-muted)" : undefined} />
              <Metric label="P95" value={formatDuration(activeRun.p95DurationMs)} />
            </>
          )}
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
          <SectionHeader title="Result rows" right={`${rows.length}/${activeRun.rows.length} shown`} />
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

          <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
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
                {rows.map((row) => (
                  <tr key={rowKey(row)} style={{ borderBottom: "1px solid var(--border)" }}>
                    <Td strong style={{ maxWidth: 340, overflowWrap: "anywhere" }}>
                      {row.packageName}
                    </Td>
                    <Td>{source === "datadog" ? categoryLabel(row.category) : row.version ?? "-"}</Td>
                    <Td><OutcomeBadge row={row} source={source} /></Td>
                    <Td>{evidenceText(row, source)}</Td>
                    <Td style={{ textAlign: "right" }}>{formatDuration(row.durationMs)}</Td>
                    <Td muted style={{ maxWidth: 340, overflowWrap: "anywhere" }}>
                      {notesText(row, source)}
                    </Td>
                  </tr>
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

function SourceButton({
  label,
  detail,
  active,
  onClick,
}: {
  label: string;
  detail: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: 0,
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "var(--accent-bg)" : "var(--bg-secondary)",
        color: active ? "var(--accent-light)" : "var(--text)",
        borderRadius: 6,
        padding: "9px 10px",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", fontWeight: 800 }}>
        {label}
      </div>
      <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "0.66rem", color: "var(--text-muted)" }}>
        {detail}
      </div>
    </button>
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
  return <th style={{ padding: "9px 10px", color: "var(--text-muted)", textAlign: "left", fontWeight: 700, ...style }}>{children}</th>;
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
