import { useState, useEffect, useCallback } from "react";
import { useAuditStore } from "./stores/auditStore";
import { AUDIT_PATH_RE } from "./lib/types";
import { Header } from "./components/Header";
import { Landing } from "./components/Landing";
import { AuditView } from "./components/AuditView";
import { PackageSearch } from "./components/PackageSearch";
import { PackageLookup } from "./components/PackageLookup";
import { Benchmark } from "./components/Benchmark";
import { CliInstall } from "./components/CliInstall";
import { WebWalletCheckout } from "./components/WebWalletCheckout";

const PACKAGES_PATH_RE = /^\/packages\/?$/;
const PACKAGE_PATH_RE_LOOKUP = /^\/package\/(.+)$/;
const BENCHMARK_PATH_RE = /^\/benchmark\/?$/;
const CLI_PATH_RE = /^\/cli\/?$/;
const PAY_PATH_RE = /^\/pay\/?$/;

function App() {
  const isRunning = useAuditStore((s) => s.isRunning);
  const verdict = useAuditStore((s) => s.verdict);
  const auditId = useAuditStore((s) => s.auditId);
  const packageName = useAuditStore((s) => s.packageName);
  const connectToSession = useAuditStore((s) => s.connectToSession);
  const startAuditFromCheckout = useAuditStore((s) => s.startAuditFromCheckout);
  const reset = useAuditStore((s) => s.reset);
  const hasStarted = useAuditStore((s) => s.hasStarted);
  const hasAudit = hasStarted || isRunning || !!verdict;

  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  // On mount: if returning from Stripe checkout with ?session_id, start audit
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (sessionId && !auditId) {
      history.replaceState(null, "", "/audit");
      startAuditFromCheckout(sessionId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On mount: if URL is /audit/<uuid>, reconnect to that session
  useEffect(() => {
    const match = window.location.pathname.match(AUDIT_PATH_RE);
    if (match && !auditId) {
      connectToSession(match[1]);
    }
  }, [auditId, connectToSession]);

  // Update URL when an audit starts from the landing page
  useEffect(() => {
    if (auditId && !window.location.pathname.includes(auditId)) {
      history.pushState(null, "", `/audit/${auditId}`);
      setCurrentPath(`/audit/${auditId}`);
    }
  }, [auditId]);

  // Audit sessions are ephemeral; package report pages are durable.
  useEffect(() => {
    const path = window.location.pathname;
    if (verdict && packageName && (path.startsWith("/audit/") || path.startsWith("/pay"))) {
      const version = new URLSearchParams(window.location.search).get("version");
      const href = `/package/${encodeURIComponent(packageName)}${version ? `?version=${encodeURIComponent(version)}` : ""}`;
      history.replaceState(null, "", href);
      setCurrentPath(`/package/${encodeURIComponent(packageName)}`);
    }
  }, [verdict, packageName]);

  // Handle browser back/forward
  const onPopState = useCallback(() => {
    const path = window.location.pathname;
    setCurrentPath(path);

    const match = path.match(AUDIT_PATH_RE);
    if (match) {
      if (match[1] !== auditId) connectToSession(match[1]);
    } else if (!PACKAGES_PATH_RE.test(path) && !PACKAGE_PATH_RE_LOOKUP.test(path) && !BENCHMARK_PATH_RE.test(path) && !CLI_PATH_RE.test(path) && !PAY_PATH_RE.test(path)) {
      reset();
    }
  }, [auditId, connectToSession, reset]);

  useEffect(() => {
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [onPopState]);

  // Determine which view to render
  let content: React.ReactNode;

  const packageMatch = currentPath.match(PACKAGE_PATH_RE_LOOKUP);

  if (PACKAGES_PATH_RE.test(currentPath)) {
    content = <PackageSearch />;
  } else if (packageMatch) {
    const version = new URLSearchParams(window.location.search).get("version") ?? undefined;
    content = <PackageLookup packageName={decodeURIComponent(packageMatch[1])} version={version} />;
  } else if (BENCHMARK_PATH_RE.test(currentPath)) {
    content = <Benchmark />;
  } else if (CLI_PATH_RE.test(currentPath)) {
    content = <CliInstall />;
  } else if (PAY_PATH_RE.test(currentPath) && !hasAudit) {
    content = <WebWalletCheckout />;
  } else if (hasAudit) {
    content = <AuditView />;
  } else {
    content = <Landing />;
  }

  return (
    <div
      className="h-screen flex flex-col"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <Header />
      <main className="flex-1 flex flex-col min-h-0">
        {content}
      </main>
    </div>
  );
}

export default App;
