import { useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import { useAuditStore } from "../stores/auditStore";
import { hasInjectedWallet, payWithInjected } from "../lib/wallet";

type PayState = "loading" | "ready" | "signing" | "submitted" | "existing" | "error";

function readPaymentParams(): { packageName: string; version: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    packageName: params.get("packageName") ?? params.get("pkg") ?? "",
    version: params.get("version") ?? "",
  };
}

function reportUrl(packageName: string, version?: string): string {
  return `/package/${encodeURIComponent(packageName)}${version ? `?version=${encodeURIComponent(version)}` : ""}`;
}

function replaceVersionParam(packageName: string, version: string): void {
  const params = new URLSearchParams(window.location.search);
  params.set("packageName", packageName);
  params.set("version", version);
  params.set("source", params.get("source") ?? "cli");
  history.replaceState(null, "", `/pay?${params.toString()}`);
}

export function WebWalletCheckout() {
  const startAuditFromTx = useAuditStore((s) => s.startAuditFromTx);
  const auditError = useAuditStore((s) => s.error);

  const initial = useMemo(readPaymentParams, []);
  const [packageName] = useState(initial.packageName);
  const [version, setVersion] = useState(initial.version);
  const [feeWei, setFeeWei] = useState<bigint | null>(null);
  const [hasWallet, setHasWallet] = useState(false);
  const [state, setState] = useState<PayState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHasWallet(hasInjectedWallet());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadPaymentConfig() {
      if (!packageName) {
        setState("error");
        setError("Missing package name");
        return;
      }

      let resolvedVersion = version;
      if (!resolvedVersion || resolvedVersion === "latest") {
        setMessage("Resolving package version...");
        try {
          const res = await fetch(`/api/resolve/${encodeURIComponent(packageName)}`);
          if (!res.ok) throw new Error(`Could not resolve ${packageName}`);
          const data = await res.json();
          if (typeof data.version !== "string") throw new Error("Invalid registry response");
          resolvedVersion = data.version;
          if (!cancelled) {
            setVersion(resolvedVersion);
            replaceVersionParam(packageName, resolvedVersion);
          }
        } catch (err) {
          if (!cancelled) {
            setState("error");
            setError(err instanceof Error ? err.message : String(err));
          }
          return;
        }
      }

      try {
        const query = `?version=${encodeURIComponent(resolvedVersion)}`;
        const existing = await fetch(`/api/package/${encodeURIComponent(packageName)}/report${query}`);
        if (existing.ok) {
          if (!cancelled) {
            setMessage("An audit already exists for this package version.");
            setState("existing");
          }
          return;
        }
        if (existing.status !== 404) {
          throw new Error(`Report lookup failed (${existing.status})`);
        }
      } catch (err) {
        if (!cancelled) {
          setState("error");
          setError(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      try {
        const res = await fetch("/api/config/public");
        if (!res.ok) throw new Error("Payment config unavailable");
        const data = await res.json();
        const auditFeeWei = data.crypto?.auditFeeWei;
        if (typeof auditFeeWei !== "string") {
          throw new Error("Crypto payments are not configured");
        }
        if (!cancelled) {
          setFeeWei(BigInt(auditFeeWei));
          setMessage(null);
          setState("ready");
        }
      } catch (err) {
        if (!cancelled) {
          setState("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    loadPaymentConfig();
    return () => {
      cancelled = true;
    };
  }, [packageName, version]);

  const handlePay = async () => {
    if (!feeWei || !packageName || !version) return;
    setState("signing");
    setError(null);
    setMessage("Waiting for wallet signature...");
    try {
      const { txHash } = await payWithInjected(packageName, version, feeWei);
      setState("submitted");
      setMessage("Transaction sent. Starting audit...");
      await startAuditFromTx(txHash, packageName, version);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState("ready");
      setMessage(null);
      setError(msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied")
        ? "Transaction rejected"
        : msg);
    }
  };

  const disabled = state !== "ready" || !hasWallet || !feeWei;

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-10">
      <section style={panelStyle} aria-label="Browser wallet payment">
        <div style={eyebrowStyle}>Base Sepolia</div>
        <h1 style={titleStyle}>Pay with browser wallet</h1>
        <div style={packageStyle}>
          <span>{packageName || "Unknown package"}</span>
          {version && <span style={versionStyle}>@{version}</span>}
        </div>

        <div style={metaStyle}>
          <span>Fee</span>
          <strong>{feeWei ? `${formatEther(feeWei)} ETH` : "..."}</strong>
        </div>

        {state !== "existing" && (
          <button
            type="button"
            style={disabled ? disabledButtonStyle : buttonStyle}
            onClick={handlePay}
            disabled={disabled}
          >
            {state === "signing" || state === "submitted" ? "Processing..." : "Connect and pay"}
          </button>
        )}

        {state === "existing" && (
          <>
            <p style={hintStyle}>
              This package version has already been audited. Open the existing report, or run a different version from the CLI.
            </p>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => {
                window.location.href = reportUrl(packageName, version);
              }}
            >
              View existing report
            </button>
          </>
        )}

        {state !== "existing" && !hasWallet && (
          <p style={hintStyle}>
            Open this page in Brave or Chrome with MetaMask or Rabby enabled.
          </p>
        )}

        {(message || auditError) && (
          <p style={hintStyle}>{message ?? auditError}</p>
        )}

        {(error || state === "error") && (
          <p role="alert" style={errorStyle}>
            {error ?? "Payment flow unavailable"}
          </p>
        )}
      </section>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: "min(100%, 440px)",
  border: "1px solid var(--border-strong)",
  borderRadius: "0.5rem",
  background: "var(--bg)",
  color: "var(--text)",
  padding: "1.5rem",
  boxShadow: "0 16px 48px rgba(0,0,0,0.24)",
};

const eyebrowStyle: React.CSSProperties = {
  color: "var(--accent)",
  fontSize: "0.75rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0,
  marginBottom: "0.75rem",
};

const titleStyle: React.CSSProperties = {
  fontSize: "1.6rem",
  lineHeight: 1.2,
  margin: 0,
};

const packageStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: "0.15rem",
  marginTop: "0.75rem",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  wordBreak: "break-word",
};

const versionStyle: React.CSSProperties = {
  color: "var(--text-dim)",
};

const metaStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  marginTop: "1.25rem",
  paddingTop: "1rem",
  borderTop: "1px solid var(--border)",
  color: "var(--text-dim)",
};

const buttonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: "1.25rem",
  padding: "0.85rem 1rem",
  border: "1px solid var(--accent)",
  borderRadius: "0.375rem",
  background: "var(--accent)",
  color: "var(--bg)",
  cursor: "pointer",
  fontWeight: 700,
};

const disabledButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  opacity: 0.55,
  cursor: "not-allowed",
};

const secondaryButtonStyle: React.CSSProperties = {
  width: "100%",
  marginTop: "0.75rem",
  padding: "0.75rem 1rem",
  border: "1px solid var(--border-strong)",
  borderRadius: "0.375rem",
  background: "var(--bg-secondary)",
  color: "var(--text)",
  cursor: "pointer",
  fontWeight: 700,
};

const hintStyle: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: "0.85rem",
  lineHeight: 1.5,
  margin: "0.75rem 0 0",
};

const errorStyle: React.CSSProperties = {
  color: "var(--danger)",
  fontSize: "0.85rem",
  lineHeight: 1.5,
  margin: "0.75rem 0 0",
};
