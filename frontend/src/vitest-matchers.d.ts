import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

/**
 * Attach jest-dom's matchers to vitest's assertion type.
 *
 * `src/test-setup.ts` imports `@testing-library/jest-dom/vitest`, which
 * registers the matchers at RUNTIME and ships a type augmentation of its own —
 * but that augmentation targets `declare module "vitest" { interface Assertion }`,
 * and as of vitest 4 `vitest` only RE-EXPORTS `Assertion` from
 * `@vitest/expect`. Augmenting a re-export declares a fresh, unused interface
 * instead of widening the real one, so `expect(el).toHaveClass(…)` fails to
 * typecheck while passing at runtime — the worst possible split, and invisible
 * until something actually typechecks the test files. (It stayed invisible here
 * because `npm run typecheck` was `tsc -b --noEmit`, which cannot run at all
 * against a composite project reference — TS6310 — so the gate never completed.)
 *
 * `@vitest/expect`'s `Matchers<T>` is the sanctioned extension point; its own
 * source comments say the type parameter exists to be extended. Keep the
 * parameter named `T`: TypeScript requires an augmentation's type parameter
 * names to match the original declaration exactly.
 *
 * Delete this file only when jest-dom's own `./vitest` types augment
 * `@vitest/expect` directly (checked against jest-dom 7.0.0 — still targets
 * `vitest`).
 */
declare module "@vitest/expect" {
  interface Matchers<T = any> extends TestingLibraryMatchers<any, T> {}
}
