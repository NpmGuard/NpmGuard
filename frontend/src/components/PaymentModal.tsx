import { useEffect, useState } from "react";
import { formatEther } from "viem";
import QRCode from "qrcode";
import { useAuditStore } from "../stores/auditStore";
import {
  hasInjectedWallet,
  payWithInjected,
  startWalletConnectPayment,
} from "../lib/wallet";

interface Props {
  packageName: string;
  version: string;
  priceCents: number | null;
  cryptoFeeWei: bigint | null;
  onClose: () => void;
}

type Mode = "choose" | "crypto-choose" | "wc-qr" | "working";

export function PaymentModal({
  packageName,
  version,
  priceCents,
  cryptoFeeWei,
  onClose,
}: Props) {
  const startCheckout = useAuditStore((s) => s.startCheckout);
  const startAuditFromTx = useAuditStore((s) => s.startAuditFromTx);

  const [mode, setMode] = useState<Mode>("choose");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [wcCancel, setWcCancel] = useState<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const injected = hasInjectedWallet();

  useEffect(() => {
    return () => {
      if (wcCancel) wcCancel();
    };
  }, [wcCancel]);

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
      setMode("crypto-choose");
      setStatus(null);
    }
  };

  const handleWalletConnect = async () => {
    if (!cryptoFeeWei) return;
    setError(null);
    setMode("wc-qr");
    setStatus("Scan the QR with your mobile wallet");
    try {
      const handle = await startWalletConnectPayment(packageName, version, cryptoFeeWei);
      setWcCancel(() => handle.cancel);
      const dataUrl = await QRCode.toDataURL(handle.uri, { width: 280, margin: 1 });
      setQrDataUrl(dataUrl);

      const { txHash } = await handle.result;
      setStatus("Transaction sent. Starting audit…");
      setMode("working");
      await startAuditFromTx(txHash, packageName, version);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("cancel")) {
        setError("Payment cancelled");
      } else {
        setError(msg);
      }
      setMode("crypto-choose");
      setQrDataUrl(null);
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

        <h2 style={{ margin: 0, fontSize: "1.2rem" }}>
          Audit {packageName}
          <span style={{ color: "var(--text-dim)" }}>@{version}</span>
        </h2>

        {mode === "choose" && (
          <>
            <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", marginTop: "0.5rem" }}>
              Choose a payment method
            </p>
            <div style={buttonCol}>
              <button style={primaryBtn} onClick={handleStripe}>
                Pay with Stripe
                {priceCents != null && (
                  <span style={subLabel}>${(priceCents / 100).toFixed(2)} · card</span>
                )}
              </button>
              <button
                style={primaryBtn}
                onClick={() => setMode("crypto-choose")}
                disabled={!cryptoFeeWei}
              >
                Pay with Crypto
                <span style={subLabel}>
                  {cryptoFeeWei
                    ? `${formatEther(cryptoFeeWei)} ETH · Base Sepolia`
                    : "Unavailable"}
                </span>
              </button>
            </div>
          </>
        )}

        {mode === "crypto-choose" && (
          <>
            <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", marginTop: "0.5rem" }}>
              {cryptoFeeWei
                ? `Fee: ${formatEther(cryptoFeeWei)} ETH on Base Sepolia`
                : "—"}
            </p>
            <div style={buttonCol}>
              <button
                style={primaryBtn}
                onClick={handleMetaMask}
                disabled={!injected || !cryptoFeeWei}
              >
                MetaMask / Browser wallet
                <span style={subLabel}>
                  {injected ? "Sign in your browser" : "No wallet detected"}
                </span>
              </button>
              <button style={primaryBtn} onClick={handleWalletConnect} disabled={!cryptoFeeWei}>
                WalletConnect
                <span style={subLabel}>Scan QR with mobile wallet</span>
              </button>
            </div>
            <button style={linkBtn} onClick={() => setMode("choose")}>
              ← back
            </button>
          </>
        )}

        {mode === "wc-qr" && (
          <div style={{ textAlign: "center", marginTop: "1rem" }}>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="WalletConnect QR" style={{ width: 260, height: 260 }} />
            ) : (
              <p style={{ color: "var(--text-dim)" }}>Generating QR…</p>
            )}
            <p style={{ color: "var(--text-dim)", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              {status}
            </p>
            <button
              style={linkBtn}
              onClick={() => {
                if (wcCancel) wcCancel();
                setQrDataUrl(null);
                setMode("crypto-choose");
              }}
            >
              cancel
            </button>
          </div>
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
  borderRadius: "0.5rem",
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

const primaryBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.25rem",
  padding: "0.75rem 1rem",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "0.375rem",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: "0.95rem",
};

const subLabel: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--text-dim)",
  fontWeight: "normal",
};

const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-dim)",
  cursor: "pointer",
  fontSize: "0.85rem",
  marginTop: "0.75rem",
  padding: 0,
};
