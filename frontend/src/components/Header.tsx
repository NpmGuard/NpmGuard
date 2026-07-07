import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuditStore } from "../stores/auditStore";
import { usePanelStore } from "../stores/panelStore";
import { PhaseProgress } from "./PhaseProgress";

const API_BASE = "/api";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/packages", label: "Packages" },
  { href: "/benchmark", label: "Benchmark" },
];

export function Header() {
  const isRunning = useAuditStore((s) => s.isRunning);
  const packageName = useAuditStore((s) => s.packageName);
  const verdict = useAuditStore((s) => s.verdict);
  const reset = useAuditStore((s) => s.reset);

  const user = usePanelStore((s) => s.user);
  const userLoaded = usePanelStore((s) => s.userLoaded);
  const fetchMe = usePanelStore((s) => s.fetchMe);
  const logout = usePanelStore((s) => s.logout);

  const navigate = useNavigate();
  const { pathname: currentPath } = useLocation();

  useEffect(() => {
    if (!userLoaded) void fetchMe();
  }, [userLoaded, fetchMe]);

  const statusColor = verdict
    ? verdict === "DANGEROUS"
      ? "var(--danger)"
      : "var(--safe)"
    : "var(--investigating)";

  const goHome = () => {
    reset();
    navigate("/");
  };

  return (
    <header
      className="flex items-center gap-5 shrink-0"
      style={{
        padding: "0 var(--header-px)",
        height: "var(--header-height)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <button
        onClick={goHome}
        aria-label="Go to home page"
        style={{
          fontFamily: "var(--font-heading)",
          fontWeight: 700,
          fontSize: "1rem",
          letterSpacing: "-0.02em",
          cursor: "pointer",
          background: "none",
          border: "none",
          padding: 0,
          color: "inherit",
        }}
      >
        npm<span style={{ color: "var(--accent)" }}>guard</span>
      </button>

      <nav className="flex items-center gap-1" style={{ marginLeft: 8 }}>
        {NAV_LINKS.map((link) => {
          const isActive =
            link.href === "/"
              ? currentPath === "/"
              : currentPath.startsWith(link.href);
          return (
            <a
              key={link.href}
              href={link.href}
              onClick={(e) => {
                e.preventDefault();
                if (link.href === "/") reset();
                navigate(link.href);
              }}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                padding: "4px 10px",
                borderRadius: 4,
                color: isActive ? "var(--accent-light)" : "var(--text-muted)",
                background: isActive ? "var(--bg-secondary)" : "transparent",
                textDecoration: "none",
                cursor: "pointer",
                transition: "color 0.15s, background 0.15s",
              }}
            >
              {link.label}
            </a>
          );
        })}
      </nav>

      {(isRunning || verdict) && (
        <div
          className="flex items-center gap-2"
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 20,
            padding: "4px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: "0.8rem",
            maxWidth: "30vw",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: statusColor,
              flexShrink: 0,
            }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {packageName}
          </span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-3">
        {(isRunning || verdict) && <PhaseProgress />}

        {user ? (
          <div className="flex items-center gap-2">
            {user.avatarUrl && (
              <img
                src={user.avatarUrl}
                alt={user.login}
                style={{ width: 20, height: 20, borderRadius: "50%", border: "1px solid var(--border)" }}
              />
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}>
              {user.login}
            </span>
            <button
              onClick={() => void logout()}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                color: "var(--text-muted)",
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              sign out
            </button>
          </div>
        ) : (
          userLoaded && (
            <a
              href={`${API_BASE}/auth/github/login`}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                color: "var(--accent-light)",
                border: "1px solid var(--accent)",
                borderRadius: 4,
                padding: "3px 10px",
                textDecoration: "none",
              }}
            >
              Sign in
            </a>
          )
        )}

        <button
          onClick={() =>
            document.documentElement.classList.toggle("urushi")
          }
          className="flex items-center gap-1"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            color: "var(--text-muted)",
            padding: 0,
          }}
          aria-label="Toggle theme"
        >
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--accent)",
            }}
          />
        </button>
      </div>
    </header>
  );
}
