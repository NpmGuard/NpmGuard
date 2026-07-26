/**
 * The public product site's frame.
 *
 * Spacious where the application is dense, and that contrast is the point rather
 * than an accident of two people building two things. A visitor here is deciding
 * whether the claims are credible; someone in the shell is working. The same
 * container cannot serve both, and trying makes the landing page feel like a
 * settings screen and the dashboard feel like a brochure.
 *
 * What is shared: the wordmark, the type scale, the tokens, the focus ring. What
 * is not: the sidebar, the workspace chrome, and the assumption that the page
 * fills the viewport.
 */

import { Link, useLocation } from "react-router";
import { ShieldCheck } from "lucide-react";
import { githubLoginUrl } from "../../features/session/api.ts";
import { useSession } from "../../features/session/hooks.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { FOCUS_RING } from "../ui/focus.ts";

const NAV = [
  { to: "/how-it-works", label: "How it works" },
  { to: "/benchmark", label: "Benchmark" },
  { to: "/cli", label: "CLI" },
];

export function PublicFrame({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const session = useSession();
  const signedIn = session.status === "ok" && session.data.user !== null;

  return (
    <div className="ng-root flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-border bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1160px] items-center gap-6 px-4 md:px-6 lg:px-8">
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

          <nav aria-label="Product" className="flex min-w-0 flex-1 items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                aria-current={location.pathname === item.to ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap text-text-2",
                  "transition-colors duration-fast hover:bg-sunken hover:text-text",
                  location.pathname === item.to && "text-text",
                  FOCUS_RING,
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            {signedIn ? (
              <Button asChild size="sm">
                <Link to="/dashboard">Open workspace</Link>
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <a href={githubLoginUrl()}>Sign in</a>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-[1160px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-2xs text-text-3 md:px-6 lg:px-8">
          <span>npmguard runs the package and reports what it did.</span>
          <Link to="/how-it-works" className={cn("hover:text-text", FOCUS_RING)}>
            Methodology
          </Link>
          <Link to="/cli" className={cn("hover:text-text", FOCUS_RING)}>
            CLI
          </Link>
          <Link to="/replays" className={cn("hover:text-text", FOCUS_RING)}>
            Replays
          </Link>
        </div>
      </footer>
    </div>
  );
}
