// Import the /vitest entry for its TYPE augmentation (it `declare module`s the
// jest-dom matchers onto vitest's Assertion). Its runtime `expect.extend` does
// not reach the `expect` these tests import under vitest 4 / jest-dom 6, so we
// also extend explicitly below — the two are complementary (types vs runtime).
import "@testing-library/jest-dom/vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

expect.extend(matchers);

// Unmount React trees between tests so a component-integration test shares no
// DOM with the next (a TESTING.md determinism rule: tests share no mutable
// state). Auto-cleanup only self-registers under globals:true, so pin it here.
afterEach(() => cleanup());
