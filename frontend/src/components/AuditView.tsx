import { useState, useEffect } from "react";
import { useAuditStore } from "../stores/auditStore";
import { ActivityFeed } from "./ActivityFeed";
import { CodeViewer } from "./CodeViewer";
import { VerdictBanner } from "./VerdictBanner";
import { FileExplorer } from "./FileExplorer";
import { ResultsPanel } from "./ResultsPanel";

function StatusBanners({
  reconnecting,
  error,
  isRunning,
  verdict,
}: {
  reconnecting: boolean;
  error: string | null;
  isRunning: boolean;
  verdict: string | null;
}) {
  return (
    <>
      {reconnecting && (
        <div className="status-banner status-banner--warning" role="status">
          Reconnecting to audit engine...
        </div>
      )}
      {error && !isRunning && !verdict && (
        <div className="status-banner status-banner--error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

export function AuditView() {
  const [fileExplorerOpen, setFileExplorerOpen] = useState(true);
  const [showResults, setShowResults] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 767px)").matches
  );
  const [mobilePanel, setMobilePanel] = useState<"activity" | "code">("activity");

  const verdict = useAuditStore((s) => s.verdict);
  const error = useAuditStore((s) => s.error);
  const isRunning = useAuditStore((s) => s.isRunning);
  const reconnecting = useAuditStore((s) => s.reconnecting);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Auto-switch to results when verdict first arrives (adjust state during render)
  const [prevVerdict, setPrevVerdict] = useState(verdict);
  if (verdict !== prevVerdict) {
    setPrevVerdict(verdict);
    if (verdict && !prevVerdict) {
      setShowResults(true);
      setMobilePanel("code");
    }
  }

  if (isMobile) {
    const activePanel =
      mobilePanel === "activity" ? (
        <ActivityFeed />
      ) : showResults && verdict ? (
        <ResultsPanel onShowCode={() => setShowResults(false)} />
      ) : (
        <CodeViewer
          onToggleFiles={() => {}}
          filesOpen={false}
          onShowResults={verdict ? () => setShowResults(true) : undefined}
        />
      );

    return (
      <>
        <StatusBanners
          reconnecting={reconnecting}
          error={error}
          isRunning={isRunning}
          verdict={verdict}
        />
        <VerdictBanner />
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {activePanel}
        </div>
        <div className="mobile-tab-bar">
          <button
            aria-selected={mobilePanel === "activity"}
            onClick={() => setMobilePanel("activity")}
          >
            Activity
          </button>
          <button
            aria-selected={mobilePanel === "code"}
            onClick={() => setMobilePanel("code")}
          >
            {showResults && verdict ? "Results" : "Code"}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <StatusBanners
        reconnecting={reconnecting}
        error={error}
        isRunning={isRunning}
        verdict={verdict}
      />
      <VerdictBanner />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Activity Feed — left */}
        <div
          className="flex flex-col shrink-0 overflow-hidden"
          style={{
            width: "var(--sidebar-width)",
            minWidth: "var(--sidebar-width)",
            borderRight: "1px solid var(--border)",
          }}
        >
          <ActivityFeed />
        </div>

        {/* Right panel — results or code viewer */}
        <div className="flex-1 flex flex-col min-w-0">
          {showResults && verdict ? (
            <ResultsPanel
              onShowCode={() => setShowResults(false)}
            />
          ) : (
            <CodeViewer
              onToggleFiles={() => setFileExplorerOpen((o) => !o)}
              filesOpen={fileExplorerOpen}
              onShowResults={verdict ? () => setShowResults(true) : undefined}
            />
          )}
        </div>

        {/* File Explorer — right, collapsible */}
        {!showResults && (
          <FileExplorer
            open={fileExplorerOpen}
            onClose={() => setFileExplorerOpen(false)}
          />
        )}
      </div>
    </>
  );
}
