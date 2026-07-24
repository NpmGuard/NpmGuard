/**
 * CLI / how-it-works page. Explains the verdict-gating install flow:
 * styled command cards with a copy affordance, a calm three-step gate
 * (lookup → verdict → act), the three verdict outcomes as tone pills, and the
 * two ways to pay for a fresh audit (Stripe card, WalletConnect on Base Sepolia).
 *
 * Pure static content — no engine calls. Composes base.css primitives; owns
 * src/styles/cli.css (`.pg-cli-…`).
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy, CreditCard, Smartphone } from "lucide-react";

/** A single shell command in a keyline card with a copy button. */
function CommandCard({ command, note }: { command: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function onCopy() {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <div className="pg-cli-cmdgroup">
      <div className="pg-cli-cmd">
        <span className="pg-cli-cmd__prompt mono" aria-hidden="true">
          $
        </span>
        <code className="pg-cli-cmd__text mono">{command}</code>
        <button
          type="button"
          className="icon-btn pg-cli-cmd__copy"
          onClick={onCopy}
          aria-label={copied ? `copied command ${command}` : `copy command ${command}`}
        >
          {copied ? (
            <Check size={14} strokeWidth={1.8} />
          ) : (
            <Copy size={14} strokeWidth={1.8} />
          )}
        </button>
      </div>
      {note ? <span className="microtext">{note}</span> : null}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}

const STEPS: { n: string; label: string; body: string }[] = [
  {
    n: "1",
    label: "Lookup",
    body: "npmguard resolves the exact name and version, then asks the engine whether it already holds a verdict for that release.",
  },
  {
    n: "2",
    label: "Verdict",
    body: "The engine answers with one of three states — a confirmed SAFE, a confirmed DANGEROUS, or no audit on record yet.",
  },
  {
    n: "3",
    label: "Act",
    body: "SAFE installs straight through. DANGEROUS stops and asks. No audit on record → npmguard offers to run one before anything lands.",
  },
];

const OUTCOMES: { tone: string; label: string; body: string }[] = [
  {
    tone: "pill--safe",
    label: "Safe",
    body: "Installs immediately. No prompt, no interruption.",
  },
  {
    tone: "pill--danger",
    label: "Dangerous",
    body: "Prints the confirmed, cited evidence and asks before it continues.",
  },
  {
    tone: "pill--unknown",
    label: "No audit yet",
    body: "Offers to run a fresh audit, then gates the install on that result.",
  },
];

export function CliInstall() {
  return (
    <div className="page__inner pg-cli fade-up">
      <div className="section-title">
        <span className="eyebrow">Command line</span>
      </div>
      <h1 className="headline">Gate every install behind a verdict.</h1>
      <p className="subtext pg-cli-lede">
        <span className="mono">npmguard-cli</span> checks a package's audit before it
        ever touches your machine. A SAFE package installs as normal; a DANGEROUS one
        stops and shows you why; an un-audited one can be verified on the spot.
      </p>

      {/* ---- Command cards ---- */}
      <section className="pg-cli-section" aria-labelledby="pg-cli-run">
        <span id="pg-cli-run" className="eyebrow eyebrow--faint">
          Run
        </span>
        <div className="pg-cli-cmds">
          <CommandCard
            command="npx npmguard-cli install express"
            note="Resolves, checks the verdict, then installs — or stops."
          />
          <CommandCard
            command="npx npmguard-cli check"
            note="Walks package.json and reports every dependency's status."
          />
        </div>
      </section>

      {/* ---- The gate: three steps ---- */}
      <section className="pg-cli-section" aria-labelledby="pg-cli-gate">
        <span id="pg-cli-gate" className="eyebrow eyebrow--faint">
          How the gate works
        </span>
        <div className="pg-cli-steps">
          {STEPS.map((step) => (
            <div key={step.n} className="card pg-cli-step">
              <div className="pg-cli-step__head">
                <kbd>{step.n}</kbd>
                <span className="eyebrow">{step.label}</span>
              </div>
              <p className="subtext">{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Outcomes ---- */}
      <section className="pg-cli-section" aria-labelledby="pg-cli-verdicts">
        <span id="pg-cli-verdicts" className="eyebrow eyebrow--faint">
          What each verdict does
        </span>
        <div className="card pg-cli-outcomes">
          {OUTCOMES.map((o) => (
            <div key={o.label} className="pg-cli-outcome">
              <span className="pg-cli-outcome__label">
                <span className={`pill ${o.tone}`}>{o.label}</span>
              </span>
              <span className="subtext">{o.body}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Payment ---- */}
      <section className="pg-cli-section" aria-labelledby="pg-cli-pay">
        <span id="pg-cli-pay" className="eyebrow eyebrow--faint">
          Paying for an audit
        </span>
        <p className="subtext pg-cli-pay-lede">
          When a package has no verdict yet, npmguard offers to run one. Payment is
          verified by the engine, never by the CLI — the wallet signs, npmguard only
          observes the receipt.
        </p>
        <div className="pg-cli-pay">
          <div className="card pg-cli-pay__card">
            <div className="pg-cli-pay__head">
              <CreditCard size={16} strokeWidth={1.8} className="pg-cli-pay__icon" />
              <span className="headline headline--sm">Card</span>
            </div>
            <p className="subtext">
              The CLI opens a Stripe checkout link in your browser. Pay, return, and the
              audit starts.
            </p>
            <span className="tag tag--violet">Stripe</span>
          </div>

          <div className="card pg-cli-pay__card">
            <div className="pg-cli-pay__head">
              <Smartphone size={16} strokeWidth={1.8} className="pg-cli-pay__icon" />
              <span className="headline headline--sm">Mobile wallet</span>
            </div>
            <p className="subtext">
              Scan a <span className="mono">WalletConnect</span> QR with a mobile wallet
              and sign on Base Sepolia. The engine verifies the on-chain receipt.
            </p>
            <span className="tag tag--blue">Base Sepolia · 84532</span>
          </div>
        </div>
      </section>
    </div>
  );
}
