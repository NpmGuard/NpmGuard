/** LaunchInput — the one-shot audit launcher (§3.3).
 *
 * `/` uses it to start an audit from a package name; `/scan` will use it to
 * paste a repo URL. Built here rather than inline on the landing page because
 * those are the same control with different copy, and the second copy is where
 * the mobile-zoom rule and the narrow-viewport stacking get forgotten.
 *
 * Two things are not cosmetic:
 *
 *  - **Mono input, 16px on mobile.** The value is a machine-authored string
 *    (§2.7), and any input under 16px makes iOS Safari zoom the viewport on
 *    focus — on `/scan` that is the user's first interaction with the product
 *    visibly breaking the layout. `Input` carries both.
 *  - **It stacks below `sm`.** A 2-up row of input + button at 375px leaves the
 *    button ~90px wide with a truncated label. Stacking is not a nicety at that
 *    width, it is the difference between a usable and an unusable primary action.
 *
 * The submit is a real `<form>` submit, so Enter works without a keydown
 * handler, and the button carries `type="submit"` rather than an onClick — a
 * launcher that only responds to a click is broken for anyone who types the
 * package name and presses Return, which is most people. */

import type { ReactNode } from "react";
import { Input } from "./input.tsx";
import { Button } from "./button.tsx";
import { cn } from "../../lib/cn.ts";

export type LaunchInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  /** Accessible name for the field. Required — see `SearchInput`. */
  label: string;
  placeholder?: string;
  /** Submit button label. `busyLabel` replaces it while `busy` is set. */
  action: string;
  busyLabel?: string;
  busy?: boolean;
  /** One line beneath the control: what the input accepts. */
  hint?: ReactNode;
  name?: string;
  className?: string;
};

export function LaunchInput({
  value,
  onValueChange,
  onSubmit,
  label,
  placeholder,
  action,
  busyLabel,
  busy = false,
  hint,
  name,
  className,
}: LaunchInputProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <form
        className="flex max-w-[520px] flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Input
          mono
          name={name}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          aria-label={label}
          placeholder={placeholder}
          // A package name is neither a word nor a sentence; every one of these
          // corrections actively damages it on mobile keyboards.
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1"
        />
        <Button type="submit" disabled={!value.trim() || busy} className="px-5 max-sm:w-full">
          {busy ? (busyLabel ?? action) : action}
        </Button>
      </form>
      {hint ? <p className="max-w-[520px] text-2xs text-text-3">{hint}</p> : null}
    </div>
  );
}
