# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: frontend/e2e/_shot.spec.ts >> shot pay
- Location: frontend/e2e/_shot.spec.ts:5:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/pay", waiting until "load"

```

# Test source

```ts
  1  | import { test } from "@playwright/test";
  2  | const OUT = process.env.SHOT_OUT!;
  3  | const PAGES = { landing: "/", cli: "/cli", pay: "/pay", registry: "/packages" };
  4  | for (const [name, path] of Object.entries(PAGES)) {
  5  |   test(`shot ${name}`, async ({ page }) => {
> 6  |     await page.goto(path);
     |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  7  |     await page.waitForTimeout(600);
  8  |     await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  9  |   });
  10 | }
  11 | 
```