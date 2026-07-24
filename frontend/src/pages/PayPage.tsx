/**
 * Payment page (synthesis §1.5) — secure one audit.
 *
 * TRUST BOUNDARY: payment is verified SERVER-SIDE only
 * (engine/npmguard/payments.py). This page OBSERVES; it never decides. It
 * renders ONLY the methods GET /config/public advertises. The wallet signs (via
 * the injected browser provider); the engine verifies the receipt. There is NO
 * private-key path here and no signer beyond window.ethereum — WalletConnect /
 * mobile QR lives in the CLI, not the web app.
 */

import { useEffect, useState } from "react";
import { CreditCard, ShieldCheck, Wallet } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import type { Address } from "viem";
import { fetchPublicConfig } from "../lib/api.ts";
import { ApiError } from "../lib/api-base.ts";
import type { PublicConfig } from "../lib/engine-types.ts";
import { formatCents, formatWeiAsEth, truncateMiddle } from "../lib/format.ts";
import { hasInjectedWallet, payWithInjected, WalletRejectedError } from "../lib/wallet.ts";
import { useAuditStore } from "../stores/auditStore.ts";

type Method = "card" | "crypto";
type CryptoPhase = "idle" | "connecting" | "verifying";

export function PayPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const packageName = params.get("package") ?? "";
  const version = params.get("version") ?? undefined;
  // Crypto + the on-chain event need a concrete version string; the request we
  // submit signs the same string the engine verifies against.
  const payVersion = version ?? "latest";

  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [tab, setTab] = useState<Method | null>(null);

  const [cryptoPhase, setCryptoPhase] = useState<CryptoPhase>("idle");
  const [walletNotice, setWalletNotice] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  // window.ethereum is injected before the bundle runs; sample once at mount.
  const [walletPresent] = useState(() => hasInjectedWallet());

  const startCheckout = useAuditStore((s) => s.startCheckout);
  const startAuditFromTx = useAuditStore((s) => s.startAuditFromTx);
  const checkoutLoading = useAuditStore((s) => s.checkoutLoading);
  const storeError = useAuditStore((s) => s.error);

  useEffect(() => {
    let live = true;
    void fetchPublicConfig()
      .then((c) => live && setConfig(c))
      .catch(() => live && setConfigFailed(true));
    return () => {
      live = false;
    };
  }, []);

  // Default the tab to the first advertised method once config lands.
  useEffect(() => {
    if (config && tab === null) {
      setTab(config.stripeEnabled ? "card" : config.crypto ? "crypto" : null);
    }
  }, [config, tab]);

  // ---- no package: honest empty state (nothing to pay for) ----
  if (!packageName) {
    return (
      <div className="pg-pay fade-up">
        <div className="empty-state">
          <span className="empty-state__icon" aria-hidden="true">
            <ShieldCheck size={20} strokeWidth={1.8} />
          </span>
          <p>No package selected to audit.</p>
          <button type="button" className="btn btn--sm" onClick={() => navigate("/packages")}>
            Browse audited packages
          </button>
        </div>
      </div>
    );
  }

  const identity = version ? `${packageName}@${version}` : packageName;
  const cryptoBusy = cryptoPhase !== "idle";

  async function payWithCrypto() {
    const crypto = config?.crypto;
    if (!crypto) return;
    setWalletNotice(null);
    setPayError(null);
    setCryptoPhase("connecting");
    try {
      const txHash = await payWithInjected(
        crypto.contract as Address,
        packageName,
        payVersion,
        BigInt(crypto.auditFeeWei ?? "0"),
      );
      // Signed & broadcast — now the ENGINE verifies the receipt on-chain.
      setCryptoPhase("verifying");
      await startAuditFromTx(txHash, packageName, payVersion);
      const auditId = useAuditStore.getState().auditId;
      navigate(auditId ? `/audit/${auditId}` : "/audit");
    } catch (err) {
      setCryptoPhase("idle");
      if (err instanceof WalletRejectedError) {
        setWalletNotice("Transaction rejected in your wallet — nothing was charged.");
        return;
      }
      // ApiError.message is the server's own message (402 chain-verify failed,
      // 501 chain not configured, …). Branch on the shape, show the message.
      if (err instanceof ApiError) {
        setPayError(err.message);
        return;
      }
      setPayError(err instanceof Error ? err.message : "Payment could not be completed.");
    }
  }

  const cardError = tab === "card" ? storeError : null;
  const banner = payError ?? cardError;

  return (
    <div className="pg-pay fade-up">
      <div className="section-title">
        <span className="eyebrow">Secure an audit</span>
      </div>
      <h1 className="headline mono pg-pay__id">{identity}</h1>

      {!config && !configFailed ? (
        <div className="empty-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <span className="sr-only">Loading payment options</span>
        </div>
      ) : configFailed ? (
        <div className="banner banner--danger" role="alert">
          Could not load payment options from the engine.
        </div>
      ) : (
        <PayCard
          config={config as PublicConfig}
          tab={tab}
          setTab={setTab}
          packageName={packageName}
          version={version}
          payVersion={payVersion}
          identity={identity}
          walletPresent={walletPresent}
          cryptoPhase={cryptoPhase}
          cryptoBusy={cryptoBusy}
          walletNotice={walletNotice}
          banner={banner}
          checkoutLoading={checkoutLoading}
          onCard={() => void startCheckout(packageName, version)}
          onCrypto={() => void payWithCrypto()}
        />
      )}

      <p className="microtext pg-pay__trust">
        <ShieldCheck size={12} strokeWidth={1.8} aria-hidden="true" />
        Payments are verified by the engine, never the browser. The wallet only signs; the audit
        starts once the engine confirms the payment.
      </p>
    </div>
  );
}

interface PayCardProps {
  config: PublicConfig;
  tab: Method | null;
  setTab: (m: Method) => void;
  packageName: string;
  version: string | undefined;
  payVersion: string;
  identity: string;
  walletPresent: boolean;
  cryptoPhase: CryptoPhase;
  cryptoBusy: boolean;
  walletNotice: string | null;
  banner: string | null;
  checkoutLoading: boolean;
  onCard: () => void;
  onCrypto: () => void;
}

function PayCard(props: PayCardProps) {
  const { config, tab, setTab, packageName, version, identity, banner } = props;
  const methods: Method[] = [];
  if (config.stripeEnabled) methods.push("card");
  if (config.crypto) methods.push("crypto");

  if (methods.length === 0) {
    return (
      <div className="card pg-pay__card">
        <div className="empty-state">
          <p>No payment method is configured on this engine.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card pg-pay__card">
      {methods.length > 1 ? (
        <div className="pg-pay-tabs" role="tablist" aria-label="Payment method">
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={tab === m}
              className={`pg-pay-tab${tab === m ? " is-active" : ""}`}
              onClick={() => setTab(m)}
            >
              {m === "card" ? (
                <CreditCard size={14} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Wallet size={14} strokeWidth={1.8} aria-hidden="true" />
              )}
              {m === "card" ? "Pay with card" : "Crypto"}
            </button>
          ))}
        </div>
      ) : null}

      <div className="pg-pay__body">
        {tab === "card" && config.stripeEnabled ? (
          <CardPane
            priceCents={config.priceCents}
            identity={identity}
            packageName={packageName}
            checkoutLoading={props.checkoutLoading}
            onCard={props.onCard}
          />
        ) : null}

        {tab === "crypto" && config.crypto ? (
          <CryptoPane
            crypto={config.crypto}
            packageName={packageName}
            version={version}
            walletPresent={props.walletPresent}
            cryptoPhase={props.cryptoPhase}
            cryptoBusy={props.cryptoBusy}
            walletNotice={props.walletNotice}
            onCrypto={props.onCrypto}
          />
        ) : null}

        {banner ? (
          <div className="banner banner--danger" role="alert">
            {banner}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface CardPaneProps {
  priceCents: number;
  identity: string;
  packageName: string;
  checkoutLoading: boolean;
  onCard: () => void;
}

function CardPane({ priceCents, identity, packageName, checkoutLoading, onCard }: CardPaneProps) {
  return (
    <div className="pg-pay-pane">
      <p className="subtext">
        One audit of <span className="mono">{identity}</span>.
      </p>
      <dl className="pg-pay-meta">
        <div className="pg-pay-meta__row">
          <dt>Price</dt>
          <dd className="mono">{formatCents(priceCents)}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="btn btn--dark pg-pay__cta"
        disabled={checkoutLoading}
        aria-label={`pay for audit of ${packageName} with card`}
        onClick={onCard}
      >
        {checkoutLoading ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Redirecting to Stripe…
          </>
        ) : (
          `Pay ${formatCents(priceCents)} with card`
        )}
      </button>
      <p className="microtext">You'll finish on Stripe's secure checkout, then return here.</p>
    </div>
  );
}

interface CryptoPaneProps {
  crypto: NonNullable<PublicConfig["crypto"]>;
  packageName: string;
  version: string | undefined;
  walletPresent: boolean;
  cryptoPhase: CryptoPhase;
  cryptoBusy: boolean;
  walletNotice: string | null;
  onCrypto: () => void;
}

function CryptoPane(props: CryptoPaneProps) {
  const { crypto, packageName, version, walletPresent, cryptoPhase, cryptoBusy, walletNotice } =
    props;
  const feeLabel = crypto.auditFeeWei ? formatWeiAsEth(crypto.auditFeeWei) : "—";
  const cliTarget = version ? `${packageName}@${version}` : packageName;

  return (
    <div className="pg-pay-pane">
      <dl className="pg-pay-meta">
        <div className="pg-pay-meta__row">
          <dt>Network</dt>
          <dd>
            <span className="pill pill--violet">Base Sepolia</span>
          </dd>
        </div>
        <div className="pg-pay-meta__row">
          <dt>Audit fee</dt>
          <dd className="mono">{feeLabel}</dd>
        </div>
        <div className="pg-pay-meta__row">
          <dt>Contract</dt>
          <dd className="mono" title={crypto.contract}>
            {truncateMiddle(crypto.contract, 10, 8)}
          </dd>
        </div>
      </dl>

      {crypto.auditFeeWei ? null : (
        <p className="microtext">The audit fee could not be read from the contract right now.</p>
      )}

      {walletPresent ? (
        <>
          <button
            type="button"
            className="btn btn--violet pg-pay__cta"
            disabled={cryptoBusy}
            aria-busy={cryptoBusy}
            aria-label={`pay for audit of ${packageName} with crypto`}
            onClick={props.onCrypto}
          >
            {cryptoPhase === "connecting" ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Confirm in your wallet…
              </>
            ) : cryptoPhase === "verifying" ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Verifying payment…
              </>
            ) : (
              "Connect wallet & pay"
            )}
          </button>
          {walletNotice ? (
            <div className="banner pg-pay-notice" role="status">
              {walletNotice}
            </div>
          ) : null}
          <p className="microtext">
            Signs <span className="mono">requestAudit</span> on Base Sepolia with an injected wallet
            (MetaMask, Rabby). The engine verifies the receipt before the audit runs.
          </p>
        </>
      ) : (
        <div className="pg-pay-hint">
          <p className="subtext">
            No browser wallet detected. On mobile, or to pay over WalletConnect, run the audit from
            the CLI:
          </p>
          <p className="pg-pay-cli">
            <kbd>npx</kbd>
            <span className="mono">npmguard-cli install {cliTarget}</span>
          </p>
        </div>
      )}
    </div>
  );
}
