/**
 * The layout vocabulary every operational page shares.
 *
 * ── Why these pages are not a centered column ────────────────────────────────
 *
 * `PanelPage` centres content in a 1160px measure, which is right for a document
 * and wrong for a tool. Inside the application shell a page is given the rest of
 * the viewport and is expected to use it: a dependency table forty rows long
 * reading at 1160px on a 2560px display wastes half the screen and makes the
 * shell look like a frame around a brochure. The public site keeps the measure,
 * because there the reader is reading.
 *
 * The other half of that is scrolling. A workspace page scrolls its BODY, not
 * the document, so the page header and any toolbar stay put while a long table
 * moves under them — which is the behaviour that makes a table usable at all.
 *
 * ── Attention first, and what that means structurally ───────────────────────
 *
 * Every page here has one primary job, and the job is always some form of "show
 * me what needs me". So the vocabulary has an `AttentionRegion` (leads, always
 * rendered, states plainly when there is nothing) and a `QuietGroup` (a
 * disclosure for the rows that need nobody). Clean things are collapsed by
 * default, not deleted — a viewer must be able to check that the quiet ones were
 * looked at, and a count they can open is the difference between "nothing to do"
 * and "nothing was done".
 */

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn.ts";

/** The page plane: fills the shell, scrolls its own body. */
export function WorkspacePage({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-h-0 flex-1 flex-col", className)} {...props} />;
}

/**
 * The page's identity row. Sticky, because the toolbar under it usually filters
 * something long and a filter you have to scroll back to is a filter people stop
 * using.
 */
export function WorkspaceHeader({
  title,
  lede,
  meta,
  actions,
  children,
}: {
  title: string;
  /** One line on what this surface is for. Optional — most pages do not need it. */
  lede?: ReactNode;
  /** Counts or state, beside the title. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** A toolbar row under the title: search, filters. */
  children?: ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-border bg-surface px-4 pt-4 pb-3 md:px-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-text">{title}</h1>
        {meta ? <span className="font-mono text-2xs text-text-3 tabular-nums">{meta}</span> : null}
        {actions ? <div className="ms-auto flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {lede ? <p className="mt-1 max-w-2xl text-xs text-text-2">{lede}</p> : null}
      {children ? <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

/** The scrolling body. */
export function WorkspaceBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6", className)}
      {...props}
    />
  );
}

/** A titled region. `tone="attention"` marks the one that leads the page. */
export function WorkspaceSection({
  label,
  meta,
  action,
  tone = "normal",
  children,
  className,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  label: string;
  meta?: ReactNode;
  action?: ReactNode;
  tone?: "normal" | "attention";
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={cn("mb-8", className)} aria-labelledby={titleId} {...props}>
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id={titleId}
          className={cn(
            "font-mono text-2xs font-medium tracking-wide uppercase",
            tone === "attention" ? "text-danger-text" : "text-text-3",
          )}
        >
          {label}
        </h2>
        {meta ? <span className="text-2xs text-text-3 tabular-nums">{meta}</span> : null}
        {action ? <span className="ms-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The rows that need nobody, behind a count.
 *
 * Collapsed by default and never hidden: the count IS the reassurance, and it
 * has to be openable or it is just a claim. A page that deleted its clean rows
 * would be telling a viewer "nothing else matters" without letting them check.
 */
export function QuietGroup({
  label,
  count,
  children,
  defaultOpen = false,
}: {
  label: string;
  count: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-sunken"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-icon-sm shrink-0 text-text-3 transition-transform duration-fast",
            open && "rotate-90",
          )}
        />
        <span className="text-xs text-text-2">{label}</span>
        <span className="ms-auto font-mono text-2xs text-text-3 tabular-nums">{count}</span>
      </button>
      {open ? <div className="border-t border-border-faint">{children}</div> : null}
    </div>
  );
}

/**
 * What an attention region says when there is nothing in it.
 *
 * Achromatic and flat. Not green, and not congratulatory: "nothing needs you
 * right now" is a statement about this moment, and dressing it as a success
 * invites the reader to stop checking.
 */
export function NothingToDo({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-text-2">
      {children}
    </p>
  );
}
