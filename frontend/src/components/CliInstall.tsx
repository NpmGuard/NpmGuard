import { useState } from "react";

type CommandBlockProps = {
  title: string;
  command: string;
  note?: string;
};

const WORKFLOW_STEPS = [
  {
    title: "Checks the report store",
    text: "If the package already has a verdict, the CLI can gate the install immediately.",
  },
  {
    title: "Requests an audit when missing",
    text: "Stripe or WalletConnect starts the server-side audit and streams the phases back to the terminal.",
  },
  {
    title: "Installs only after the verdict",
    text: "SAFE installs automatically. DANGEROUS shows findings and asks for explicit confirmation.",
  },
];

const COMMANDS: CommandBlockProps[] = [
  {
    title: "Run once with npx",
    command: "npx npmguard-cli@latest install express",
    note: "No global install required.",
  },
  {
    title: "Install the CLI globally",
    command: "npm install -g npmguard-cli\nnpmguard install lodash@4.17.21",
    note: "Use npmguard like a normal package-manager command.",
  },
  {
    title: "Audit without installing",
    command: "npx npmguard-cli@latest audit react@19.2.4",
    note: "Returns the verdict and keeps node_modules untouched.",
  },
  {
    title: "Check an existing project",
    command: "cd my-project\nnpx npmguard-cli@latest check",
    note: "Walks package.json and checks every dependency.",
  },
];

function CommandBlock({ title, command, note }: CommandBlockProps) {
  const [copied, setCopied] = useState(false);

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-secondary)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 14px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "0.98rem",
              fontWeight: 700,
              letterSpacing: 0,
            }}
          >
            {title}
          </h2>
          {note && (
            <p style={{ color: "var(--text-dim)", fontSize: "0.82rem", marginTop: 2 }}>
              {note}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={copyCommand}
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: 4,
            background: copied ? "var(--safe-bg)" : "var(--bg)",
            color: copied ? "var(--safe)" : "var(--text)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            padding: "5px 9px",
            flexShrink: 0,
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "14px",
          background: "var(--bg-code)",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.84rem",
          lineHeight: 1.6,
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        <code>{command}</code>
      </pre>
    </section>
  );
}

export function CliInstall() {
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "28px", minWidth: 0 }}>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        <header
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.2fr) minmax(280px, 0.8fr)",
            gap: 24,
            alignItems: "end",
            marginBottom: 26,
          }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              npmguard-cli
            </div>
            <h1
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "2rem",
                fontWeight: 780,
                letterSpacing: 0,
                marginBottom: 10,
              }}
            >
              Gate npm installs from your terminal.
            </h1>
            <p style={{ color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 700 }}>
              The CLI checks NpmGuard before a package reaches node_modules. It
              uses https://npmguard.com by default, supports Stripe and
              WalletConnect audit requests, and never handles private keys.
            </p>
          </div>

          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--accent-bg)",
              padding: 16,
            }}
          >
            <div
              style={{
                color: "var(--accent-light)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              Recommended
            </div>
            <pre
              style={{
                margin: 0,
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.86rem",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
              }}
            >
              <code>npx npmguard-cli@latest install express</code>
            </pre>
          </div>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: 12,
            marginBottom: 24,
          }}
        >
          {WORKFLOW_STEPS.map((step, index) => (
            <section
              key={step.title}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-secondary)",
                padding: 16,
              }}
            >
              <div
                style={{
                  color: "var(--accent-light)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.72rem",
                  marginBottom: 8,
                }}
              >
                {String(index + 1).padStart(2, "0")}
              </div>
              <h2
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "1rem",
                  fontWeight: 700,
                  letterSpacing: 0,
                  marginBottom: 6,
                }}
              >
                {step.title}
              </h2>
              <p style={{ color: "var(--text-dim)", fontSize: "0.88rem", lineHeight: 1.5 }}>
                {step.text}
              </p>
            </section>
          ))}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 14,
            marginBottom: 24,
          }}
        >
          {COMMANDS.map((item) => (
            <CommandBlock key={item.title} {...item} />
          ))}
        </div>

        <section
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-secondary)",
            padding: 16,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 16,
          }}
        >
          <div>
            <h2
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "1rem",
                fontWeight: 700,
                marginBottom: 6,
                letterSpacing: 0,
              }}
            >
              Default API
            </h2>
            <p style={{ color: "var(--text-dim)", lineHeight: 1.55 }}>
              The production CLI talks to npmguard.com automatically. For local
              development, pass <code style={{ fontFamily: "var(--font-mono)" }}>--api</code>{" "}
              or set <code style={{ fontFamily: "var(--font-mono)" }}>NPMGUARD_API_URL</code>.
            </p>
          </div>
          <div>
            <h2
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "1rem",
                fontWeight: 700,
                marginBottom: 6,
                letterSpacing: 0,
              }}
            >
              Wallet safety
            </h2>
            <p style={{ color: "var(--text-dim)", lineHeight: 1.55 }}>
              WalletConnect signs in the user's wallet. The CLI observes the
              transaction, while the engine verifies payment server-side before
              running an audit.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
