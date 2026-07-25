/** Vitest global setup.
 *
 * The jest-dom wiring is deliberately two statements, because the package's own
 * `/vitest` entry point does not work under vitest 4:
 *
 *   - The side-effect import is kept for its **types**. `types/vitest.d.ts`
 *     augments vitest's `Assertion` interface with `toBeInTheDocument`,
 *     `toHaveAccessibleName` and the rest; without it those matchers would exist
 *     at runtime but not to `tsc`.
 *   - The `expect.extend` is what actually **registers** them. `/vitest`
 *     resolves to jest-dom's CJS build, which does its own
 *     `require("vitest").expect.extend(...)` — and under vitest 4 that CJS
 *     interop copy is a *different* `expect` object than the ESM one test files
 *     import. The matchers land on an instance nobody asserts against, and every
 *     `expect(el).toBeInTheDocument()` fails with "Invalid Chai property".
 *
 * This was invisible until the first component test arrived: the earlier suites
 * were all pure functions and never used a DOM matcher, so the one-line setup
 * looked correct while being a no-op. Do not "simplify" it back — verify with a
 * real `toBeInTheDocument()` assertion before changing anything here. */

import "@testing-library/jest-dom/vitest";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

expect.extend(jestDomMatchers);

/** Unmount rendered trees between tests.
 *
 * React Testing Library registers this itself — but only when it can find a
 * global `afterEach`, and this project runs vitest without `globals: true`. So it
 * silently does not, every rendered tree stays in `document.body`, and the second
 * test in a file sees the first test's DOM. That surfaces as "Found multiple
 * elements with the role …", which reads like a component bug and is not one. */
afterEach(cleanup);
