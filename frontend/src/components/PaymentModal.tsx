import { useState } from "react";
import { formatEther } from "viem";
import { useAuditStore } from "../stores/auditStore";
import { hasInjectedWallet, payWithInjected } from "../lib/wallet";

interface Props {
  packageName: string;
  version: string;
  priceCents: number | null;
  stripeEnabled: boolean;
  cryptoFeeWei: bigint | null;
  onClose: () => void;
}

type Mode = "choose" | "working";

export function PaymentModal({
  packageName,
  version,
  priceCents,
  stripeEnabled,
  cryptoFeeWei,
  onClose,
}: Props) {
  const startCheckout = useAuditStore((s) => s.startCheckout);
  const startAuditFromTx = useAuditStore((s) => s.startAuditFromTx);

  const [mode, setMode] = useState<Mode>("choose");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const injected = hasInjectedWallet();

  const handleStripe = () => {
    startCheckout(packageName, version);
  };

  const handleMetaMask = async () => {
    if (!cryptoFeeWei) return;
    setError(null);
    setMode("working");
    setStatus("Waiting for wallet signature…");
    try {
      const { txHash } = await payWithInjected(packageName, version, cryptoFeeWei);
      setStatus("Transaction sent. Starting audit…");
      await startAuditFromTx(txHash, packageName, version);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied")) {
        setError("Transaction rejected");
      } else {
        setError(msg);
      }
      setMode("choose");
      setStatus(null);
    }
  };

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget && mode !== "working") onClose();
      }}
    >
      <div style={modalStyle}>
        <button style={closeBtnStyle} onClick={onClose} aria-label="Close" disabled={mode === "working"}>
          ×
        </button>

        <h2 style={{ margin: 0, fontSize: "1.2rem", fontFamily: "var(--font-heading)", fontWeight: 700 }}>
          Audit {packageName}
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "0.9rem", fontWeight: 400 }}>
            @{version}
          </span>
        </h2>

        {mode === "choose" && (
          <>
            <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", marginTop: "0.5rem" }}>
              Choose a payment method
            </p>
            <div style={buttonCol}>
              <button className="payment-option" onClick={handleStripe} disabled={!stripeEnabled}>
                Pay with Stripe
                <span style={subLabel}>
                  {stripeEnabled && priceCents != null
                    ? `$${(priceCents / 100).toFixed(2)} · card`
                    : "Unavailable"}
                </span>
              </button>
              <button
                className="payment-option"
                onClick={handleMetaMask}
                disabled={!injected || !cryptoFeeWei}
              >
                Pay with Crypto
                <span style={subLabel}>
                  {!injected
                    ? "No wallet detected"
                    : cryptoFeeWei
                      ? `${formatEther(cryptoFeeWei)} ETH · Base Sepolia`
                      : "Unavailable"}
                </span>
              </button>
            </div>
          </>
        )}

        {mode === "working" && (
          <p style={{ color: "var(--text-dim)", marginTop: "1rem" }}>{status}</p>
        )}

        {error && (
          <p role="alert" style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  position: "relative",
  background: "var(--bg)",
  color: "var(--text)",
  padding: "1.5rem",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border-strong)",
  minWidth: 340,
  maxWidth: 420,
  boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
};

const closeBtnStyle: React.CSSProperties = {
  position: "absolute",
  top: "0.5rem",
  right: "0.75rem",
  background: "transparent",
  border: "none",
  fontSize: "1.5rem",
  color: "var(--text-dim)",
  cursor: "pointer",
};

const buttonCol: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  marginTop: "1rem",
};

const subLabel: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-dim)",
  fontWeight: "normal",
};
