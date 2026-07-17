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
  { href: "/cli", label: "CLI" },
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
      className="app-header flex items-center gap-5 shrink-0"
      style={{
        padding: "0 var(--header-px)",
        height: "var(--header-height)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <button
        className="app-header__logo"
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

      <nav className="app-header__nav flex items-center gap-1" style={{ marginLeft: 8 }}>
        {NAV_LINKS.map((link) => {
          const isActive =
            link.href === "/"
              ? currentPath === "/"
              : currentPath.startsWith(link.href);
          return (
            <a
              key={link.href}
              href={link.href}
              className={`app-header__nav-link app-header__nav-link--${link.label.toLowerCase()}${isActive ? " is-active" : ""}`}
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
          className="app-header__audit-status flex items-center gap-2"
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

      <div className="app-header__actions ml-auto flex items-center gap-3">
        {(isRunning || verdict) && <PhaseProgress />}

        {user ? (
          <div className="app-header__user flex items-center gap-2">
            <span
              aria-hidden="true"
              style={{
                position: "relative",
                display: "grid",
                placeItems: "center",
                width: 22,
                height: 22,
                flexShrink: 0,
                overflow: "hidden",
                borderRadius: "50%",
                border: "1px solid var(--border)",
                background: "var(--bg-secondary)",
                color: "var(--accent-light)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.62rem",
                fontWeight: 700,
              }}
            >
              {user.login.slice(0, 1).toUpperCase()}
              {user.avatarUrl && (
                <img
                  src={user.avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={(event) => event.currentTarget.remove()}
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              )}
            </span>
            <span
              className="app-header__username"
              style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-muted)" }}
            >
              {user.login}
            </span>
            <button
              className="app-header__signout"
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
          className="theme-toggle no-print"
          aria-label="Toggle light/dark theme"
          title="Toggle theme"
        >
          {/* Half-filled circle: reads as "contrast" in either theme */}
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r="6.25"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </header>
  );
}
