import { useState } from "react";

type CliActionId = "install" | "audit" | "check";

type CliAction = {
  id: CliActionId;
  label: string;
  description: string;
  outcome: string;
  command: (packageName: string) => string;
};

const CLI_ACTIONS: CliAction[] = [
  {
    id: "install",
    label: "Install a package",
    description: "Check the verdict, then install only when it clears.",
    outcome: "SAFE continues to your package manager. DANGEROUS stops for confirmation.",
    command: (packageName) =>
      `npx npmguard-cli@latest install ${packageName}`,
  },
  {
    id: "audit",
    label: "Audit without installing",
    description: "Get a verdict without touching node_modules.",
    outcome: "The command returns the report and leaves your project unchanged.",
    command: (packageName) =>
      `npx npmguard-cli@latest audit ${packageName}`,
  },
  {
    id: "check",
    label: "Check this project",
    description: "Review every dependency already in package.json.",
    outcome: "NpmGuard lists the audit status of each project dependency.",
    command: () => "npx npmguard-cli@latest check",
  },
];

const FLOW_STEPS = [
  {
    label: "Resolve",
    title: "Pin the exact version",
    text: "The CLI resolves the package version and checks NpmGuard for an existing report.",
  },
  {
    label: "Verify",
    title: "Audit when needed",
    text: "If no report exists, pay by card or wallet. The engine verifies payment and runs the audit.",
  },
  {
    label: "Decide",
    title: "Install or stop",
    text: "SAFE proceeds from npm. DANGEROUS shows the findings and waits for your decision.",
  },
];

const USEFUL_OPTIONS = [
  {
    flag: "--force",
    description: "Install after a DANGEROUS verdict without the confirmation prompt.",
  },
  {
    flag: "--api <url>",
    description: "Point the CLI to a local or self-hosted audit engine.",
  },
  {
    flag: "--path <dir>",
    description: "Run check against a project outside the current directory.",
  },
  {
    flag: "--install-source npm|auto|pinata|ens",
    description: "Choose the package source. npm is the production default.",
  },
];

type CopyButtonProps = {
  copied: boolean;
  label?: string;
  onCopy: () => void;
};

function CopyButton({ copied, label = "Copy command", onCopy }: CopyButtonProps) {
  return (
    <button
      type="button"
      className={`cli-copy-button${copied ? " is-copied" : ""}`}
      onClick={onCopy}
      aria-label={copied ? "Command copied" : label}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {copied ? (
          <path d="m3.2 8.3 3 3 6.6-7" />
        ) : (
          <>
            <rect x="5.2" y="4.8" width="7.4" height="8" rx="1.2" />
            <path d="M10.6 4.8V3.2H3.4v7.5h1.8" />
          </>
        )}
      </svg>
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function CliInstall() {
  const [activeActionId, setActiveActionId] =
    useState<CliActionId>("install");
  const [packageName, setPackageName] = useState("express");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const activeAction =
    CLI_ACTIONS.find((action) => action.id === activeActionId) ??
    CLI_ACTIONS[0];
  const normalizedPackageName = packageName.trim() || "<package>";
  const activeCommand = activeAction.command(normalizedPackageName);

  const copyCommand = async (command: string, id: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedId(id);
      window.setTimeout(
        () => setCopiedId((current) => (current === id ? null : current)),
        1600,
      );
    } catch {
      setCopiedId(null);
    }
  };

  return (
    <div className="cli-page">
      <div className="cli-shell">
        <section className="cli-hero" aria-labelledby="cli-title">
          <div className="cli-hero__copy">
            <div className="cli-kicker">
              <span aria-hidden="true" />
              NpmGuard CLI
            </div>
            <h1 id="cli-title">
              Stop risky packages
              <span> before install.</span>
            </h1>
            <p>
              Put a server-verified security verdict between any npm package
              and your node_modules. Run it once with npx—no global setup and
              no private keys in the terminal.
            </p>
            <div className="cli-hero__meta" aria-label="CLI highlights">
              <span>npm · pnpm · yarn</span>
              <span>No global install</span>
              <span>Wallet stays in custody</span>
            </div>
            <a className="cli-primary-link" href="#cli-quickstart">
              Build your command
              <span aria-hidden="true">↓</span>
            </a>
          </div>

          <div className="cli-terminal" aria-label="Example of a safe CLI run">
            <div className="cli-terminal__topbar">
              <div className="cli-terminal__dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <span>~/projects/acme</span>
              <span className="cli-terminal__status">guard active</span>
            </div>
            <div className="cli-terminal__body">
              <div className="cli-terminal__caption">A typical SAFE run</div>
              <code className="cli-terminal__command">
                <span aria-hidden="true">$</span> npx npmguard-cli@latest install
                express
              </code>
              <div className="cli-terminal__trace">
                <div>
                  <span className="is-done" aria-hidden="true">✓</span>
                  <p>
                    <strong>Version resolved</strong>
                    <small>express · latest</small>
                  </p>
                </div>
                <div>
                  <span className="is-done" aria-hidden="true">✓</span>
                  <p>
                    <strong>Report verified</strong>
                    <small>Cached audit · certificate matched</small>
                  </p>
                </div>
                <div>
                  <span className="is-safe" aria-hidden="true">✓</span>
                  <p>
                    <strong>SAFE · install allowed</strong>
                    <small>Continuing with your package manager</small>
                  </p>
                </div>
              </div>
              <div className="cli-terminal__footer">
                <span className="cli-terminal__pulse" aria-hidden="true" />
                Package cleared before node_modules
              </div>
            </div>
          </div>
        </section>

        <section
          id="cli-quickstart"
          className="cli-quickstart"
          aria-labelledby="cli-quickstart-title"
        >
          <div className="cli-section-heading">
            <div>
              <span className="cli-section-label">Quick start</span>
              <h2 id="cli-quickstart-title">What do you want to do?</h2>
            </div>
            <p>Choose a task, customize the package, and paste the result.</p>
          </div>

          <div className="cli-command-builder">
            <div className="cli-action-list" aria-label="CLI tasks">
              {CLI_ACTIONS.map((action, index) => {
                const isActive = action.id === activeAction.id;
                return (
                  <button
                    key={action.id}
                    type="button"
                    className={`cli-action${isActive ? " is-active" : ""}`}
                    onClick={() => setActiveActionId(action.id)}
                    aria-pressed={isActive}
                  >
                    <span className="cli-action__number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>
                      <strong>{action.label}</strong>
                      <small>{action.description}</small>
                    </span>
                    <span className="cli-action__arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="cli-command-preview">
              <div className="cli-command-preview__header">
                <div>
                  <span>Selected task</span>
                  <strong>{activeAction.label}</strong>
                </div>
                <CopyButton
                  copied={copiedId === "active"}
                  onCopy={() => void copyCommand(activeCommand, "active")}
                />
              </div>

              {activeAction.id !== "check" && (
                <label className="cli-package-field">
                  <span>Package name</span>
                  <input
                    value={packageName}
                    onChange={(event) => setPackageName(event.target.value)}
                    placeholder="@scope/package@version"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoComplete="off"
                  />
                </label>
              )}

              <pre className="cli-command-preview__code">
                <code>
                  <span aria-hidden="true">$ </span>
                  {activeCommand}
                </code>
              </pre>

              <div className="cli-command-preview__outcome">
                <span aria-hidden="true">↳</span>
                <p>{activeAction.outcome}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="cli-flow" aria-labelledby="cli-flow-title">
          <div className="cli-section-heading">
            <div>
              <span className="cli-section-label">After you press Enter</span>
              <h2 id="cli-flow-title">One gate, three decisions</h2>
            </div>
            <p>The install only happens after the security result is known.</p>
          </div>
          <div className="cli-flow__steps">
            {FLOW_STEPS.map((step, index) => (
              <article key={step.label} className="cli-flow-step">
                <div className="cli-flow-step__marker">
                  <span>{index + 1}</span>
                </div>
                <div>
                  <span className="cli-flow-step__label">{step.label}</span>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="cli-detail-grid">
          <section className="cli-options" aria-labelledby="cli-options-title">
            <div className="cli-section-heading cli-section-heading--compact">
              <div>
                <span className="cli-section-label">Reference</span>
                <h2 id="cli-options-title">Useful options</h2>
              </div>
            </div>
            <div className="cli-options__list">
              {USEFUL_OPTIONS.map((option) => (
                <div key={option.flag} className="cli-option">
                  <code>{option.flag}</code>
                  <p>{option.description}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="cli-trust" aria-labelledby="cli-trust-title">
            <span className="cli-section-label">Trust boundary</span>
            <h2 id="cli-trust-title">Your wallet signs. The engine verifies.</h2>
            <p>
              Stripe, browser wallet, and WalletConnect can request a missing
              audit. Payment verification and the decision to run the audit
              stay server-side.
            </p>
            <ul>
              <li>
                <span aria-hidden="true">✓</span>
                The CLI never reads or stores a private key
              </li>
              <li>
                <span aria-hidden="true">✓</span>
                npm is the default install source after SAFE
              </li>
              <li>
                <span aria-hidden="true">✓</span>
                Certificates bind the verdict to the audited tarball
              </li>
            </ul>
            <div className="cli-global-install">
              <div>
                <span>Prefer a global command?</span>
                <code>npm install -g npmguard-cli</code>
              </div>
              <CopyButton
                copied={copiedId === "global"}
                label="Copy global install command"
                onCopy={() =>
                  void copyCommand(
                    "npm install -g npmguard-cli",
                    "global",
                  )
                }
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
