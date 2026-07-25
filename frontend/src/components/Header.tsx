import { ShieldCheck } from "lucide-react";
import type { MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { githubLoginUrl } from "../features/session/api.ts";
import { useLogout, useSession } from "../features/session/hooks.ts";
import { useAuditStore } from "../stores/auditStore.ts";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/packages", label: "Packages" },
  { to: "/cli", label: "CLI" },
];

function isActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/" || pathname.startsWith("/audit");
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Live status of the in-flight audit — mirrors the fold, so it survives
 * navigation (the shell never remounts). */
function AuditStatusPill() {
  const running = useAuditStore((s) => s.running);
  const verdict = useAuditStore((s) => s.verdict);
  const packageName = useAuditStore((s) => s.packageName);
  const phase = useAuditStore((s) => s.phase);

  if (!running && !verdict) return null;

  const tone = verdict === "SAFE" ? "safe" : verdict === "DANGEROUS" ? "danger" : "running";
  const label = verdict ?? (phase ? phase.replace(/-/g, " ") : "starting");

  return (
    <div className="status-pill" role="status">
      <span className={`dot dot--${tone}`} />
      <strong className="mono">{packageName || "audit"}</strong>
      <span>{label}</span>
    </div>
  );
}

/** GitHub session chip. Renders nothing until the session read settles, then
 * either the signed-in identity (avatar → login → sign out) or a "Sign in" link
 * that starts the OAuth web flow.
 *
 * The mount-time `fetchMe()` effect is gone: the query fires itself, and it is
 * the SAME cache entry the dashboard observes, so the two of them make one
 * request rather than two. A failed session read renders nothing here — the
 * header is not where a person can act on it, and the dashboard names it. */
function AuthChip() {
  const session = useSession();
  const logout = useLogout();

  if (session.status !== "ok") return null;
  const user = session.data.user;

  if (!user) {
    return (
      <a className="btn btn--sm" href={githubLoginUrl()}>
        Sign in
      </a>
    );
  }

  return (
    <div className="auth-chip">
      {user.avatarUrl ? (
        <img
          className="auth-chip__avatar"
          src={user.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={(event) => event.currentTarget.remove()}
        />
      ) : (
        <span className="auth-chip__avatar auth-chip__avatar--letter">
          {user.login.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="auth-chip__login">{user.login}</span>
      <button
        type="button"
        className="auth-chip__signout"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        sign out
      </button>
    </div>
  );
}

export function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const reset = useAuditStore((s) => s.reset);

  const goHome = (event: MouseEvent) => {
    event.preventDefault();
    reset();
    navigate("/");
  };

  return (
    <header className="topbar">
      <div className="topbar__left">
        <a className="brand" href="/" onClick={goHome} aria-label="NpmGuard home">
          <span className="brand__mark">
            <ShieldCheck size={17} strokeWidth={1.8} />
          </span>
          <span className="brand__name">
            npm<em>guard</em>
          </span>
        </a>
      </div>
      <nav className="topbar__center" aria-label="Primary">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={`nav-item${isActive(location.pathname, item.to) ? " active" : ""}`}
            onClick={item.to === "/" ? goHome : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="topbar__right">
        <AuditStatusPill />
        <AuthChip />
      </div>
    </header>
  );
}
