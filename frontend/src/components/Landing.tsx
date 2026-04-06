import { useState, useEffect } from "react";
import { useAuditStore } from "../stores/auditStore";

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
    sub: "Fake approval modal \u00b7 eth_sendTransaction",
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
  const [version, setVersion] = useState("");
  const [priceCents, setPriceCents] = useState<number | null>(null);
  const [paymentEnabled, setPaymentEnabled] = useState(false);
  const startCheckout = useAuditStore((s) => s.startCheckout);
  const startDemo = useAuditStore((s) => s.startDemo);
  const checkoutLoading = useAuditStore((s) => s.checkoutLoading);
  const error = useAuditStore((s) => s.error);

  useEffect(() => {
    fetch("/api/config/public")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setPaymentEnabled(data.paymentEnabled);
          setPriceCents(data.priceCents);
        }
      })
      .catch(() => {});
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) startCheckout(input.trim(), version.trim() || undefined);
  };

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="landing-page">
        {/* Left: pitch + audit input */}
        <div className="landing-pitch">
          <h1>
            Know what
            <br />
            you install
            <span className="dot">.</span>
          </h1>
          <p className="subtitle">
            AI-powered security audit for npm packages.
          </p>

          <form onSubmit={handleSubmit} className="landing-search-bar">
            <label className="sr-only" htmlFor="pkg-input">
              Package name
            </label>
            <input
              id="pkg-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="package name"
              autoFocus
            />
            <label className="sr-only" htmlFor="version-input">
              Version
            </label>
            <input
              id="version-input"
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="latest"
              className="ver"
            />
            <button
              type="submit"
              disabled={!input.trim() || checkoutLoading}
            >
              {checkoutLoading ? "..." : "Audit"}
            </button>
          </form>

          {error && (
            <p
              style={{ color: "var(--danger)", fontSize: "0.8rem" }}
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="landing-search-meta">
            {paymentEnabled && priceCents != null && (
              <span>${(priceCents / 100).toFixed(2)} per audit</span>
            )}
            {["event-stream", "ua-parser-js", "colors"].map((pkg) => (
              <button
                key={pkg}
                type="button"
                aria-label={`Try auditing ${pkg}`}
                onClick={() => {
                  setInput(pkg);
                  setVersion("");
                }}
              >
                {pkg}
              </button>
            ))}
          </div>
        </div>

        {/* Right: terminal preview */}
        <div className="landing-terminal-wrap">
          <span className="landing-terminal-label">See a demo</span>
          <div className="landing-terminal">
            <div className="landing-terminal-bar">
              <div className="landing-terminal-dot r" />
              <div className="landing-terminal-dot y" />
              <div className="landing-terminal-dot g" />
              <span className="landing-terminal-title">npmguard</span>
            </div>
            <div className="landing-terminal-body">
              <div className="prompt">
                $ <span className="cmd">npmguard scan --recent</span>
              </div>

              {DEMOS.map((demo) => (
                <button
                  key={demo.pkg}
                  type="button"
                  className="landing-scan-result"
                  onClick={() => startDemo(demo.pkg)}
                >
                  <div className="landing-scan-header">
                    <span
                      className={`landing-scan-verdict ${demo.verdict}`}
                    >
                      {demo.label}
                    </span>
                    <span className="landing-scan-pkg">{demo.name}</span>
                  </div>
                  <div className="landing-scan-detail">
                    <span className={demo.verdict === "crit" ? "hl" : "safe-hl"}>
                      {demo.detail[0]}
                    </span>
                    {" \u00b7 "}
                    {demo.detail[1]}
                    <br />
                    {demo.sub}
                  </div>
                  <div className="landing-scan-cta">
                    view full audit &rarr;
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
