/** Table — plain, real `<table>` semantics. Dep tables, bench rows, registry.
 *
 * Radix has no table primitive and there is nothing to hand-roll: a `<table>`
 * already gives row/column relationships, header association, and the row and
 * cell navigation that screen readers implement natively. A grid of divs throws
 * all of that away and then re-implements a fraction of it with `role="grid"`.
 * So the rule here is: **never replace these elements with divs**, whatever a
 * virtualization library's examples do.
 *
 * What this file adds on top of the elements:
 *
 *  - **`aria-sort`, correctly.** `TableHead sortable` renders `aria-sort="none"`;
 *    the *one* sorted column renders `ascending`/`descending`. Two columns
 *    claiming to be sorted is a lie a hand-written table tells constantly, and it
 *    makes the header row unusable for anyone relying on the announcement.
 *  - **Density as context, not as a prop on 340 rows.** `--h-row-dense` /
 *    `--h-row` / `--h-row-comfy` per §2.8, and dense relaxes to comfortable below
 *    `md` because a 32px row is not a touch target.
 *  - **Severity as a 3px left rule** (§2.8), never a row fill. Whole-row wash
 *    tinting is reserved for log and evidence panes, where rows are few and the
 *    tint is the point; on 340 dep rows it turns the table into wallpaper.
 *  - **A sticky header that actually sticks**, which needs the *cells* to be
 *    sticky, not the `<thead>` — `position: sticky` does not apply to
 *    `table-header-group` in every engine.
 *
 * Sorting/filtering/grouping state is the caller's. TanStack Table is what §3.2
 * names for that and it is not installed; nothing here presumes it, and nothing
 * here needs replacing when it lands. */

import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { type ComponentProps, createContext, useContext } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export type Density = "dense" | "regular" | "comfortable";

const ROW_HEIGHT: Record<Density, string> = {
  // Dense relaxes below `md`: §2.8 says dense rows go to `--h-row-comfy` on
  // narrow viewports, because a 32px row cannot hold a 44px tap target.
  dense: "h-row-dense max-md:h-row-comfy",
  regular: "h-row max-md:h-row-comfy",
  comfortable: "h-row-comfy",
};

const DensityContext = createContext<Density>("regular");

export type TableProps = ComponentProps<"table"> & {
  density?: Density;
  /** Required accessible name. A table with no caption or `aria-label` is
   * announced as "table" and nothing else, which on a page with three tables is
   * useless. Use `<TableCaption>` when the name should be visible. */
  label?: string;
};

export function Table({ className, density = "regular", label, ...props }: TableProps) {
  return (
    <DensityContext value={density}>
      <table
        aria-label={label}
        data-density={density}
        className={cn("w-full border-collapse text-left text-sm text-text", className)}
        {...props}
      />
    </DensityContext>
  );
}

/** Visible table name. Preferred over `label` when the surface has room —
 * a caption is information for everyone, an `aria-label` only for some. */
export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return (
    <caption className={cn("px-3 py-2 text-left text-xs text-text-3", className)} {...props} />
  );
}

export function TableHeader({
  className,
  sticky = false,
  ...props
}: ComponentProps<"thead"> & { sticky?: boolean }) {
  return (
    <thead
      data-sticky={sticky || undefined}
      // The sticky positioning lands on the `<th>`s (see file header). `bg-sunken`
      // is on the cells too, or rows scroll visibly underneath the header.
      className={cn(sticky && "[&_th]:sticky [&_th]:top-0 [&_th]:z-10", className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn(className)} {...props} />;
}

export type TableRowProps = ComponentProps<"tr"> & {
  /** 3px left rule. No `"safe"` arm — SAFE is the quietest state in the system
   * (§0 rule 1) and 313 green-ruled rows would drown the three that matter. */
  severity?: "danger" | "error";
  /** Whole-row wash. **Only** for log and evidence panes (§2.8). Do not set this
   * on a dep table; that is what `severity` is for. */
  tinted?: "danger" | "error";
};

const ROW_TINT: Record<"danger" | "error", string> = {
  danger: "bg-danger-wash",
  error: "bg-error-wash",
};

const ROW_RULE: Record<"danger" | "error", string> = {
  danger: "border-l-[length:var(--ng-border-rule)] border-l-danger",
  error: "border-l-[length:var(--ng-border-rule)] border-l-error",
};

export function TableRow({ className, severity, tinted, ...props }: TableRowProps) {
  const density = useContext(DensityContext);
  return (
    <tr
      data-severity={severity}
      className={cn(
        "border-b border-border-faint",
        ROW_HEIGHT[density],
        // A left rule needs a matching transparent border on unruled rows or the
        // ruled ones shift 3px right and the whole column misaligns.
        severity ? ROW_RULE[severity] : "border-l-[length:var(--ng-border-rule)] border-l-transparent",
        tinted && ROW_TINT[tinted],
        "transition-colors duration-fast hover:bg-sunken",
        className,
      )}
      {...props}
    />
  );
}

export type SortDirection = "ascending" | "descending";

export type TableHeadProps = Omit<ComponentProps<"th">, "aria-sort"> & {
  /** Marks the column as sortable. Renders `aria-sort="none"` when unsorted. */
  sortable?: boolean;
  /** Set on the single sorted column only. */
  sortDirection?: SortDirection | null;
  onSort?: () => void;
};

export function TableHead({
  className,
  children,
  sortable = false,
  sortDirection = null,
  onSort,
  scope = "col",
  ...props
}: TableHeadProps) {
  const Icon =
    sortDirection === "ascending"
      ? ChevronUp
      : sortDirection === "descending"
        ? ChevronDown
        : ChevronsUpDown;
  return (
    <th
      scope={scope}
      // `aria-sort` belongs on the header cell, and only "none" when the column is
      // sortable — an unsortable column must not claim to be unsorted.
      aria-sort={sortable ? (sortDirection ?? "none") : undefined}
      className={cn(
        "border-b border-border bg-sunken px-3 py-2",
        "text-xs font-medium tracking-wide text-text-2 uppercase",
        className,
      )}
      {...props}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={cn("inline-flex items-center gap-1 rounded-xs hover:text-text", FOCUS_RING)}
        >
          {children}
          <Icon
            aria-hidden="true"
            className={cn("size-3", sortDirection ? "text-accent" : "text-text-3")}
          />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 align-middle", className)} {...props} />;
}

/** Row-number gutter cell (the Clay pattern from §3.2). `aria-hidden` because the
 * index is a visual aid — a screen reader already announces "row 4 of 340", and
 * hearing "4" as the first cell's content on every row is noise. */
export function TableRowNumber({ className, ...props }: ComponentProps<"td">) {
  return (
    <td
      aria-hidden="true"
      className={cn(
        "w-8 border-r border-border-faint px-1 text-right",
        "font-mono text-2xs tabular-nums text-text-3",
        className,
      )}
      {...props}
    />
  );
}

/** Group header spanning the table, carrying a count and a rollup — the Airtable
 * pattern from §3.2 and the shape §4.2's dep table needs.
 *
 * `note` is where the group's *prose* label goes: "COULD NOT CONCLUDE · 12 — not
 * safe, not dangerous". §4.2 makes that the most valuable copy on the screen,
 * because it teaches the two-axis verdict model in situ every time someone looks
 * at the table. */
export function TableGroupRow({
  className,
  colSpan,
  children,
  note,
  ...props
}: ComponentProps<"tr"> & { colSpan: number; note?: string }) {
  return (
    <tr className={cn("border-b border-border", className)} {...props}>
      <th
        scope="colgroup"
        colSpan={colSpan}
        className="bg-sunken px-3 py-1.5 text-left text-xs font-medium text-text"
      >
        <span className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">{children}</span>
          {note ? <span className="font-normal text-text-3">{note}</span> : null}
        </span>
      </th>
    </tr>
  );
}
