/**
 * The application shell — one persistent workbench frame around every
 * operational route.
 *
 * The product is deliberately two experiences. A visitor deciding whether to
 * trust this thing gets a spacious public site; someone WORKING gets a dense,
 * full-viewport tool. Both are npmguard, and they are meant to look related and
 * feel different — a marketing-width column with a hero above it is the wrong
 * container for a dependency table you scan forty rows of.
 *
 * So the shell owns identity, navigation, search, account state and the
 * secondary context for the current section, and hands the rest of the viewport
 * to the page. `min-h-0` and `overflow-hidden` run the whole way down the tree
 * because a single missing one turns "the table scrolls" into "the page
 * scrolls", which is the difference between an application and a document.
 *
 * The sidebar collapses to icons when the viewport cannot afford it — on the
 * audit route that is a real threshold, because a graph canvas squeezed under
 * 900px is a graph nobody can read.
 */

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  Boxes,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { githubLoginUrl } from "../../features/session/api.ts";
import { useLogout, useSession } from "../../features/session/hooks.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { FOCUS_RING } from "../ui/focus.ts";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** what this surface is FOR — the shell's own answer to "why am I here" */
  hint: string;
}

/**
 * Ordered by how often someone working actually needs them, not by product
 * hierarchy. `/scan` is above `/dashboard` because it is the entry a visitor
 * with no App installation can use, and the dashboard is what they convert into.
 */
const NAV: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, hint: "What needs attention" },
  { to: "/scan", label: "Scan", icon: ScanLine, hint: "Audit a repository" },
  { to: "/packages", label: "Packages", icon: Boxes, hint: "Find a package audit" },
  { to: "/replays", label: "Replays", icon: Play, hint: "Watch an investigation" },
];

function isActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

const COLLAPSE_BELOW_PX = 1100;

export function AppShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [userSet, setUserSet] = useState(false);

  // The viewport decides until the viewer does. After that their choice stands —
  // a sidebar that re-expands on every resize is a sidebar that argues.
  useEffect(() => {
    if (userSet) return;
    const query = window.matchMedia(`(max-width: ${COLLAPSE_BELOW_PX}px)`);
    const apply = () => setCollapsed(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [userSet]);

  return (
    <div className="ng-root flex h-dvh min-h-0 overflow-hidden bg-canvas">
      <nav
        aria-label="Workspace"
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-surface md:flex",
          "transition-[width] duration-fast",
          collapsed ? "w-14" : "w-56",
        )}
      >
        <div className="flex h-[--ng-h-topbar] items-center gap-2 border-b border-border px-3">
          <Link
            to="/"
            aria-label="NpmGuard home"
            className={cn("flex shrink-0 items-center gap-2 rounded-sm", FOCUS_RING)}
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-text text-canvas">
              <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.8} />
            </span>
            {!collapsed ? (
              <span className="text-sm font-semibold tracking-tight text-text">
                npm<em className="font-semibold text-accent-text not-italic">guard</em>
              </span>
            ) : null}
          </Link>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {NAV.map((item) => {
            const active = isActive(location.pathname, item.to);
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? `${item.label} — ${item.hint}` : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs",
                    "transition-colors duration-fast",
                    active
                      ? "bg-accent-wash text-accent-text"
                      : "text-text-2 hover:bg-sunken hover:text-text",
                    FOCUS_RING,
                  )}
                >
                  <Icon aria-hidden="true" strokeWidth={1.5} className="size-icon shrink-0" />
                  {/* Kept in the DOM when collapsed: dropping the label would
                      make the rail announce as four unlabelled buttons. */}
                  <span className={cn(collapsed && "sr-only")}>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-pressed={collapsed}
            onClick={() => {
              setUserSet(true);
              setCollapsed((value) => !value);
            }}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="size-icon-sm" />
            ) : (
              <>
                <PanelLeftClose aria-hidden="true" className="size-icon-sm" />
                <span className="text-2xs">Collapse</span>
              </>
            )}
          </Button>
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-[--ng-h-topbar] shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
          {/* Mobile identity: the rail is hidden below md, so the wordmark has
              to live somewhere a phone can see it. */}
          <Link to="/" className={cn("flex items-center gap-2 md:hidden", FOCUS_RING)}>
            <span className="flex size-7 items-center justify-center rounded-md bg-text text-canvas">
              <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.8} />
            </span>
          </Link>
          <MobileNav pathname={location.pathname} />
          <div className="ml-auto flex items-center gap-2">
            <AuthChip />
          </div>
        </header>

        {/* The page owns the rest of the viewport. No centered column here — a
            page that wants one asks for it. */}
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

function MobileNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Workspace" className="flex items-center gap-0.5 overflow-x-auto md:hidden">
      {NAV.map((item) => {
        const active = isActive(pathname, item.to);
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap",
              active ? "bg-accent-wash text-accent-text" : "text-text-2",
              FOCUS_RING,
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** GitHub session chip. Renders nothing until the session read settles — a
 * failed session read is not actionable from a header, and the dashboard names
 * it where a person can do something about it. */
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
        <span className="flex size-6 items-center justify-center rounded-full bg-accent-wash text-2xs font-medium text-accent-text">
          {user.login.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="hidden text-xs text-text-2 sm:inline">{user.login}</span>
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
