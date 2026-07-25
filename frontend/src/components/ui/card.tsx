/** Card — plain. Repo cards, metric cards, replay gallery items.
 *
 * Radix has no card primitive and does not need one; a card is a box.
 *
 * `severity` is the only non-obvious part. It renders the 3px left rule from
 * §2.8, and it is a *separate axis* from `variant` on purpose: an interactive
 * card can also be a dangerous one, and modelling that as five variants instead
 * of two axes is how variant lists become combinatorial.
 *
 * `severity` accepts `"danger" | "error"` and nothing else — deliberately no
 * `"safe"`. SAFE is the quietest state in the system (§0 rule 1); a green rule on
 * a card is a small green banner, and green banners are how a security tool
 * oversells a clean result. The absence of a rule *is* the SAFE treatment. */

import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export type CardSeverity = "danger" | "error";

const SEVERITY: Record<CardSeverity, string> = {
  danger: "border-l-[length:var(--ng-border-rule)] border-l-danger",
  error: "border-l-[length:var(--ng-border-rule)] border-l-error",
};

export type CardProps = ComponentProps<"div"> & {
  /** `interactive` adds the hover/focus affordance for a card that is a link.
   * It does not make the card a link — wrap it, or put a stretched anchor
   * inside. A `<div role="link">` is worse than either. */
  variant?: "default" | "interactive";
  severity?: CardSeverity;
};

export function Card({ className, variant = "default", severity, ...props }: CardProps) {
  return (
    <div
      data-severity={severity}
      className={cn(
        "rounded-lg border border-border bg-surface text-text shadow-card",
        variant === "interactive" &&
          cn(
            "transition-colors duration-fast hover:border-border-strong hover:bg-sunken",
            // `focus-within`, not `focus`: the focusable thing is the anchor
            // inside, and the ring belongs on the card the user perceives.
            // Composed with the card's own elevation — a bare
            // `[box-shadow:var(--ng-focus-ring)]` replaces `shadow-card`, so a
            // focused card would visibly flatten.
            "focus-within:[box-shadow:var(--ng-focus-ring),var(--ng-shadow-card)]",
          ),
        severity && SEVERITY[severity],
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn("flex items-start justify-between gap-3 border-b border-border-faint p-4", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-xl font-semibold text-text", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-text-2", className)} {...props} />;
}

/** 16px inside a card, per §2.8's section rhythm. */
export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn("flex items-center gap-2 border-t border-border-faint px-4 py-3", className)}
      {...props}
    />
  );
}

/** Focus/click affordance for an `interactive` card: covers the card without
 * nesting the whole card inside an anchor (which would swallow any button in the
 * footer). The card must be `relative` — `Card` already is not, so callers add
 * `className="relative"`; kept explicit because a stray `relative` on a card
 * that has no stretched link is a layout landmine. */
export function CardLinkOverlay({ className, ...props }: ComponentProps<"a">) {
  return <a className={cn("absolute inset-0 rounded-lg", FOCUS_RING, className)} {...props} />;
}
