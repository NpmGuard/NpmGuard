import { Suspense, lazy, useEffect } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { Header } from "./components/Header.tsx";
import { useAuditStore } from "./stores/auditStore.ts";

// Route-level code splitting: CodeMirror (audit/report source view) and viem
// (pay) are heavy and none belong in the boot chunk.
const AuditView = lazy(() =>
  import("./components/audit/AuditView.tsx").then((m) => ({ default: m.AuditView })),
);
const Landing = lazy(() => import("./pages/Landing.tsx").then((m) => ({ default: m.Landing })));
const Registry = lazy(() => import("./pages/Registry.tsx").then((m) => ({ default: m.Registry })));
const PackageLookup = lazy(() =>
  import("./pages/PackageLookup.tsx").then((m) => ({ default: m.PackageLookup })),
);
const CliInstall = lazy(() =>
  import("./pages/CliInstall.tsx").then((m) => ({ default: m.CliInstall })),
);
const PayPage = lazy(() => import("./pages/PayPage.tsx").then((m) => ({ default: m.PayPage })));
const Dashboard = lazy(() =>
  import("./pages/Dashboard.tsx").then((m) => ({ default: m.Dashboard })),
);
const RepoDetail = lazy(() =>
  import("./pages/RepoDetail.tsx").then((m) => ({ default: m.RepoDetail })),
);

// Back/forward off these routes resets the audit store.
const KEEP_STATE_RE = /^\/(audit|packages|package|cli|pay|dashboard|repo)(\/|$)/;

function HomeOrAudit() {
  const hasStarted = useAuditStore((s) => s.hasStarted);
  const verdict = useAuditStore((s) => s.verdict);
  const running = useAuditStore((s) => s.running);
  const error = useAuditStore((s) => s.error);
  const demoInline = useAuditStore((s) => s.demoInline);
  // An inline Landing demo streams INSIDE Landing (the MiniAuditFeed) — keep
  // Landing mounted so starting it doesn't swap the whole view to AuditView
  // (which would unmount Landing and reset the very stream it started).
  if (demoInline) return <Landing />;
  // `error` too: a stale/expired /audit/:id link resolves to an error-only
  // state which AuditView surfaces honestly — Landing would hide it.
  return hasStarted || running || verdict || error ? <AuditView /> : <Landing />;
}

function AuditRoute() {
  const { auditId } = useParams();
  const storeAuditId = useAuditStore((s) => s.auditId);
  const connectToSession = useAuditStore((s) => s.connectToSession);

  useEffect(() => {
    if (auditId && auditId !== storeAuditId) void connectToSession(auditId);
  }, [auditId, storeAuditId, connectToSession]);

  return <HomeOrAudit />;
}

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const auditId = useAuditStore((s) => s.auditId);
  const verdict = useAuditStore((s) => s.verdict);
  const packageName = useAuditStore((s) => s.packageName);

  // Stripe checkout return: ?session_id on any path starts the paid audit.
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    if (sessionId && !useAuditStore.getState().auditId) {
      navigate("/audit", { replace: true });
      void useAuditStore.getState().startAuditFromCheckout(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

  // A started audit gets a shareable URL. /pay stays put (the pay page swaps to
  // the live view itself); an inline Landing demo streams in place, so it must
  // NOT take over the route (navigating would unmount Landing and reset it).
  useEffect(() => {
    if (
      auditId &&
      !useAuditStore.getState().demoInline &&
      !location.pathname.startsWith("/pay") &&
      location.pathname !== `/audit/${auditId}`
    ) {
      navigate(`/audit/${auditId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to auditId only
  }, [auditId]);

  // On verdict, canonicalize to the durable report URL WITHOUT telling the
  // router — raw replaceState keeps the live AuditView mounted (no remount).
  useEffect(() => {
    if (!verdict || !packageName) return;
    const path = window.location.pathname;
    if (path.startsWith("/audit") || path.startsWith("/pay")) {
      const version = useAuditStore.getState().inventoryMeta?.metadata.version;
      const query = version ? `?version=${encodeURIComponent(version)}` : "";
      window.history.replaceState(null, "", `/package/${packageName}${query}`);
    }
  }, [verdict, packageName]);

  // Back/forward off the audit-ish routes resets the audit store.
  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname;
      if (path === "/" || !KEEP_STATE_RE.test(path)) {
        useAuditStore.getState().reset();
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return (
    <>
      <Header />
      <main className="page">
        <Suspense
          fallback={
            <div className="empty-state" role="status">
              <span className="spinner" aria-hidden="true" />
            </div>
          }
        >
          <Routes>
            <Route path="/packages" element={<Registry />} />
            <Route path="/package/*" element={<PackageLookup />} />
            <Route path="/cli" element={<CliInstall />} />
            <Route path="/pay" element={<PayPage />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/repo/:owner/:name" element={<RepoDetail />} />
            <Route path="/audit/:auditId" element={<AuditRoute />} />
            <Route path="*" element={<HomeOrAudit />} />
          </Routes>
        </Suspense>
      </main>
    </>
  );
}
