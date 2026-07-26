/**
 * The evidence frame — minimal chrome around `/audit/:id` and `/package/:name`.
 *
 * These two URLs are the ones people SHARE. A completed audit is public,
 * linkable and inspectable, and never behind a paywall: a security claim nobody
 * can check is marketing. So the frame gives an anonymous visitor the workspace
 * language (full viewport, dense, no marketing column) with none of the
 * account-only navigation — a sidebar full of surfaces they cannot open is a
 * wall, and the page they came for is the evidence.
 *
 * A signed-in viewer following the same link gets the same page inside the
 * application shell, because for them it IS one of their surfaces.
 */

import { Link } from "react-router";
import { ShieldCheck } from "lucide-react";
import { useSession } from "../../features/session/hooks.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { FOCUS_RING } from "../ui/focus.ts";
import { AppShell } from "./AppShell.tsx";

export function EvidenceFrame({ children }: { children: React.ReactNode }) {
  const session = useSession();

  // Until the session read settles, render the anonymous frame. It is the
  // smaller claim: showing minimal chrome to someone signed in is a missing
  // sidebar for a moment, where showing account navigation to an anonymous
  // visitor is a set of links that 401.
  if (session.status === "ok" && session.data.user) {
    return <AppShell>{children}</AppShell>;
  }

  return (
    <div className="ng-root flex h-dvh min-h-0 flex-col overflow-hidden bg-canvas">
      <header className="flex h-[--ng-h-topbar] shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
        <Link
          to="/"
          aria-label="NpmGuard home"
          className={cn("flex shrink-0 items-center gap-2 rounded-sm", FOCUS_RING)}
        >
          <span className="flex size-7 items-center justify-center rounded-md bg-text text-canvas">
            <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.8} />
          </span>
          <span className="text-sm font-semibold tracking-tight text-text">
            npm<em className="font-semibold text-accent-text not-italic">guard</em>
          </span>
        </Link>
        <span className="hidden text-2xs text-text-3 sm:inline">
          Public evidence — anyone with this link can inspect it.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/how-it-works">How this works</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/">Audit a package</Link>
          </Button>
        </div>
      </header>
      {/* `overflow-hidden`, not `auto`: the evidence workspace owns its own
          scroll regions, and a scrolling main would let its graph pane resolve
          to content height instead of to the viewport. A page that wants to
          scroll (the package report) scrolls inside itself. */}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
