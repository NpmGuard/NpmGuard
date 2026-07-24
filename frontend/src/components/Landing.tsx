import { useState, useEffect } from "react";
import { isAddress, type Address } from "viem";
import { useAuditStore } from "../stores/auditStore";
import { PaymentModal } from "./PaymentModal";

const DEMOS = [
  {
    pkg: "test-pkg-env-exfil",
    verdict: "crit" as const,
    label: "CRITICAL",
    name: "test-pkg-env-exfil",
    detail: ["env exfiltration", "IMDS metadata probe"],
    sub: "Targets AWS_SECRET_KEY, CI_TOKEN, GITHUB_TOKEN",
  },
  {
    pkg: "test-pkg-dom-inject",
    verdict: "crit" as const,
    label: "CRITICAL",
    name: "test-pkg-dom-inject",
    detail: ["DOM injection", "wallet drainer"],
    sub: "Fake approval modal · eth_sendTransaction",
  },
  {
    pkg: "react",
    verdict: "ok" as const,
    label: "CLEAN",
    name: "react@latest",
    detail: ["No threats found", "4 files scanned"],
    sub: "No install hooks, no network access, no obfuscation",
  },
];

export function Landing() {
  const [input, setInput] = useState("");
  const [priceCents, setPriceCents] = useState<number | null>(null);
  const [paymentEnabled, setPaymentEnabled] = useState(false);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [cryptoFeeWei, setCryptoFeeWei] = useState<bigint | null>(null);
  const [cryptoContract, setCryptoContract] = useState<Address | null>(null);
  const [pendingPayment, setPendingPayment] = useState<{ pkg: string; ver: string } | null>(null);
  const startAudit = useAuditStore((s) => s.startAudit);
  const startDemo = useAuditStore((s) => s.startDemo);
  const checkoutLoading = useAuditStore((s) => s.checkoutLoading);
  const error = useAuditStore((s) => s.error);

  useEffect(() => {
    fetch("/api/config/public")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setPaymentEnabled(data.paymentEnabled);
          setStripeEnabled(!!data.stripeEnabled);
          setPriceCents(data.priceCents);
          if (
            data.crypto?.auditFeeWei &&
            typeof data.crypto.contract === "string" &&
            isAddress(data.crypto.contract)
          ) {
            try {
              setCryptoFeeWei(BigInt(data.crypto.auditFeeWei));
              setCryptoContract(data.crypto.contract);
            } catch {
              /* ignore */
            }
          }
        }
      })
      .catch(() => {});
  }, []);

  const [resolving, setResolving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    // Parse package@version — handle scoped packages (@scope/pkg@version)
    const atIdx = trimmed.lastIndexOf("@");
    const pkg = atIdx > 0 ? trimmed.slice(0, atIdx) : trimmed;
    let ver = atIdx > 0 ? trimmed.slice(atIdx + 1) : "";
    // Resolve "latest" or missing version to a concrete semver via npm registry
    // (engine's zod schema rejects non-semver strings like "latest")
    if (!ver || ver === "latest") {
      setResolving(true);
      try {
        const res = await fetch(`/api/resolve/${encodeURIComponent(pkg)}`);
        if (!res.ok) {
          setResolving(false);
          return;
        }
        const data = await res.json();
        if (typeof data.version !== "string") {
          setResolving(false);
          return;
        }
        ver = data.version;
      } catch {
        setResolving(false);
        return;
      }
      setResolving(false);
    }

    if (paymentEnabled) {
      setPendingPayment({ pkg, ver });
    } else {
      startAudit(pkg, ver);
    }
  };

  return (
    <div className="landing-scroll-wrap flex-1 flex flex-col items-center">
      <div className="landing-page">

        {/* Left / top: pitch + search */}
        <div className="landing-pitch">
          <h1>
            Know what
            <br />
            you install
            <span className="dot">.</span>
          </h1>
          <p className="subtitle">AI-powered security audit for npm packages.</p>

          <form onSubmit={handleSubmit} className="landing-single-bar">
            <label className="sr-only" htmlFor="pkg-input">
              Package name or package@version
            </label>
            <input
              id="pkg-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="express@4.18.2"
              autoFocus
            />
            <button type="submit" disabled={!input.trim() || checkoutLoading || resolving}>
              {checkoutLoading || resolving ? "..." : "Audit"}
            </button>
          </form>

          <div className="landing-hint">
            {paymentEnabled && priceCents != null
              ? `$${(priceCents / 100).toFixed(2)} per audit · `
              : ""}
            package · package@version · package@latest
          </div>

          {error && (
            <p style={{ color: "var(--danger)", fontSize: "0.8rem" }} role="alert">
              {error}
            </p>
          )}

          <div className="landing-chips">
            {["event-stream", "ua-parser-js", "colors"].map((pkg) => (
              <button
                key={pkg}
                type="button"
                aria-label={`Try auditing ${pkg}`}
                className="landing-chip"
                onClick={() => setInput(pkg)}
              >
                {pkg}
              </button>
            ))}
          </div>
        </div>

        {/* Right / bottom: demo cards */}
        <div className="landing-demo">
          <div className="landing-demo-label">Recent scans</div>
          {DEMOS.map((demo) => (
            <button
              key={demo.pkg}
              type="button"
              className={`landing-card ${demo.verdict}`}
              onClick={() => startDemo(demo.pkg)}
            >
              <div className="landing-card-header">
                <span className={`landing-card-badge ${demo.verdict}`}>
                  {demo.label}
                </span>
                <span className="landing-card-name">{demo.name}</span>
              </div>
              <div className="landing-card-body">
                <span className={demo.verdict === "crit" ? "hl" : "ok-hl"}>
                  {demo.detail[0]}
                </span>
                {" · "}
                {demo.detail[1]}
                <br />
                {demo.sub}
              </div>
              <div className="landing-card-cta">view full audit &rarr;</div>
            </button>
          ))}
        </div>

      </div>

      <footer className="landing-footer" aria-label="How NpmGuard works">
        <span>Static analysis + sandboxed execution</span>
        <span aria-hidden="true">·</span>
        <span>Evidence-backed verdicts</span>
        <span aria-hidden="true">·</span>
        <span>Full audit trail</span>
      </footer>
      {pendingPayment && (
        <PaymentModal
          packageName={pendingPayment.pkg}
          version={pendingPayment.ver}
          priceCents={priceCents}
          stripeEnabled={stripeEnabled}
          cryptoFeeWei={cryptoFeeWei}
          cryptoContract={cryptoContract}
          onClose={() => setPendingPayment(null)}
        />
      )}
    </div>
  );
}
