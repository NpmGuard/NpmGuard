/** Separator — Radix `Separator`.
 *
 * Thin, and worth vendoring for exactly one reason: `decorative`. A hairline that
 * merely spaces things visually must be `aria-hidden`; a hairline that marks a
 * real boundary between groups must be `role="separator"` with an orientation.
 * Getting that backwards means a screen-reader user hears "separator" fourteen
 * times on a card, or hears nothing where the grouping is the information.
 *
 * `decorative` defaults to true because the overwhelming majority of hairlines in
 * this design are visual rhythm — Direction A uses rules instead of boxes, so
 * most of them mean nothing semantically. */

import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  );
}
