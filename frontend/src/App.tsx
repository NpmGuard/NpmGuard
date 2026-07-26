import { Suspense, lazy, useEffect } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { AppShell } from "./components/shell/AppShell.tsx";
import { EvidenceFrame } from "./components/shell/EvidenceFrame.tsx";
import { PublicFrame } from "./components/shell/PublicFrame.tsx";
import { useAuditStore } from "./stores/auditStore.ts";

// Route-level code splitting: CodeMirror (audit/report source view), React Flow
// (the evidence graph) and viem (pay) are heavy and none belong in the boot chunk.
const AuditView = lazy(() =>
  import("./components/audit/AuditView.tsx").then((m) => ({ default: m.AuditView })),
);
const Landing = lazy(() => import("./pages/Landing.tsx").then((m) => ({ default: m.Landing })));
const Registry = lazy(() => import("./pages/Registry.tsx").then((m) => ({ default: m.Registry })));
const Replays = lazy(() => import("./pages/Replays.tsx").then((m) => ({ default: m.Replays })));
const PackageLookup = lazy(() =>
  import("./pages/PackageLookup.tsx").then((m) => ({ default: m.PackageLookup })),
);
const CliInstall = lazy(() =>
  import("./pages/CliInstall.tsx").then((m) => ({ default: m.CliInstall })),
);
// GSAP + three plugins is the heaviest thing on any static surface; it stays
// out of the boot chunk and loads only when someone asks how this works.
const HowItWorks = lazy(() =>
  import("./pages/HowItWorks.tsx").then((m) => ({ default: m.HowItWorks })),
);
const PayPage = lazy(() => import("./pages/PayPage.tsx").then((m) => ({ default: m.PayPage })));
const Dashboard = lazy(() =>
  import("./pages/Dashboard.tsx").then((m) => ({ default: m.Dashboard })),
);
const RepoDetail = lazy(() =>
  import("./pages/RepoDetail.tsx").then((m) => ({ default: m.RepoDetail })),
);
const Scan = lazy(() => import("./pages/Scan.tsx").then((m) => ({ default: m.Scan })));

// Back/forward off these routes resets the audit store.
const KEEP_STATE_RE = /^\/(audit|replays|packages|package|cli|pay|dashboard|repo|scan)(\/|$)/;

function AuditRoute() {
  const { auditId } = useParams();
  const storeAuditId = useAuditStore((s) => s.auditId);
  const connectToSession = useAuditStore((s) => s.connectToSession);

  useEffect(() => {
    if (auditId && auditId !== storeAuditId) void connectToSession(auditId);
  }, [auditId, storeAuditId, connectToSession]);

  return <AuditView />;
}

/** A route chunk arriving is PROGRESS, not an empty result. `aria-busy` plus one
 * announcement, no visual placeholder: the final layout's dimensions are unknown
 * here, and a skeleton is only honest where they are known. */
function RouteFallback() {
  return (
    <div aria-busy="true" role="status" className="px-4 py-16 text-center">
      <span className="text-sm text-text-3">Loading…</span>
    </div>
  );
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
  // the live view itself).
  useEffect(() => {
    if (
      auditId &&
      !location.pathname.startsWith("/pay") &&
      location.pathname !== `/audit/${auditId}`
    ) {
      navigate(`/audit/${auditId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to auditId only
  }, [auditId]);

  // On verdict, canonicalize to the durable report URL WITHOUT telling the
  // router — raw replaceState keeps the live AuditView mounted (no remount).
  //
  // Never for a replay. /audit/:id addresses ONE run; /package/:name resolves to
  // whichever audit of that package was stored last, so rewriting a permalink
  // here would silently repoint it the next time the package is audited — and
  // the person who followed that link would have no way to tell.
  useEffect(() => {
    if (!verdict || !packageName || useAuditStore.getState().replaying) return;
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

  // THREE FRAMES, chosen per route rather than one shell with exceptions.
  //
  //   PublicFrame   — the product site: landing, methodology, CLI, benchmark.
  //   EvidenceFrame — /audit/:id and /package/:name. Public and shareable, in
  //                   the workspace language, with account-only navigation
  //                   dropped for anonymous visitors.
  //   AppShell      — everything operational.
  //
  // Split at the ROUTER because it is a structural difference, not a styling
  // one: the shell owns the viewport and the public frame does not, and a single
  // frame trying to be both is what made every marketing page feel like a
  // settings screen.
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public product site */}
        <Route path="/" element={<PublicFrame><Landing /></PublicFrame>} />
        <Route path="/how-it-works" element={<PublicFrame><HowItWorks /></PublicFrame>} />
        <Route path="/cli" element={<PublicFrame><CliInstall /></PublicFrame>} />

        {/* Public, shareable evidence */}
        <Route path="/audit/:auditId" element={<EvidenceFrame><AuditRoute /></EvidenceFrame>} />
        <Route path="/audit" element={<EvidenceFrame><AuditView /></EvidenceFrame>} />
        <Route path="/package/*" element={<EvidenceFrame><PackageLookup /></EvidenceFrame>} />

        {/* Payment is a focused transactional surface — no navigation to lose
            someone in halfway through paying. */}
        <Route path="/pay" element={<PayPage />} />

        {/* Application */}
        <Route path="/dashboard" element={<AppShell><Dashboard /></AppShell>} />
        <Route path="/scan" element={<AppShell><Scan /></AppShell>} />
        <Route path="/packages" element={<AppShell><Registry /></AppShell>} />
        <Route path="/replays" element={<AppShell><Replays /></AppShell>} />
        <Route path="/repo/:owner/:name" element={<AppShell><RepoDetail /></AppShell>} />

        <Route path="*" element={<PublicFrame><Landing /></PublicFrame>} />
      </Routes>
    </Suspense>
  );
}
