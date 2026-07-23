import { useEffect, useMemo, useState } from "react";

interface PackageSummary {
  packageName: string;
  version: string;
  verdict: string;
  auditedAt: string;
  certificate: {
    status: "anchored" | "pending_anchor" | "not_available";
    certificateHash: string | null;
    anchor: {
      chain: "base-sepolia" | "base";
      batchId: string;
      transactionHash: `0x${string}`;
    } | null;
  };
}

type VerdictFilter = "ALL" | "SAFE" | "SUSPECT" | "DANGEROUS" | "UNKNOWN";
type SortKey = "auditedAt" | "packageName" | "verdict";
const PAGE_SIZE = 10;

function navigate(href: string) {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function verdictColor(verdict: string) {
  if (verdict === "SAFE") {
    return {
      color: "var(--safe)",
      background: "var(--safe-bg)",
      borderColor: "rgba(22, 163, 74, 0.22)",
    };
  }
  if (verdict === "DANGEROUS") {
    return {
      color: "var(--danger)",
      background: "var(--danger-bg)",
      borderColor: "rgba(220, 38, 38, 0.22)",
    };
  }
  if (verdict === "SUSPECT") {
    return {
      color: "var(--suspected)",
      background: "var(--suspected-bg)",
      borderColor: "rgba(180, 120, 20, 0.25)",
    };
  }
  return {
    color: "var(--text-dim)",
    background: "var(--bg-tertiary)",
    borderColor: "var(--border)",
  };
}

function statLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function transactionUrl(pkg: PackageSummary): string | null {
  const anchor = pkg.certificate?.anchor;
  if (!anchor) return null;
  const explorer =
    anchor.chain === "base"
      ? "https://basescan.org/tx/"
      : "https://sepolia.basescan.org/tx/";
  return `${explorer}${anchor.transactionHash}`;
}

export function PackageSearch() {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<VerdictFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("auditedAt");
  const [page, setPage] = useState(1);
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

  const stats = useMemo(() => {
    const safe = packages.filter((p) => p.verdict === "SAFE").length;
    const dangerous = packages.filter((p) => p.verdict === "DANGEROUS").length;
    const suspect = packages.filter((p) => p.verdict === "SUSPECT").length;
    const unknown = packages.length - safe - dangerous - suspect;
    const latestAudit = packages.reduce<string | null>((latest, pkg) => {
      if (!latest) return pkg.auditedAt;
      return new Date(pkg.auditedAt).getTime() > new Date(latest).getTime()
        ? pkg.auditedAt
        : latest;
    }, null);
    return { safe, suspect, dangerous, unknown, latestAudit };
  }, [packages]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return packages
      .filter((pkg) => {
        const matchesSearch =
          query.length === 0 ||
          pkg.packageName.toLowerCase().includes(query) ||
          pkg.version.toLowerCase().includes(query);
        const matchesFilter = filter === "ALL" || pkg.verdict === filter;
        return matchesSearch && matchesFilter;
      })
      .sort((a, b) => {
        if (sortKey === "packageName") {
          return a.packageName.localeCompare(b.packageName);
        }
        if (sortKey === "verdict") {
          return a.verdict.localeCompare(b.verdict) || a.packageName.localeCompare(b.packageName);
        }
        return new Date(b.auditedAt).getTime() - new Date(a.auditedAt).getTime();
      });
  }, [filter, packages, search, sortKey]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const visiblePackages = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const showingFrom = filtered.length === 0 ? 0 : pageStart + 1;
  const showingTo = Math.min(pageStart + PAGE_SIZE, filtered.length);

  const filters: VerdictFilter[] = ["ALL", "SAFE", "SUSPECT", "DANGEROUS", "UNKNOWN"];

  return (
    <div
      className="flex-1"
      style={{
        minHeight: 0,
        overflow: "auto",
        padding: "32px clamp(18px, 4vw, 48px)",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 1180,
          margin: "0 auto",
        }}
      >
        <div
          className="flex items-end justify-between gap-5"
          style={{ marginBottom: 22, flexWrap: "wrap" }}
        >
          <div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              Registry monitor
            </div>
            <h1
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "clamp(1.7rem, 3vw, 2.35rem)",
                fontWeight: 750,
                lineHeight: 1.05,
                letterSpacing: 0,
              }}
            >
              Audited packages
            </h1>
          </div>

          <div
            className="flex items-center"
            style={{
              gap: 8,
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.78rem",
            }}
          >
            <span>{statLabel(filtered.length, "result")}</span>
            <span style={{ color: "var(--text-muted)" }}>/</span>
            <span>{statLabel(packages.length, "audited package", "audited packages")}</span>
          </div>
        </div>

        <div
          className="grid"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 10,
            marginBottom: 18,
          }}
        >
          {[
            {
              label: "Total",
              value: packages.length.toLocaleString(),
              caption: "Reports written",
              showBar: true,
            },
            {
              label: "Safe",
              value: stats.safe.toLocaleString(),
              caption: "No confirmed threat",
              color: stats.safe > 0 ? "var(--safe)" : undefined,
            },
            {
              label: "Dangerous",
              value: stats.dangerous.toLocaleString(),
              caption: "Blocked verdicts",
              color: stats.dangerous > 0 ? "var(--danger)" : undefined,
            },
            {
              label: "Latest",
              value: stats.latestAudit ? formatDate(stats.latestAudit) : "None",
              caption: "Most recent audit",
              demoted: true,
            },
          ].map(({ label, value, caption, color, showBar, demoted }) => (
            <div
              key={label}
              style={{
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                borderRadius: 8,
                padding: "14px 16px",
                minHeight: 86,
              }}
            >
              <div
                style={{
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.7rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {label}
              </div>
              <div
                style={
                  demoted
                    ? {
                        marginTop: 13,
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.95rem",
                        fontWeight: 400,
                        lineHeight: 1.2,
                        color: "var(--text-dim)",
                      }
                    : {
                        marginTop: 9,
                        fontFamily: "var(--font-heading)",
                        fontSize: "1.35rem",
                        fontWeight: 750,
                        lineHeight: 1,
                        color: color ?? "var(--text)",
                        fontVariantNumeric: "tabular-nums",
                      }
                }
              >
                {value}
              </div>
              {showBar && packages.length > 0 ? (
                <div
                  className="verdict-bar"
                  style={{ marginTop: 10 }}
                  role="img"
                  aria-label={`${stats.safe} safe, ${stats.suspect} suspect, ${stats.dangerous} dangerous, ${stats.unknown} unknown`}
                >
                  <span
                    style={{
                      width: `${(stats.safe / packages.length) * 100}%`,
                      background: "var(--safe)",
                    }}
                  />
                  <span
                    style={{
                      width: `${(stats.suspect / packages.length) * 100}%`,
                      background: "var(--suspected)",
                    }}
                  />
                  <span
                    style={{
                      width: `${(stats.dangerous / packages.length) * 100}%`,
                      background: "var(--danger)",
                    }}
                  />
                  <span
                    style={{
                      width: `${(stats.unknown / packages.length) * 100}%`,
                      background: "var(--pending)",
                    }}
                  />
                </div>
              ) : (
                <div
                  style={{
                    marginTop: 8,
                    color: "var(--text-dim)",
                    fontSize: "0.78rem",
                  }}
                >
                  {caption}
                </div>
              )}
            </div>
          ))}
        </div>

        <div
          className="flex items-center gap-3"
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search package or version"
            aria-label="Search package or version"
            style={{
              flex: "1 1 260px",
              minWidth: 0,
              height: 38,
              padding: "0 12px",
              fontFamily: "var(--font-mono)",
              fontSize: "0.82rem",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
            }}
          />

          <div
            className="flex items-center"
            style={{
              border: "1px solid var(--border)",
              background: "var(--bg)",
              borderRadius: 6,
              padding: 3,
              gap: 2,
              overflowX: "auto",
            }}
          >
            {filters.map((item) => {
              const active = item === filter;
              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setFilter(item);
                    setPage(1);
                  }}
                  style={{
                    height: 30,
                    padding: "0 10px",
                    border: "none",
                    borderRadius: 4,
                    background: active ? "var(--accent-bg)" : "transparent",
                    color: active ? "var(--accent-light)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.7rem",
                    fontWeight: 700,
                  }}
                >
                  {item}
                </button>
              );
            })}
          </div>

          <select
            value={sortKey}
            onChange={(e) => {
              setSortKey(e.target.value as SortKey);
              setPage(1);
            }}
            aria-label="Sort packages"
            style={{
              height: 38,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.76rem",
            }}
          >
            <option value="auditedAt">Newest audit</option>
            <option value="packageName">Package name</option>
            <option value="verdict">Verdict</option>
          </select>
        </div>

        <div
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {loading && (
            <div style={{ padding: 42, color: "var(--text-muted)", textAlign: "center" }}>
              Loading packages...
            </div>
          )}

          {error && (
            <div style={{ padding: 42, color: "var(--danger)", textAlign: "center" }}>
              {error}
            </div>
          )}

          {!loading && !error && filtered.length === 0 && (
            <div style={{ padding: 42, color: "var(--text-muted)", textAlign: "center" }}>
              {packages.length === 0 ? "No audited packages yet." : "No packages match these filters."}
            </div>
          )}

          {!loading && !error && filtered.length > 0 && (
            <>
              <div style={{ overflowX: "auto" }}>
              <div
                className="grid package-table-header"
                style={{
                  gap: 16,
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.68rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                <span>Package</span>
                <span>Version</span>
                <span>Verdict</span>
                <span>Audited</span>
                <span>Proof</span>
              </div>

              {visiblePackages.map((pkg) => {
                const colors = verdictColor(pkg.verdict);
                const proofUrl = transactionUrl(pkg);
                return (
                  <div
                    key={`${pkg.packageName}@${pkg.version}`}
                    role="link"
                    tabIndex={0}
                    aria-label={`Open audit report for ${pkg.packageName}@${pkg.version}`}
                    onClick={() => navigate(`/package/${pkg.packageName}`)}
                    onKeyDown={(event) => {
                      if (
                        event.currentTarget === event.target &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        navigate(`/package/${pkg.packageName}`);
                      }
                    }}
                    className="grid package-table-row"
                    style={{
                      gap: 16,
                      alignItems: "center",
                      width: "100%",
                      padding: "13px 16px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      className="package-table-name"
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.86rem",
                        fontWeight: 700,
                      }}
                    >
                      {pkg.packageName}
                    </span>
                    <span
                      className="package-table-version"
                      style={{
                        color: "var(--text-dim)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.78rem",
                      }}
                    >
                      {pkg.version}
                    </span>
                    <span
                      className="package-table-verdict"
                      style={{
                        justifySelf: "start",
                        border: `1px solid ${colors.borderColor}`,
                        background: colors.background,
                        color: colors.color,
                        borderRadius: 4,
                        padding: "4px 9px",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.66rem",
                        fontWeight: 800,
                        lineHeight: 1,
                      }}
                    >
                      {pkg.verdict}
                    </span>
                    <span
                      className="package-table-audited"
                      style={{
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.76rem",
                      }}
                    >
                      {formatDate(pkg.auditedAt)}
                    </span>
                    <span className="package-table-proof">
                      {proofUrl && pkg.certificate.anchor ? (
                        <a
                          className="package-proof-link"
                          href={proofUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={pkg.certificate.certificateHash ?? undefined}
                          aria-label={`Open Merkle proof batch ${pkg.certificate.anchor.batchId} for ${pkg.packageName} on Basescan`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          Batch #{pkg.certificate.anchor.batchId}
                          <span aria-hidden="true">↗</span>
                        </a>
                      ) : pkg.certificate?.status === "pending_anchor" ? (
                        <span
                          className="package-proof-pending"
                          title="The certificate will be anchored with its repository batch"
                        >
                          <span className="package-proof-dot" aria-hidden="true" />
                          Anchoring
                        </span>
                      ) : (
                        <span className="package-proof-missing" aria-label="No on-chain proof">
                          —
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
              </div>

              <div
                className="flex items-center justify-between gap-3"
                style={{
                  padding: "12px 16px",
                  borderTop: "1px solid var(--border)",
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                  }}
                >
                  Showing {showingFrom}-{showingTo} of {filtered.length}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={currentPage === 1}
                    style={{
                      height: 32,
                      padding: "0 11px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--bg)",
                      color: currentPage === 1 ? "var(--text-muted)" : "var(--text)",
                      opacity: currentPage === 1 ? 0.5 : 1,
                      cursor: currentPage === 1 ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                    }}
                  >
                    Previous
                  </button>
                  <span
                    style={{
                      minWidth: 54,
                      textAlign: "center",
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                    }}
                  >
                    {currentPage}/{pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                    disabled={currentPage === pageCount}
                    style={{
                      height: 32,
                      padding: "0 11px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--bg)",
                      color: currentPage === pageCount ? "var(--text-muted)" : "var(--text)",
                      opacity: currentPage === pageCount ? 0.5 : 1,
                      cursor: currentPage === pageCount ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                    }}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
