import { useState, useEffect } from "react";

interface PackageSummary {
  packageName: string;
  version: string;
  verdict: string;
  auditedAt: string;
}

function navigate(href: string) {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function PackageSearch() {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/packages")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => {
        setPackages(data.packages ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(`Failed to load packages: ${err.message}`);
        setLoading(false);
      });
  }, []);

  const filtered = packages.filter((p) =>
    p.packageName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      className="flex-1 flex flex-col items-center"
      style={{ padding: "48px 24px" }}
    >
      <h1
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: "1.6rem",
          fontWeight: 700,
          marginBottom: 8,
          letterSpacing: "-0.02em",
        }}
      >
        Audited Packages
      </h1>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: "0.85rem",
          marginBottom: 24,
        }}
      >
        Browse previously audited npm packages.
      </p>

      <div style={{ width: "100%", maxWidth: 600 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search packages..."
          style={{
            width: "100%",
            padding: "10px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.85rem",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            outline: "none",
            marginBottom: 20,
          }}
        />

        {loading && (
          <div
            style={{
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "0.85rem",
              padding: 32,
            }}
          >
            Loading...
          </div>
        )}

        {error && (
          <div
            style={{
              textAlign: "center",
              color: "var(--danger)",
              fontSize: "0.85rem",
              padding: 32,
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: "0.85rem",
              padding: 48,
            }}
          >
            {packages.length === 0
              ? "No packages audited yet."
              : "No packages match your search."}
          </div>
        )}

        {!loading &&
          !error &&
          filtered.map((pkg) => (
            <button
              key={`${pkg.packageName}@${pkg.version}`}
              type="button"
              onClick={() => navigate(`/package/${pkg.packageName}`)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                width: "100%",
                padding: "14px 16px",
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                marginBottom: 8,
                cursor: "pointer",
                color: "var(--text)",
                textAlign: "left",
                transition: "border-color 0.15s",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.88rem",
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {pkg.packageName}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.7rem",
                    color: "var(--text-muted)",
                    marginTop: 2,
                  }}
                >
                  v{pkg.version} &middot;{" "}
                  {new Date(pkg.auditedAt).toLocaleDateString()}
                </div>
              </div>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.6rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  padding: "3px 10px",
                  borderRadius: 4,
                  flexShrink: 0,
                  background:
                    pkg.verdict === "SAFE"
                      ? "var(--safe-bg, rgba(0,200,100,0.1))"
                      : "var(--danger-bg)",
                  color:
                    pkg.verdict === "SAFE"
                      ? "var(--safe)"
                      : "var(--danger)",
                }}
              >
                {pkg.verdict}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
