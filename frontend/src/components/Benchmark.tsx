import { useEffect, useMemo, useState } from "react";

type ProofKind =
  | "TEST_CONFIRMED"
  | "TEST_UNCONFIRMED"
  | "AI_DYNAMIC"
  | "AI_STATIC"
  | "STRUCTURAL";

interface BenchRun {
  durationMs: number;
  verdict: "DANGEROUS" | "SAFE" | "UNKNOWN";
  capabilities: string[];
  proofKinds: ProofKind[];
  verifiedCapabilities: string[];
  llmTokens: number | null;
  auditId: string | null;
  error: string | null;
}

interface BenchResult {
  fixtureName: string;
  runs: BenchRun[];
}

interface BenchData {
  datasetVersion: string;
  engineSha: string;
  modelId: string;
  startedAt: string;
  completedAt: string;
  results: BenchResult[];
}

type Outcome =
  | "TEST_CONFIRMED"
  | "TEST_UNCONFIRMED_ONLY"
  | "AI_ONLY"
  | "STRUCTURAL_ONLY"
  | "TIMEOUT"
  | "MISSED";

const OUTCOME_META: Record<Outcome, { color: string; label: string; desc: string }> = {
  TEST_CONFIRMED: {
    color: "#16a34a",
    label: "Proof-tested",
    desc: "Vitest exploit reproduced the malicious behavior in a sandbox",
  },
  TEST_UNCONFIRMED_ONLY: {
    color: "#ca8a04",
    label: "Test failed",
    desc: "Test was generated but assertions didn't pass — usually mock or timing issue",
  },
  AI_ONLY: {
    color: "#2563eb",
    label: "AI-evidenced",
    desc: "Agent observed the behavior at runtime or matched a pattern statically; no test ran",
  },
  STRUCTURAL_ONLY: {
    color: "#5b21b6",
    label: "Structural",
    desc: "Dealbreaker hit in inventory phase (e.g. preinstall hook); no investigation needed",
  },
  TIMEOUT: {
    color: "#9e9787",
    label: "Timeout",
    desc: "Hit the 60-min audit timeout — usually heavily obfuscated multi-stage payloads",
  },
  MISSED: {
    color: "#dc2626",
    label: "Missed",
    desc: "Engine returned SAFE on a known-malicious package",
  },
};

function classifyRun(run: BenchRun): Outcome {
  if (run.error) return "TIMEOUT";
  if (run.verdict !== "DANGEROUS") return "MISSED";
  const k = run.proofKinds ?? [];
  if (k.includes("TEST_CONFIRMED")) return "TEST_CONFIRMED";
  if (k.includes("TEST_UNCONFIRMED")) return "TEST_UNCONFIRMED_ONLY";
  if (k.includes("AI_DYNAMIC") || k.includes("AI_STATIC")) return "AI_ONLY";
  if (k.includes("STRUCTURAL")) return "STRUCTURAL_ONLY";
  return "AI_ONLY";
}

function countKinds(kinds: ProofKind[]) {
  const c: Record<ProofKind, number> = {
    TEST_CONFIRMED: 0,
    TEST_UNCONFIRMED: 0,
    AI_DYNAMIC: 0,
    AI_STATIC: 0,
    STRUCTURAL: 0,
  };
  for (const k of kinds) c[k]++;
  return c;
}

export function Benchmark() {
  const [data, setData] = useState<BenchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Outcome | "all">("all");

  useEffect(() => {
    fetch("/bench-v2.json")
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch((e) => setError(String(e)));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.results.map((r) => {
      const run = r.runs[0]!;
      return {
        name: r.fixtureName.replace("test-pkg-bench-dd-", ""),
        run,
        outcome: classifyRun(run),
        counts: countKinds(run.proofKinds ?? []),
      };
    });
  }, [data]);

  const summary = useMemo(() => {
    const c: Record<Outcome, number> = {
      TEST_CONFIRMED: 0,
      TEST_UNCONFIRMED_ONLY: 0,
      AI_ONLY: 0,
      STRUCTURAL_ONLY: 0,
      TIMEOUT: 0,
      MISSED: 0,
    };
    let dangerous = 0;
    let total = 0;
    for (const r of rows) {
      c[r.outcome]++;
      total++;
      if (r.run.verdict === "DANGEROUS") dangerous++;
    }
    return { c, total, dangerous };
  }, [rows]);

  const filteredRows = useMemo(
    () =>
      filter === "all" ? rows : rows.filter((r) => r.outcome === filter),
    [rows, filter],
  );

  if (error) return <Loading message={`Failed: ${error}`} color="var(--danger)" />;
  if (!data) return <Loading message="Loading benchmark…" />;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "32px 48px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <header style={{ marginBottom: 32 }}>
        <h1
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "1.9rem",
            fontWeight: 700,
            letterSpacing: "-0.02em",
            marginBottom: 8,
          }}
        >
          NpmGuard benchmark
        </h1>
        <p
          style={{
            color: "var(--text-dim)",
            fontSize: "0.92rem",
            lineHeight: 1.55,
            marginBottom: 6,
          }}
        >
          End-to-end audit of <strong>{summary.total} confirmed-malicious npm packages</strong>{" "}
          from{" "}
          <a
            href="https://github.com/DataDog/malicious-software-packages-dataset"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)", textDecoration: "none" }}
          >
            Datadog's public corpus
          </a>
          . Every fixture is real malware. The question is: did the engine{" "}
          flag it, and how strong is the evidence?
        </p>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.74rem",
            color: "var(--text-muted)",
          }}
        >
          dataset {data.datasetVersion} · engine {data.engineSha.slice(0, 12)} ·{" "}
          completed {new Date(data.completedAt).toISOString().split("T")[0]}
        </div>
      </header>

      {/* Hero metrics */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 32,
        }}
      >
        <HeroStat
          label="Detection rate"
          big={`${summary.dangerous}/${summary.total}`}
          pct={Math.round((100 * summary.dangerous) / summary.total)}
          tone="var(--danger)"
          desc="Packages flagged DANGEROUS by the engine. The remaining are timeouts, not safe verdicts — see below."
        />
        <HeroStat
          label="Proof-tested"
          big={`${summary.c.TEST_CONFIRMED}/${summary.total}`}
          pct={Math.round((100 * summary.c.TEST_CONFIRMED) / summary.total)}
          tone="var(--safe)"
          desc="Backed by a generated Vitest exploit that ran in a Docker sandbox and reproduced the malicious behavior."
        />
      </section>

      {/* Heatmap */}
      <section style={{ marginBottom: 32 }}>
        <SectionH>Outcome map · {summary.total} fixtures</SectionH>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(25, 1fr)",
            gap: 4,
            marginBottom: 14,
          }}
        >
          {rows.map((r) => (
            <button
              key={r.name}
              title={`${r.name} — ${OUTCOME_META[r.outcome].label}`}
              onClick={() =>
                setFilter(filter === r.outcome ? "all" : r.outcome)
              }
              style={{
                aspectRatio: "1",
                background: OUTCOME_META[r.outcome].color,
                border: "none",
                borderRadius: 3,
                cursor: "pointer",
                opacity:
                  filter === "all" || filter === r.outcome ? 1 : 0.25,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(Object.keys(OUTCOME_META) as Outcome[]).map((o) => (
            <LegendChip
              key={o}
              outcome={o}
              count={summary.c[o]}
              active={filter === o}
              onClick={() => setFilter(filter === o ? "all" : o)}
            />
          ))}
        </div>
      </section>

      {/* What the categories mean */}
      <section style={{ marginBottom: 32 }}>
        <SectionH>How a fixture is classified</SectionH>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            fontSize: "0.84rem",
            lineHeight: 1.5,
          }}
        >
          {(Object.keys(OUTCOME_META) as Outcome[]).map((o) => (
            <div
              key={o}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                padding: "8px 10px",
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: OUTCOME_META[o].color,
                  marginTop: 6,
                  flexShrink: 0,
                }}
              />
              <div>
                <strong style={{ color: "var(--text)" }}>
                  {OUTCOME_META[o].label}
                </strong>
                <div style={{ color: "var(--text-dim)", fontSize: "0.78rem" }}>
                  {OUTCOME_META[o].desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Table */}
      <section>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 12,
          }}
        >
          <SectionH>Per-fixture results</SectionH>
          {filter !== "all" && (
            <button
              onClick={() => setFilter("all")}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.74rem",
                background: "transparent",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-sm)",
                padding: "4px 10px",
                color: "var(--text-dim)",
                cursor: "pointer",
              }}
            >
              clear filter ({OUTCOME_META[filter].label})
            </button>
          )}
        </div>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
          }}
        >
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border-strong)" }}>
              <Th>Fixture</Th>
              <Th>Verdict</Th>
              <Th>Evidence</Th>
              <Th style={{ textAlign: "right" }}>Proofs</Th>
              <Th style={{ textAlign: "right" }}>Duration</Th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr
                key={r.name}
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <td style={{ padding: "10px 6px", color: "var(--text)" }}>
                  {r.name}
                </td>
                <td style={{ padding: "10px 6px" }}>
                  <VerdictBadge run={r.run} />
                </td>
                <td style={{ padding: "10px 6px" }}>
                  <OutcomeBadge outcome={r.outcome} />
                </td>
                <td
                  style={{
                    padding: "10px 6px",
                    textAlign: "right",
                  }}
                >
                  <ProofCounts counts={r.counts} />
                </td>
                <td
                  style={{
                    padding: "10px 6px",
                    textAlign: "right",
                    color: "var(--text-dim)",
                  }}
                >
                  {r.run.error
                    ? "—"
                    : `${(r.run.durationMs / 1000).toFixed(0)}s`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function HeroStat({
  label,
  big,
  pct,
  tone,
  desc,
}: {
  label: string;
  big: string;
  pct: number;
  tone: string;
  desc: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "20px 22px",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
        <span
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "2.4rem",
            fontWeight: 700,
            color: tone,
            letterSpacing: "-0.02em",
            lineHeight: 1,
          }}
        >
          {big}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "1rem",
            color: "var(--text-dim)",
          }}
        >
          {pct}%
        </span>
      </div>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: "0.82rem",
          lineHeight: 1.45,
        }}
      >
        {desc}
      </p>
    </div>
  );
}

function VerdictBadge({ run }: { run: BenchRun }) {
  let label: string;
  let color: string;
  let bg: string;
  if (run.error) {
    label = "TIMEOUT";
    color = "#9e9787";
    bg = "rgba(158, 151, 135, 0.12)";
  } else if (run.verdict === "DANGEROUS") {
    label = "DANGEROUS";
    color = "#dc2626";
    bg = "rgba(220, 38, 38, 0.12)";
  } else {
    label = "MISSED";
    color = "#dc2626";
    bg = "rgba(220, 38, 38, 0.12)";
  }
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        fontWeight: 600,
        padding: "3px 9px",
        borderRadius: "var(--radius-sm)",
        background: bg,
        color,
        border: `1px solid ${color}50`,
        letterSpacing: "0.03em",
      }}
    >
      {label}
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const m = OUTCOME_META[outcome];
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        padding: "3px 8px",
        borderRadius: "var(--radius-sm)",
        background: `${m.color}1a`,
        color: m.color,
        border: `1px solid ${m.color}40`,
      }}
    >
      {m.label}
    </span>
  );
}

function ProofCounts({ counts }: { counts: Record<ProofKind, number> }) {
  const items: Array<{ key: ProofKind; n: number; symbol: string; color: string }> = [
    { key: "TEST_CONFIRMED", n: counts.TEST_CONFIRMED, symbol: "✓", color: "#16a34a" },
    { key: "TEST_UNCONFIRMED", n: counts.TEST_UNCONFIRMED, symbol: "?", color: "#ca8a04" },
    { key: "AI_DYNAMIC", n: counts.AI_DYNAMIC, symbol: "ai", color: "#2563eb" },
    { key: "AI_STATIC", n: counts.AI_STATIC, symbol: "·", color: "#6b6558" },
    { key: "STRUCTURAL", n: counts.STRUCTURAL, symbol: "x", color: "#5b21b6" },
  ];
  const visible = items.filter((i) => i.n > 0);
  if (visible.length === 0)
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 8, justifyContent: "flex-end" }}>
      {visible.map((i) => (
        <span
          key={i.key}
          title={i.key}
          style={{
            color: i.color,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {i.symbol} {i.n}
        </span>
      ))}
    </span>
  );
}

function LegendChip({
  outcome,
  count,
  active,
  onClick,
}: {
  outcome: Outcome;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const m = OUTCOME_META[outcome];
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.74rem",
        padding: "4px 10px",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${active ? m.color : "var(--border-strong)"}`,
        background: active ? `${m.color}20` : "var(--bg-secondary)",
        color: active ? m.color : "var(--text-dim)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 2,
          background: m.color,
        }}
      />
      {m.label} <strong style={{ color: m.color }}>{count}</strong>
    </button>
  );
}

function SectionH({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontFamily: "var(--font-heading)",
        fontSize: "1.05rem",
        fontWeight: 600,
        marginBottom: 12,
        color: "var(--text)",
      }}
    >
      {children}
    </h2>
  );
}

function Th({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "8px 6px",
        fontWeight: 500,
        color: "var(--text-muted)",
        fontSize: "0.7rem",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Loading({ message, color }: { message: string; color?: string }) {
  return (
    <div style={{ padding: 48, color: color ?? "var(--text-muted)" }}>
      {message}
    </div>
  );
}
