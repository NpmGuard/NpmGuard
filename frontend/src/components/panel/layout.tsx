/** The three layout pieces the two panel pages share, so they cannot drift.
 *
 * `PanelPage` is also where the migration marker lives. `.ng-root` is the opt-in
 * class described at the bottom of `base.css`: it carries v3 typography, the v3
 * focus ring and the v3 scrollbars for its own subtree, beating the legacy `body`
 * and `:focus-visible` rules while the legacy substrate still exists for the
 * pages that have not been recomposed. It is temporary — when the legacy block in
 * `base.css` dies, tier 1 makes it redundant and this class can go. Wearing it in
 * exactly one place is what makes that a one-line removal. */

import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/** The page plane. §2.8's horizontal gutter ladder steps 16 → 24 → 32 → 48 across
 * 375 / 768 / 1024 / 1440; the max width is the legacy 1160px, which is still the
 * right measure for a dense two-column dashboard. */
export function PanelPage({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "ng-root mx-auto w-full max-w-[1160px]",
        "px-4 pt-8 pb-16 md:px-6 lg:px-8 wide:px-12",
        className,
      )}
      {...props}
    />
  );
}

/** The mono uppercase micro-label — the metadata voice, and the one place §2.7's
 * "mono = a machine-authored fact" rule bends: a section label is interface
 * language, but the legacy design used mono here to mark *chrome* rather than
 * content and dropping it would flatten the hierarchy the pages depend on.
 *
 * DECISION the brief left open: it specifies no colour for this label. Default is
 * `text-3`, the muted neutral — NOT accent, which the legacy `.eyebrow` used. A
 * blue label above every section spends the system's one interactive hue on
 * decoration, and §2.2 confines accent to things that are interactive or moving.
 * `tone="danger"` exists for the one label that is genuinely about a finding (the
 * review queue), where the colour is carrying meaning rather than style. */
export type LabelTone = "muted" | "danger";

/** The classes, so `PanelSection` can put them on a real `<h2>` without this
 * component becoming polymorphic. A `as`-prop version typechecked only with a
 * cast — `onClick` and `ref` are invariant in the element type, so one component
 * cannot honestly serve `span` and `h2` — and a cast in a layout helper to save
 * one export is a bad trade. */
export function sectionLabelClass(tone: LabelTone = "muted", className?: string): string {
  return cn(
    "font-mono text-2xs font-medium tracking-wide uppercase",
    tone === "danger" ? "text-danger-text" : "text-text-3",
    className,
  );
}

export function SectionLabel({
  className,
  tone = "muted",
  ...props
}: ComponentProps<"span"> & { tone?: LabelTone }) {
  return <span className={sectionLabelClass(tone, className)} {...props} />;
}

/** A titled page section. §2.8's rhythm: 48px between page sections in the app,
 * 16 within the section's own header.
 *
 * `label` is a real heading, not a styled span. The pages previously rendered
 * `.section-title` as a `<div>` of spans, so the dashboard had one `<h1>` and then
 * no headings at all — which makes a screen reader's heading list useless for
 * navigating exactly the surface that has the most sections. */
export function PanelSection({
  label,
  tone,
  meta,
  action,
  children,
  className,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  label: string;
  tone?: LabelTone;
  /** A count or a one-line fact about the section, beside the label. */
  meta?: ReactNode;
  /** At most one control, pushed to the end of the header row. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    // `aria-labelledby` rather than `aria-label`: the accessible name is the
    // visible heading node, so the two cannot drift apart the way a hand-passed
    // string does.
    <section className={cn("mt-12", className)} aria-labelledby={titleId} {...props}>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h2 id={titleId} className={sectionLabelClass(tone)}>
          {label}
        </h2>
        {meta ? <span className="text-2xs text-text-3">{meta}</span> : null}
        {action ? <span className="ms-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}
