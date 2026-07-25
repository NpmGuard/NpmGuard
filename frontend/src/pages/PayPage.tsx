/**
 * Payment page (synthesis §1.5) — secure one audit.
 *
 * TRUST BOUNDARY: payment is verified SERVER-SIDE only
 * (engine/npmguard/payments.py). This page OBSERVES; it never decides. It
 * renders ONLY the methods GET /config/public advertises. The wallet signs (via
 * the injected browser provider); the engine verifies the receipt. There is NO
 * private-key path here and no signer beyond window.ethereum — WalletConnect /
 * mobile QR lives in the CLI, not the web app.
 *
 * ── PRESENTATION: what the recomposition onto the token layer changed ───────
 *
 * `styles/pay.css` is gone. Four changes, three of them honesty fixes:
 *
 * 1. The config read was `config: PublicConfig | null` PLUS a parallel
 *    `configFailed: boolean` — two variables encoding one three-state fact, with
 *    `{null, false}` meaning "loading" and `{null, true}` meaning "failed" by
 *    convention. That is precisely the shape `LoadState` exists to delete (N-4:
 *    prefer making a bad state unrepresentable), and it had a representable bad
 *    state — `{config, true}` — that rendered a healthy card over a failed read.
 * 2. That failure rendered `banner--danger`: RED, for our own plumbing failing
 *    to answer. §0 rule 3 reserves red for claims about packages. It is now
 *    `DegradedSurface` in the `error` slot, which also names what failed and
 *    offers retry — a page that just says "could not load payment options" with
 *    no way forward is a dead end.
 * 3. A payment error was also red. Same fix, same reason: a declined card or a
 *    failed chain verify is not a security finding about the package. This
 *    follows the precedent `RepoDetail` set for a rejected mutation.
 * 4. The method tabs were a hand-rolled `role="tablist"` with `aria-selected` on
 *    plain buttons and no roving tabindex — the arrow keys did nothing, which is
 *    the whole point of the tab pattern. They are Radix `Tabs` now.
 *
 * The wallet-rejected notice deliberately stays neutral rather than becoming a
 * degraded state: the user rejecting a transaction is an outcome, not a failure,
 * and nothing was charged.
 */

import { useEffect, useState } from "react";
import { CreditCard, ShieldCheck, Wallet } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import type { Address } from "viem";
import { fetchPublicConfig } from "../lib/api.ts";
import { ApiError } from "../lib/api-base.ts";
import type { PublicConfig } from "@npmguard/shared";
import { formatCents, formatWeiAsEth, truncateMiddle } from "../lib/format.ts";
import { hasInjectedWallet, payWithInjected, WalletRejectedError } from "../lib/wallet.ts";
import { useAuditStore } from "../stores/auditStore.ts";
import { SectionLabel } from "../components/panel/layout.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { DegradedRegion, DegradedSurface } from "../components/ui/degraded-state.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { CommandLine } from "../components/ui/command-line.tsx";
import {
  failed,
  loaded,
  type LoadState,
  type ReadSucceeded,
} from "../components/ui/load-state.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { cn } from "../lib/cn.ts";

type Method = "card" | "crypto";
type CryptoPhase = "idle" | "connecting" | "verifying";

/** The page plane. Not `PanelPage`: this is a single narrow column, not the
 * 1160px dense grid, so it carries its own measure and the `.ng-root` marker. */
function PayPlane({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("ng-root mx-auto grid w-full max-w-[520px] gap-3.5 px-4 pt-10 pb-16", className)}
      {...props}
    />
  );
}

/** The one `ReadSucceeded` this file mints itself, for the "no package in the
 * URL" branch.
 *
 * The token exists to stop an empty state being rendered over a read that
 * FAILED. Here the datum is the URL, and a URL read has no failure mode — there
 * is no fetch to go wrong — so minting it is honest rather than a loophole. The
 * narrowing is a type-level formality: `loaded()` only ever returns the `ok`
 * arm, and the throw documents that rather than guarding against it. */
function urlRead(): ReadSucceeded {
  const state = loaded(null);
  if (state.status !== "ok") throw new Error("loaded() returns the ok arm by construction");
  return state.read;
}

export function PayPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const packageName = params.get("package") ?? "";
  const version = params.get("version") ?? undefined;
  // Crypto + the on-chain event need a concrete version string; the request we
  // submit signs the same string the engine verifies against.
  const payVersion = version ?? "latest";

  const [config, setConfig] = useState<LoadState<PublicConfig>>({ status: "loading" });
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
    const load = () => {
      setConfig({ status: "loading" });
      void fetchPublicConfig()
        .then((c) => live && setConfig(loaded(c)))
        .catch(
          (err) =>
            live &&
            setConfig(
              failed({
                what: "Payment options",
                detail: err instanceof Error ? err.message : undefined,
                retry: load,
              }),
            ),
        );
    };
    load();
    return () => {
      live = false;
    };
  }, []);

  // Default the tab to the first advertised method once config lands.
  const advertised = config.status === "ok" ? config.data : null;
  useEffect(() => {
    if (advertised && tab === null) {
      setTab(advertised.stripeEnabled ? "card" : advertised.crypto ? "crypto" : null);
    }
  }, [advertised, tab]);

  // ---- no package: honest empty state (nothing to pay for) ----
  if (!packageName) {
    return (
      <PayPlane>
        <EmptyState
          // A successful read of the URL, not of the network — there is genuinely
          // nothing here, which is exactly what `EmptyState` means.
          read={urlRead()}
          icon={ShieldCheck}
          message="No package selected to audit."
          hint="Pick a package and the audit fee for it appears here."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate("/packages")}>
              Browse audited packages
            </Button>
          }
        />
      </PayPlane>
    );
  }

  const identity = version ? `${packageName}@${version}` : packageName;
  const cryptoBusy = cryptoPhase !== "idle";

  async function payWithCrypto() {
    const crypto = advertised?.crypto;
    if (!crypto) return;
    setWalletNotice(null);
    setPayError(null);
    setCryptoPhase("connecting");
    try {
      const txHash = await payWithInjected(
        crypto.contract as Address,
        packageName,
        payVersion,
        BigInt(crypto.auditFeeWei),
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
    <PayPlane>
      <SectionLabel>Secure an audit</SectionLabel>
      <h1 className="font-mono text-2xl font-semibold break-all text-text">{identity}</h1>

      {config.status === "loading" ? (
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only">Loading payment options</span>
          {/* Dimensions are known — one card with a tab strip and a CTA — which is
              the only condition under which a skeleton is honest (§3.1). */}
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      ) : config.status === "failed" ? (
        <DegradedSurface
          failure={config.failure}
          escape={{ label: "Browse audited packages", href: "/packages" }}
        />
      ) : (
        <PayCard
          config={config.data}
          read={config.read}
          tab={tab}
          setTab={setTab}
          packageName={packageName}
          version={version}
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

      <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-text-3">
        <ShieldCheck
          aria-hidden="true"
          strokeWidth={1.8}
          className="mt-0.5 size-icon-sm shrink-0"
        />
        Payments are verified by the engine, never the browser. The wallet only signs; the audit
        starts once the engine confirms the payment.
      </p>
    </PayPlane>
  );
}

interface PayCardProps {
  config: PublicConfig;
  read: ReadSucceeded;
  tab: Method | null;
  setTab: (m: Method) => void;
  packageName: string;
  version: string | undefined;
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
  const { config, read, tab, setTab, packageName, version, identity, banner } = props;
  const methods: Method[] = [];
  if (config.stripeEnabled) methods.push("card");
  if (config.crypto) methods.push("crypto");

  if (methods.length === 0) {
    // A SUCCESSFUL read that advertises nothing. The distinction matters here
    // more than anywhere else on the page: "this engine takes no payment" and
    // "we could not ask this engine" must never look the same, because the first
    // is a fact the user can act on and the second is not.
    return (
      <Card>
        <EmptyState
          read={read}
          icon={Wallet}
          message="No payment method is configured on this engine."
          hint="Nothing can be charged here — this deployment advertises neither card nor crypto."
        />
      </Card>
    );
  }

  const panes = (
    <>
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
        // `error` violet, never `danger` red: a declined payment is a failure of
        // our plumbing or the network, not a claim about the package (§0 rule 3).
        <DegradedRegion failure={{ what: "Payment", detail: banner }} />
      ) : null}
    </>
  );

  if (methods.length === 1) {
    return (
      <Card className="overflow-hidden">
        <div className="grid gap-3.5 p-4">{panes}</div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <Tabs value={tab ?? methods[0]} onValueChange={(v) => setTab(v as Method)}>
        <TabsList aria-label="Payment method">
          {methods.map((m) => (
            <TabsTrigger key={m} value={m}>
              {m === "card" ? (
                <CreditCard aria-hidden="true" strokeWidth={1.8} className="size-icon-sm" />
              ) : (
                <Wallet aria-hidden="true" strokeWidth={1.8} className="size-icon-sm" />
              )}
              {m === "card" ? "Pay with card" : "Crypto"}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Radix unmounts the inactive panel, and `panes` is already a function
            of `tab`, so no per-pane guard is needed inside. */}
        {methods.map((m) => (
          <TabsContent key={m} value={m} className="grid gap-3.5 p-4">
            {panes}
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  );
}

/** The metadata rows shared by both panes — price, network, fee, contract. */
function MetaRows({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid gap-0.5 rounded-md border border-border-faint bg-sunken p-3">{children}</dl>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-6.5 items-center justify-between gap-3">
      <dt className="font-mono text-2xs font-medium tracking-wide text-text-3 uppercase">
        {label}
      </dt>
      <dd className="text-right text-sm text-text">{children}</dd>
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
    <div className="grid gap-3">
      <p className="text-sm text-text-2">
        One audit of <span className="font-mono">{identity}</span>.
      </p>
      <MetaRows>
        <MetaRow label="Price">
          <span className="font-mono tabular-nums">{formatCents(priceCents)}</span>
        </MetaRow>
      </MetaRows>
      <Button
        className="w-full"
        disabled={checkoutLoading}
        aria-label={`pay for audit of ${packageName} with card`}
        onClick={onCard}
      >
        {checkoutLoading ? "Redirecting to Stripe…" : `Pay ${formatCents(priceCents)} with card`}
      </Button>
      <p className="text-2xs text-text-3">
        You'll finish on Stripe's secure checkout, then return here.
      </p>
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
  // No "fee unknown" case: the contract offers a `crypto` block only when the
  // engine could read the fee, and retracts the whole method otherwise. The
  // em-dash branch this file used to carry is now unreachable by construction.
  const feeLabel = formatWeiAsEth(crypto.auditFeeWei);
  const cliTarget = version ? `${packageName}@${version}` : packageName;

  return (
    <div className="grid gap-3">
      <MetaRows>
        <MetaRow label="Network">
          <Badge>Base Sepolia</Badge>
        </MetaRow>
        <MetaRow label="Audit fee">
          <span className="font-mono tabular-nums">{feeLabel}</span>
        </MetaRow>
        <MetaRow label="Contract">
          <span className="font-mono" title={crypto.contract}>
            {truncateMiddle(crypto.contract, 10, 8)}
          </span>
        </MetaRow>
      </MetaRows>


      {walletPresent ? (
        <>
          <Button
            className="w-full"
            disabled={cryptoBusy}
            aria-busy={cryptoBusy}
            aria-label={`pay for audit of ${packageName} with crypto`}
            onClick={props.onCrypto}
          >
            {cryptoPhase === "connecting"
              ? "Confirm in your wallet…"
              : cryptoPhase === "verifying"
                ? "Verifying payment…"
                : "Connect wallet & pay"}
          </Button>
          {walletNotice ? (
            // Neutral, not degraded: the user rejecting a transaction is an
            // outcome, and nothing was charged. A hatched error box here would
            // tell them something broke when nothing did.
            <p role="status" className="rounded-md border border-border bg-sunken px-3 py-2 text-sm text-text-2">
              {walletNotice}
            </p>
          ) : null}
          <p className="text-2xs text-text-3">
            Signs <span className="font-mono">requestAudit</span> on Base Sepolia with an injected
            wallet (MetaMask, Rabby). The engine verifies the receipt before the audit runs.
          </p>
        </>
      ) : (
        <div className="grid gap-2.5">
          <p className="text-sm text-text-2">
            No browser wallet detected. On mobile, or to pay over WalletConnect, run the audit from
            the CLI:
          </p>
          {/* Copyable, because this is the one instruction on the page a user
              without a browser wallet has to carry to another terminal. */}
          <CommandLine prompt="npx" command={`npmguard-cli install ${cliTarget}`} />
        </div>
      )}
    </div>
  );
}
