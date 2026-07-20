import type { z } from "zod";

/**
 * Read runtime config injected as `window.__CONFIG__` by the serving layer.
 * One build artifact runs in any environment — never read `import.meta.env`
 * in app code.
 */
export function loadConfig<S extends z.ZodType>(schema: S): z.output<S> {
  const raw = (globalThis as { __CONFIG__?: unknown }).__CONFIG__;
  if (raw === undefined) {
    throw new Error(
      "window.__CONFIG__ is missing — the serving layer must inject runtime config",
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`window.__CONFIG__ is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}
