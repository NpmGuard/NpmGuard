import { ShieldCheck } from "lucide-react";
import type { MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { githubLoginUrl } from "../features/session/api.ts";
import { useLogout, useSession } from "../features/session/hooks.ts";
import { useAuditStore } from "../stores/auditStore.ts";
import { Button } from "./ui/button.tsx";
import { FOCUS_RING } from "./ui/focus.ts";
import { ProgressStamp, VerdictStamp } from "./ui/verdict-stamp.tsx";
import { cn } from "../lib/cn.ts";

const NAV = [
  { to: "/", label: "Home" },
  // Before Dashboard on purpose: `/scan` is the entry a visitor with no App
  // installation can actually use (F-F5), and the dashboard is what they convert
  // INTO — a nav that leads with the installed-only surface hides the funnel
  // behind the thing it feeds.
  { to: "/scan", label: "Scan" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/packages", label: "Packages" },
  { to: "/replays", label: "Replays" },
  { to: "/how-it-works", label: "How it works" },
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

  const label = phase ? phase.replace(/-/g, " ") : "starting";

  return (
    // The header chip is the ONE place a verdict appears outside its own
    // surface, so it uses the real stamp: glyph + word + colour (§2.4), and a
    // running audit stays achromatic instead of wearing the old `dot--running`
    // blue, which put a status colour on the progress axis.
    <div className="flex items-center gap-2" role="status">
      {verdict ? (
        <VerdictStamp outcome={verdict} />
      ) : (
        <ProgressStamp state="running">{label}</ProgressStamp>
      )}
      <strong className="hidden font-mono text-2xs text-text-2 sm:inline">
        {packageName || "audit"}
      </strong>
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
      <Button asChild variant="outline" size="sm">
        <a href={githubLoginUrl()}>Sign in</a>
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-sunken py-0.5 pr-1 pl-0.5">
      {user.avatarUrl ? (
        <img
          className="size-6 rounded-full"
          src={user.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          onError={(event) => event.currentTarget.remove()}
        />
      ) : (
        // `rounded-full` is legal here: §2.8 reserves round shapes for avatars
        // and count dots, and this is the first of those.
        <span className="flex size-6 items-center justify-center rounded-full bg-accent-wash text-2xs font-medium text-accent-text">
          {user.login.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="text-xs text-text-2">{user.login}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-2xs"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        sign out
      </Button>
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
    // Sticky, and the ONE element that spans every surface — so it is also the
    // one that made dark mode look half-finished while it was on the legacy
    // sheet: a warm-paper bar above a dark page, on every route.
    <header className="sticky top-0 z-30 border-b border-border bg-surface">
      <div className="mx-auto flex h-14 w-full max-w-[1160px] items-center gap-4 px-4 md:px-6 lg:px-8">
        <a
          className={cn("flex shrink-0 items-center gap-2 rounded-sm", FOCUS_RING)}
          href="/"
          onClick={goHome}
          aria-label="NpmGuard home"
        >
          <span className="flex size-7 items-center justify-center rounded-md bg-text text-canvas">
            <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.8} />
          </span>
          <span className="text-sm font-semibold tracking-tight text-text">
            npm<em className="font-semibold text-accent-text not-italic">guard</em>
          </span>
        </a>

        {/* Scrolls rather than wrapping below `sm`: a nav that reflows to two
            rows changes the header's height, and the header is `sticky`, so
            every page's scroll offset would shift with it. */}
        <nav
          aria-label="Primary"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
        >
          {NAV.map((item) => {
            const active = isActive(location.pathname, item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap",
                  "transition-colors duration-fast",
                  active
                    ? "bg-accent-wash text-accent-text"
                    : "text-text-2 hover:bg-sunken hover:text-text",
                  FOCUS_RING,
                )}
                onClick={item.to === "/" ? goHome : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <AuditStatusPill />
          <AuthChip />
        </div>
      </div>
    </header>
  );
}
