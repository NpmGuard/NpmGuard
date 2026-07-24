// jest-dom matcher types for vitest 4.
//
// `@testing-library/jest-dom/vitest` augments `declare module "vitest"`, but
// vitest 4 declares the `Assertion` interface in `@vitest/expect` (vitest just
// re-exports it), so that augmentation never merges with the interface the
// matchers are actually checked against. Augment the real module here.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "@vitest/expect" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, void> {}
}
