import { Hono } from "hono";

import { getAvailableDemos, startReplay } from "../demo.js";

export const demoRoutes = new Hono();

demoRoutes.get("/demo/packages", (c) => c.json({ packages: getAvailableDemos() }));

demoRoutes.post("/demo/start", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { packageName } = body as { packageName?: string };
  if (!packageName) {
    return c.json({ error: "packageName is required" }, 400);
  }

  try {
    const result = startReplay(packageName);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 404);
  }
});
