import { useCallback, useEffect } from "react";
import { Route, Routes, useNavigate, useParams } from "react-router";
import { useAuditStore } from "./stores/auditStore";
import { Header } from "./components/Header";
import { Landing } from "./components/Landing";
import { AuditView } from "./components/AuditView";
import { PackageSearch } from "./components/PackageSearch";
import { PackageLookup } from "./components/PackageLookup";
import { Benchmark } from "./components/Benchmark";
import { Dashboard } from "./pages/Dashboard";
import { RepoDetail } from "./pages/RepoDetail";

const AUDIT_PATH_RE = /^\/audit\/([0-9a-f-]{36})$/;
const KEEP_STATE_RE = /^\/(audit|packages|package|benchmark|dashboard|repo)(\/|$)/;

/** Landing vs live audit — same decision the old regex router made. */
function HomeOrAudit() {
  const isRunning = useAuditStore((s) => s.isRunning);
  const verdict = useAuditStore((s) => s.verdict);
  const hasStarted = useAuditStore((s) => s.hasStarted);
  const hasAudit = hasStarted || isRunning || !!verdict;
  return hasAudit ? <AuditView /> : <Landing />;
}

/** /audit/:auditId — reconnect to the session, then render like home. */
function AuditRoute() {
  const { auditId: routeAuditId } = useParams<{ auditId: string }>();
  const auditId = useAuditStore((s) => s.auditId);
  const connectToSession = useAuditStore((s) => s.connectToSession);

  useEffect(() => {
    if (routeAuditId && routeAuditId !== auditId) {
      connectToSession(routeAuditId);
    }
  }, [routeAuditId, auditId, connectToSession]);

  return <HomeOrAudit />;
}

/** /package/* — splat route so scoped names (@scope/pkg) keep their slash. */
function PackageLookupRoute() {
  const params = useParams();
  const pkgName = params["*"] ?? "";
  return <PackageLookup packageName={decodeURIComponent(pkgName)} />;
}

function App() {
  const verdict = useAuditStore((s) => s.verdict);
  const auditId = useAuditStore((s) => s.auditId);
  const packageName = useAuditStore((s) => s.packageName);
  const startAuditFromCheckout = useAuditStore((s) => s.startAuditFromCheckout);
  const reset = useAuditStore((s) => s.reset);
  const navigate = useNavigate();

  // On mount: if returning from Stripe checkout with ?session_id, start audit
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (sessionId && !auditId) {
      navigate("/audit", { replace: true });
      startAuditFromCheckout(sessionId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update URL when an audit starts from the landing page
  useEffect(() => {
    if (auditId && !window.location.pathname.includes(auditId)) {
      navigate(`/audit/${auditId}`);
    }
  }, [auditId, navigate]);

  // When an audit reaches a verdict, canonicalize the URL from the ephemeral
  // /audit/<id> to the durable /package/<name> route. Deliberately raw
  // history.replaceState — the router doesn't observe it, so the live
  // AuditView stays mounted (same trick as the pre-router App, where
  // currentPath state was intentionally not updated).
  useEffect(() => {
    if (verdict && packageName && window.location.pathname.startsWith("/audit/")) {
      history.replaceState(null, "", `/package/${encodeURIComponent(packageName)}`);
    }
  }, [verdict, packageName]);

  // Handle browser back/forward: leaving the audit-ish routes resets the store
  const onPopState = useCallback(() => {
    const path = window.location.pathname;
    const match = path.match(AUDIT_PATH_RE);
    if (!match && !KEEP_STATE_RE.test(path)) {
      reset();
    }
  }, [reset]);

  useEffect(() => {
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [onPopState]);

  return (
    <div
      className="h-screen flex flex-col"
      style={{ background: "var(--bg)", color: "var(--text)" }}
    >
      <Header />
      <main className="flex-1 flex flex-col min-h-0">
        <Routes>
          <Route path="/packages" element={<PackageSearch />} />
          <Route path="/package/*" element={<PackageLookupRoute />} />
          <Route path="/benchmark" element={<Benchmark />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/repo/:owner/:name" element={<RepoDetail />} />
          <Route path="/audit/:auditId" element={<AuditRoute />} />
          <Route path="*" element={<HomeOrAudit />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
