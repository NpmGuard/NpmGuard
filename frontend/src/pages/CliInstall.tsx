/**
 * CLI / how-it-works page. Explains the verdict-gating install flow: command
 * cards with a copy affordance, a calm three-step gate (lookup → verdict → act),
 * the three install outcomes, and the two ways to pay for a fresh audit.
 *
 * Pure static content — no engine calls, so there is no read to be honest about
 * and no `LoadState` here.
 *
 * ── PRESENTATION: what the recomposition onto the token layer changed ───────
 *
 * `styles/cli.css` is gone. One change is a correctness fix rather than a
 * restyling, and it is the reason this page was worth touching early:
 *
 * The three outcomes rendered as `pill--safe` / `pill--danger` / `pill--unknown`
 * — one visual axis, three peers. But "no audit on record yet" is not a third
 * verdict, it is the PROGRESS axis, and putting it in the same shape as SAFE and
 * DANGEROUS teaches the reader the exact model the product is trying to unteach
 * (design-direction §0: outcome and progress are separate axes, and `UNKNOWN` is
 * deleted as a visual state). It is now a `ProgressStamp state="unaudited"`,
 * which is achromatic by construction, so the page renders the two-axis model
 * instead of contradicting it — on the one surface whose whole job is explaining
 * that model to a newcomer.
 *
 * The command cards drop their hand-rolled copy button for the shared
 * `ui/command-line.tsx`. The local one swallowed a failed clipboard write
 * (`?.` then a `.then` that never runs on an insecure origin), which leaves the
 * user pasting stale content believing they copied.
 */

import { CreditCard, Smartphone } from "lucide-react";
import { PanelPage, SectionLabel } from "../components/panel/layout.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import { CommandLine } from "../components/ui/command-line.tsx";
import { Kbd } from "../components/ui/kbd.tsx";
import { ProgressStamp, VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import type { Outcome } from "@npmguard/shared";

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

/** The three things the CLI can do at an install, keyed by which AXIS the state
 * lives on. `outcome` is a conclusion the engine reached; `unaudited` is the
 * absence of one, and rendering it as a third verdict is the conflation §0
 * exists to prevent. */
const OUTCOMES: ({ label: string; body: string } & (
  | { axis: "outcome"; outcome: Outcome }
  | { axis: "progress" }
))[] = [
  {
    axis: "outcome",
    outcome: "SAFE",
    label: "Safe",
    body: "Installs immediately. No prompt, no interruption.",
  },
  {
    axis: "outcome",
    outcome: "DANGEROUS",
    label: "Dangerous",
    body: "Prints the confirmed, cited evidence and asks before it continues.",
  },
  {
    axis: "progress",
    label: "No audit yet",
    body: "Offers to run a fresh audit, then gates the install on that result.",
  },
];

function Section({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 grid gap-3" aria-labelledby={id}>
      <h2 id={id}>
        <SectionLabel>{label}</SectionLabel>
      </h2>
      {children}
    </section>
  );
}

export function CliInstall() {
  return (
    <PanelPage className="max-w-[760px]">
      <SectionLabel>Command line</SectionLabel>
      <h1 className="mt-1 text-3xl font-semibold text-text">
        Gate every install behind a verdict.
      </h1>
      <p className="mt-3 max-w-[60ch] text-sm text-text-2">
        <span className="font-mono">npmguard-cli</span> checks a package's audit before it ever
        touches your machine. A SAFE package installs as normal; a DANGEROUS one stops and shows
        you why; an un-audited one can be verified on the spot.
      </p>

      <Section id="pg-cli-run" label="Run">
        <div className="grid gap-3 sm:grid-cols-2">
          <CommandLine
            command="npx npmguard-cli install express"
            note="Resolves, checks the verdict, then installs — or stops."
          />
          <CommandLine
            command="npx npmguard-cli check"
            note="Walks package.json and reports every dependency's status."
          />
        </div>
      </Section>

      <Section id="pg-cli-gate" label="How the gate works">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((step) => (
            <Card key={step.n} className="grid content-start gap-2.5 p-4">
              <div className="flex items-center gap-2">
                <Kbd>{step.n}</Kbd>
                <SectionLabel>{step.label}</SectionLabel>
              </div>
              <p className="text-sm text-text-2">{step.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="pg-cli-verdicts" label="What each verdict does">
        <Card className="px-4">
          {OUTCOMES.map((o) => (
            <div
              key={o.label}
              className="flex items-center gap-3.5 border-b border-border-faint py-3 last:border-b-0"
            >
              {/* Wide enough for the longest stamp ("NO AUDIT YET"), so the body
                  column starts at the same x on all three rows. */}
              <span className="w-[9.5rem] shrink-0">
                {o.axis === "outcome" ? (
                  <VerdictStamp outcome={o.outcome} />
                ) : (
                  <ProgressStamp state="unaudited">{o.label}</ProgressStamp>
                )}
              </span>
              <span className="text-sm text-text-2">{o.body}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section id="pg-cli-pay" label="Paying for an audit">
        <p className="max-w-[60ch] text-sm text-text-2">
          When a package has no verdict yet, npmguard offers to run one. Payment is verified by
          the engine, never by the CLI — the wallet signs, npmguard only observes the receipt.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="grid content-start gap-2 p-4">
            <div className="flex items-center gap-2">
              <CreditCard aria-hidden="true" strokeWidth={1.8} className="size-icon text-accent" />
              <span className="text-base font-semibold text-text">Card</span>
            </div>
            <p className="text-sm text-text-2">
              The CLI opens a Stripe checkout link in your browser. Pay, return, and the audit
              starts.
            </p>
            <span>
              <Badge>Stripe</Badge>
            </span>
          </Card>

          <Card className="grid content-start gap-2 p-4">
            <div className="flex items-center gap-2">
              <Smartphone aria-hidden="true" strokeWidth={1.8} className="size-icon text-accent" />
              <span className="text-base font-semibold text-text">Mobile wallet</span>
            </div>
            <p className="text-sm text-text-2">
              Scan a <span className="font-mono">WalletConnect</span> QR with a mobile wallet and
              sign on Base Sepolia. The engine verifies the on-chain receipt.
            </p>
            <span>
              {/* Mono: a chain id is a machine-authored fact (§2.7). */}
              <Badge mono>Base Sepolia · 84532</Badge>
            </span>
          </Card>
        </div>
      </Section>
    </PanelPage>
  );
}
