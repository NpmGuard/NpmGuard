/**
 * Trust badge that surfaces the payment proof for an audit run.
 *
 * Wave 1 source: URL query string (`?tx=0x…&chain=base-sepolia` from the
 * WalletConnect flow, or `?session_id=cs_…` from Stripe). The persisted
 * report doesn't currently store the payment proof — that lives elsewhere.
 *
 * Hidden when no proof is available (dev-mode, cached deep-link, etc.) so
 * the layout doesn't show an empty pill.
 */

const EXPLORERS: Record<string, string> = {
  "base-sepolia": "https://sepolia.basescan.org/tx/",
  "base": "https://basescan.org/tx/",
  "ethereum": "https://etherscan.io/tx/",
};

export interface PaymentProofBadgeProps {
  /** Optional override — if not provided, we read from the current URL. */
  txHash?: string | null;
  chain?: string | null;
  stripeSessionId?: string | null;
}

function readFromUrl() {
  if (typeof window === "undefined") return { tx: null, chain: null, session: null };
  const params = new URLSearchParams(window.location.search);
  return {
    tx: params.get("tx") || params.get("txHash"),
    chain: params.get("chain") || "base-sepolia",
    session: params.get("session_id") || params.get("sessionId"),
  };
}

export function PaymentProofBadge({ txHash, chain, stripeSessionId }: PaymentProofBadgeProps = {}) {
  const fromUrl = readFromUrl();
  const tx = txHash ?? fromUrl.tx;
  const ch = chain ?? fromUrl.chain;
  const stripe = stripeSessionId ?? fromUrl.session;

  if (tx) {
    const explorer = EXPLORERS[ch || "base-sepolia"] || EXPLORERS["base-sepolia"];
    const short = `${tx.slice(0, 6)}…${tx.slice(-4)}`;
    return (
      <a
        href={`${explorer}${tx}`}
        target="_blank"
        rel="noopener noreferrer"
        title={`Payment verified on ${ch}: ${tx}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 9px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--accent-light)",
          background: "var(--accent-bg)",
          color: "var(--accent-light)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.62rem",
          fontWeight: 600,
          textDecoration: "none",
          letterSpacing: "0.03em",
        }}
      >
        <span style={{ fontSize: "0.55rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          On-chain proof
        </span>
        <span>{short}</span>
        <span style={{ fontSize: "0.55rem", opacity: 0.7 }}>↗</span>
      </a>
    );
  }

  if (stripe) {
    return (
      <span
        title={`Stripe session: ${stripe}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 9px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--accent-light)",
          background: "var(--accent-bg)",
          color: "var(--accent-light)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.62rem",
          fontWeight: 600,
          letterSpacing: "0.03em",
        }}
      >
        <span style={{ fontSize: "0.55rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Stripe verified
        </span>
        <span>{stripe.slice(-8)}</span>
      </span>
    );
  }

  return null;
}
