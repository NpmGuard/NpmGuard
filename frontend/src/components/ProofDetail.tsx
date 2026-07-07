import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { Finding, Proof, InstrumentationLog } from "../lib/types";
import { fileFromFileLine, parseLineRanges } from "../lib/types";

type Tab = "source" | "proof" | "runtime" | "why";

export interface ProofDetailProps {
  finding: Finding | null;
  proof: Proof | undefined;
  /**
   * If provided, used to fetch the source file by relative path. Returns null
   * when not available (e.g. cached package report after tarball cleanup).
   */
  fetchSource?: (path: string) => Promise<string | null>;
  /**
   * Aggregated runtime evidence for the audit. Comes from the report level —
   * the same data is shown regardless of which proof is selected because the
   * agent's instrumentation traces aren't attributable to specific findings.
   */
  runtimeEvidence?: InstrumentationLog | null;
}

// ---------------------------------------------------------------------------
// CodeMirror line-highlight extension (mirrors the one in CodeViewer)
// ---------------------------------------------------------------------------

function createHighlightExtension(ranges: Array<[number, number]>) {
  const lineDeco = Decoration.line({ class: "cm-suspicious-line" });
  return EditorView.decorations.compute(["doc"], (state) => {
    if (ranges.length === 0) return Decoration.none;
    const builder = new RangeSetBuilder<Decoration>();
    for (const [startLine, endLine] of ranges) {
      for (let line = startLine; line <= endLine && line <= state.doc.lines; line++) {
        const lineObj = state.doc.line(line);
        builder.add(lineObj.from, lineObj.from, lineDeco);
      }
    }
    return builder.finish();
  });
}

// "lib/index.js:42-67" → ["lib/index.js", [[42, 67]]]
// Composite fileLines like "a.js:10-16, b.js:22-43" → keep only the first
// file's ranges; the secondary file would need its own viewer pass.
function splitFileLine(fileLine: string): { file: string | undefined; ranges: Array<[number, number]> } {
  const file = fileFromFileLine(fileLine);
  const colonIdx = fileLine.indexOf(":");
  if (colonIdx < 0) return { file, ranges: [] };
  // Drop anything after the first comma that looks like another "file:lines" pair.
  const lineSpec = fileLine.slice(colonIdx + 1).split(/,\s*[^\d-]/)[0] ?? null;
  // Filter out any malformed range that produced NaN.
  const ranges = parseLineRanges(lineSpec).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  return { file, ranges };
}

// ---------------------------------------------------------------------------
// Tab strip — pattern aligned with CodeViewer.tsx tab buttons
// ---------------------------------------------------------------------------

function TabButton({
  label,
  active,
  disabled,
  badge,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        fontWeight: 600,
        letterSpacing: "0.04em",
        padding: "8px 14px",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: disabled
          ? "var(--text-muted)"
          : active
            ? "var(--text)"
            : "var(--text-dim)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        textTransform: "uppercase",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        transition: "color 0.12s, border-color 0.12s",
      }}
    >
      {label}
      {badge && (
        <span
          style={{
            fontSize: "0.6rem",
            padding: "0 5px",
            borderRadius: 3,
            background: "var(--bg-tertiary)",
            color: "var(--text-muted)",
            fontWeight: 700,
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        color: "var(--text-muted)",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "32px 20px",
        textAlign: "center",
        color: "var(--text-muted)",
        fontSize: "0.8rem",
      }}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-views per tab
// ---------------------------------------------------------------------------

function SourceTab({
  finding,
  proof,
  fetchSource,
}: {
  finding: Finding;
  proof: Proof | undefined;
  fetchSource?: (path: string) => Promise<string | null>;
}) {
  const fileLine = proof?.fileLine || finding.fileLine || "";
  const { file, ranges } = splitFileLine(fileLine);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setContent(null);
    setError(null);
    if (!file || !fetchSource) return;
    let cancelled = false;
    setLoading(true);
    fetchSource(file)
      .then((c) => {
        if (cancelled) return;
        if (c == null) {
          setError("Source not available for cached reports.");
        } else {
          setContent(c);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setError("Failed to load source.");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file, fetchSource]);

  const extensions = useMemo(
    () => [
      javascript({ jsx: true, typescript: true }),
      EditorView.editable.of(false),
      createHighlightExtension(ranges),
    ],
    [ranges],
  );

  if (!file) {
    return <EmptyState message="No source location attached to this finding." />;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="shrink-0 flex items-center"
        style={{
          padding: "8px 14px",
          background: "var(--bg-tertiary)",
          borderBottom: "1px solid var(--border)",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--text)",
          }}
        >
          {file}
        </span>
        {ranges.length > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--danger)",
              padding: "1px 6px",
              borderRadius: 3,
              background: "var(--danger-bg)",
            }}
          >
            line{ranges.length === 1 && ranges[0][0] === ranges[0][1] ? "" : "s"} {ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && <EmptyState message="Loading source…" />}
        {error && !loading && <EmptyState message={error} />}
        {content !== null && !loading && (
          <CodeMirror
            value={content}
            extensions={extensions}
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              highlightActiveLine: false,
            }}
            style={{ fontSize: "0.75rem" }}
          />
        )}
        {!loading && !error && content === null && !fetchSource && (
          <EmptyState message="Source viewer is only available during a live audit. The report still includes the file location below." />
        )}
      </div>
    </div>
  );
}

function ProofTab({ proof }: { proof: Proof | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!proof?.testCode) {
    return (
      <EmptyState message="No exploit test was generated for this finding (likely static-only or low-confidence)." />
    );
  }
  const kind = proof.kind;
  const isVerified = kind === "TEST_CONFIRMED";
  const isUnconfirmed = kind === "TEST_UNCONFIRMED";

  const copyToClipboard = () => {
    if (!proof.testCode) return;
    navigator.clipboard.writeText(proof.testCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="shrink-0 flex items-center"
        style={{
          padding: "8px 14px",
          background: "var(--bg-tertiary)",
          borderBottom: "1px solid var(--border)",
          gap: 10,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--text-dim)",
          }}
        >
          Exploit Test
        </span>
        {isVerified && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 3,
              background: "var(--danger-bg)",
              color: "var(--danger)",
              letterSpacing: "0.05em",
            }}
          >
            ✓ PASSED IN SANDBOX
          </span>
        )}
        {isUnconfirmed && !proof.verifyError && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 3,
              background: "var(--suspected-bg)",
              color: "var(--suspected)",
            }}
          >
            UNCONFIRMED
          </span>
        )}
        {proof.testHash && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--text-muted)",
              marginLeft: "auto",
            }}
          >
            #{proof.testHash.slice(0, 8)}
          </span>
        )}
        <button
          type="button"
          onClick={copyToClipboard}
          className="btn-ghost"
          style={{
            marginLeft: proof.testHash ? 0 : "auto",
            padding: "3px 9px",
            fontSize: "0.6rem",
          }}
        >
          {copied ? "✓ copied" : "copy"}
        </button>
      </div>

      {proof.verifyError && (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--danger-bg)",
            borderBottom: "1px solid var(--danger)",
            color: "var(--danger)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.08em", marginBottom: 4 }}>
            VERIFICATION FAILED
          </div>
          {proof.verifyError}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        <CodeMirror
          value={proof.testCode}
          extensions={[
            javascript({ jsx: false, typescript: true }),
            EditorView.editable.of(false),
          ]}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: false,
          }}
          style={{ fontSize: "0.75rem" }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runtime evidence tab — table-style render of the InstrumentationLog
// ---------------------------------------------------------------------------

function isLogEmpty(log: InstrumentationLog): boolean {
  return (
    log.modulesLoaded.length === 0 &&
    log.networkCalls.length === 0 &&
    log.fsOperations.length === 0 &&
    log.envAccess.length === 0 &&
    log.processSpawns.length === 0 &&
    log.evalCalls.length === 0 &&
    log.cryptoOps.length === 0 &&
    log.timers.length === 0
  );
}

function RuntimeSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
          paddingBottom: 4,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--text)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "var(--text-muted)",
          }}
        >
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function MonoRow({ method, body, danger = false }: { method?: string; body: string; danger?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        padding: "5px 8px",
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        color: danger ? "var(--danger)" : "var(--text-dim)",
        borderBottom: "1px solid var(--border)",
        alignItems: "baseline",
      }}
    >
      {method && (
        <span
          style={{
            fontWeight: 700,
            color: danger ? "var(--danger)" : "var(--accent-light)",
            minWidth: 50,
            textTransform: "uppercase",
            fontSize: "0.6rem",
          }}
        >
          {method}
        </span>
      )}
      <span style={{ wordBreak: "break-all", flex: 1 }}>{body}</span>
    </div>
  );
}

function ChipList({ items }: { items: string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
      {items.map((item, i) => (
        <span
          key={i}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            padding: "2px 7px",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            color: "var(--text-dim)",
          }}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

// Heuristics — these env keys typically signal credential exfil. Used to
// flag rows in red when the package read them at runtime.
const SENSITIVE_ENV_PATTERNS = /(token|secret|key|password|auth|credential|aws_|github|npm_|gh_|gitlab)/i;
function isSensitiveEnv(key: string): boolean {
  return SENSITIVE_ENV_PATTERNS.test(key);
}

function RuntimeTab({ runtimeEvidence }: { runtimeEvidence: InstrumentationLog | null | undefined }) {
  if (!runtimeEvidence) {
    return (
      <EmptyState message="No sandbox runtime evidence captured for this audit. The package didn't trigger the agent's dynamic-analysis tools, or the audit pre-dates Wave 2." />
    );
  }
  if (isLogEmpty(runtimeEvidence)) {
    return (
      <EmptyState message="The agent ran the package in a sandbox but observed no runtime side effects." />
    );
  }

  const { networkCalls, fsOperations, envAccess, processSpawns, evalCalls, cryptoOps, timers, modulesLoaded } = runtimeEvidence;
  const sensitiveEnv = envAccess.filter(isSensitiveEnv);

  return (
    <div className="flex-1 overflow-auto" style={{ padding: "16px 18px" }}>
      <div
        style={{
          marginBottom: 16,
          padding: "10px 12px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderLeft: "3px solid var(--accent)",
          borderRadius: "var(--radius-sm)",
          fontSize: "0.78rem",
          color: "var(--text-dim)",
          lineHeight: 1.5,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.6rem", fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginRight: 6 }}>
          What happened in the sandbox
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
          {networkCalls.length > 0 && `${networkCalls.length} network call${networkCalls.length === 1 ? "" : "s"}`}
          {networkCalls.length > 0 && (envAccess.length > 0 || fsOperations.length > 0 || processSpawns.length > 0) && " · "}
          {envAccess.length > 0 && `${envAccess.length} env var${envAccess.length === 1 ? "" : "s"} read${sensitiveEnv.length > 0 ? ` (${sensitiveEnv.length} sensitive)` : ""}`}
          {envAccess.length > 0 && (fsOperations.length > 0 || processSpawns.length > 0) && " · "}
          {fsOperations.length > 0 && `${fsOperations.length} fs op${fsOperations.length === 1 ? "" : "s"}`}
          {fsOperations.length > 0 && processSpawns.length > 0 && " · "}
          {processSpawns.length > 0 && `${processSpawns.length} process spawn${processSpawns.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <RuntimeSection title="Network calls" count={networkCalls.length}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {networkCalls.map((call, i) => (
            <MonoRow key={i} method={call.method} body={call.url} danger />
          ))}
        </div>
      </RuntimeSection>

      <RuntimeSection title="Environment variables read" count={envAccess.length}>
        <ChipList items={envAccess} />
        {sensitiveEnv.length > 0 && (
          <div
            style={{
              marginTop: 8,
              padding: "6px 10px",
              background: "var(--danger-bg)",
              border: "1px solid var(--danger)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--danger)",
            }}
          >
            ⚠ {sensitiveEnv.length} sensitive key{sensitiveEnv.length === 1 ? "" : "s"} touched: {sensitiveEnv.slice(0, 6).join(", ")}{sensitiveEnv.length > 6 ? "…" : ""}
          </div>
        )}
      </RuntimeSection>

      <RuntimeSection title="Filesystem operations" count={fsOperations.length}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {fsOperations.map((op, i) => (
            <MonoRow key={i} method={op.op} body={op.path} />
          ))}
        </div>
      </RuntimeSection>

      <RuntimeSection title="Process spawns" count={processSpawns.length}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {processSpawns.map((spawn, i) => (
            <MonoRow key={i} method="$" body={`${spawn.cmd}${spawn.args.length ? " " + spawn.args.join(" ") : ""}`} danger />
          ))}
        </div>
      </RuntimeSection>

      <RuntimeSection title="Eval / dynamic code" count={evalCalls.length}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {evalCalls.map((call, i) => (
            <MonoRow key={i} method="eval" body={call.code} danger />
          ))}
        </div>
      </RuntimeSection>

      <RuntimeSection title="Crypto operations" count={cryptoOps.length}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {cryptoOps.map((op, i) => (
            <MonoRow key={i} method={op.method} body={op.algo} />
          ))}
        </div>
      </RuntimeSection>

      <RuntimeSection title="Timers" count={timers.length}>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {timers.map((t, i) => (
            <MonoRow key={i} method={t.type} body={`${t.ms}ms`} />
          ))}
        </div>
      </RuntimeSection>

      <RuntimeSection title="Modules loaded" count={modulesLoaded.length}>
        <ChipList items={modulesLoaded.slice(0, 60)} />
        {modulesLoaded.length > 60 && (
          <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: "0.6rem", color: "var(--text-muted)" }}>
            +{modulesLoaded.length - 60} more
          </div>
        )}
      </RuntimeSection>
    </div>
  );
}

function WhyTab({ finding, proof }: { finding: Finding; proof: Proof | undefined }) {
  return (
    <div
      className="flex-1 overflow-auto"
      style={{ padding: "16px 18px" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {proof?.attackPathway && (
          <div>
            <SectionLabel>Attack pathway</SectionLabel>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.78rem",
                color: "var(--text)",
                padding: "8px 12px",
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {proof.attackPathway.replace(/_/g, " ")}
            </div>
          </div>
        )}

        <div>
          <SectionLabel>Problem</SectionLabel>
          <div style={{ fontSize: "0.85rem", lineHeight: 1.55, color: "var(--text)" }}>
            {finding.problem}
          </div>
        </div>

        {finding.evidence && (
          <div>
            <SectionLabel>Evidence</SectionLabel>
            <div
              style={{
                fontSize: "0.78rem",
                color: "var(--text-dim)",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              {finding.evidence}
            </div>
          </div>
        )}

        {finding.reproductionStrategy && (
          <div>
            <SectionLabel>Reproduction strategy</SectionLabel>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.74rem",
                color: "var(--text-dim)",
                lineHeight: 1.65,
                whiteSpace: "pre-wrap",
                padding: "10px 12px",
                background: "var(--bg-code)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {finding.reproductionStrategy}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 16, fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
          <div>
            <span style={{ color: "var(--text-muted)" }}>confidence</span>{" "}
            <span style={{ color: "var(--text-dim)" }}>{finding.confidence.toLowerCase()}</span>
          </div>
          {proof?.kind && (
            <div>
              <span style={{ color: "var(--text-muted)" }}>proof kind</span>{" "}
              <span style={{ color: "var(--text-dim)" }}>{proof.kind.toLowerCase().replace(/_/g, " ")}</span>
            </div>
          )}
          {proof?.reproducible && (
            <div style={{ color: "var(--danger)" }}>· reproducible</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProofDetail({ finding, proof, fetchSource, runtimeEvidence }: ProofDetailProps) {
  // Cached reports have no source fetcher — landing on an empty Source tab
  // reads as broken, so lead with the explanation instead.
  const defaultTab: Tab = fetchSource ? "source" : "why";
  const [tab, setTab] = useState<Tab>(defaultTab);
  // Reset to the default tab whenever a new finding is selected — adjust state
  // during render so we avoid the cascading-render warning.
  const [prevFinding, setPrevFinding] = useState(finding);
  if (finding !== prevFinding) {
    setPrevFinding(finding);
    setTab(defaultTab);
  }

  if (!finding) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{
          color: "var(--text-muted)",
          fontSize: "0.85rem",
          padding: 24,
          textAlign: "center",
        }}
      >
        Select a finding on the left to inspect its proof.
      </div>
    );
  }

  const hasTest = !!proof?.testCode;
  const runtimeAvailable = !!runtimeEvidence && !isLogEmpty(runtimeEvidence);

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ background: "var(--bg)" }}>
      {/* Tab bar */}
      <div
        className="shrink-0 flex"
        style={{
          borderBottom: "1px solid var(--border)",
          padding: "0 8px",
        }}
      >
        <TabButton label="Source" active={tab === "source"} onClick={() => setTab("source")} />
        <TabButton label="Proof" active={tab === "proof"} onClick={() => setTab("proof")} badge={hasTest ? undefined : "—"} />
        <TabButton
          label="Runtime"
          active={tab === "runtime"}
          onClick={() => setTab("runtime")}
          disabled={!runtimeAvailable}
          badge={runtimeAvailable ? "live" : "—"}
        />
        <TabButton label="Why" active={tab === "why"} onClick={() => setTab("why")} />
      </div>

      {/* Tab body */}
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === "source" && (
          <SourceTab finding={finding} proof={proof} fetchSource={fetchSource} />
        )}
        {tab === "proof" && <ProofTab proof={proof} />}
        {tab === "runtime" && <RuntimeTab runtimeEvidence={runtimeEvidence} />}
        {tab === "why" && <WhyTab finding={finding} proof={proof} />}
      </div>
    </div>
  );
}
