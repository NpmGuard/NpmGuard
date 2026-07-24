import { afterEach, expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";

// Extend vitest's `expect` explicitly with the jest-dom matchers. The
// `@testing-library/jest-dom/vitest` convenience entry did not extend the
// `expect` these tests import (a jest-dom 6 / vitest 4 resolution quirk), so
// wire the matchers directly against the imported singleton.
expect.extend(matchers);

// Unmount React trees between tests so a component-integration test shares no
// DOM with the next (a TESTING.md determinism rule: tests share no mutable
// state). Auto-cleanup only self-registers under globals:true, so pin it here.
afterEach(() => cleanup());
