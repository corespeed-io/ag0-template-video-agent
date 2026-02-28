import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { join } from "@std/path";
import { parsePort } from "@zypher/utils/env";
import { setupLogging } from "@ag0/logging";
import api from "./api/mod.ts";
import { proxy } from "./api/middlewares/proxy.ts";

async function main(): Promise<void> {
  await setupLogging();

  const app = new Hono()
    .route("/api", api)
    .get("/health", (c) => c.json({ status: "ok" }));

  // Proxy Remotion Studio through a single port so the iframe works in AG0/dev.
  // Only enabled when REMOTION_PORT is set — skipped in production (e.g. Railway).
  const remotionPort = Deno.env.get("REMOTION_PORT");
  if (remotionPort) {
    app.all(
      "/remotion{/*}",
      proxy(`http://localhost:${remotionPort}`, { stripPrefix: "/remotion" }),
    );
  }

  const vitePort = Deno.env.get("VITE_PORT");
  if (vitePort) {
    app.all("*", proxy(`http://localhost:${vitePort}`));
  } else {
    // Serve built frontend static files, falling back to index.html for SPA routing
    const webRoot = Deno.env.get("WEB_ROOT") ?? "./ui/dist";
    app.use(serveStatic({ root: webRoot }));
    app.use(serveStatic({ path: join(webRoot, "index.html") }));
  }

  const port = parsePort(Deno.env.get("PORT"), 8080);
  Deno.serve({ handler: app.fetch, port });
}

if (import.meta.main) {
  main();
}
