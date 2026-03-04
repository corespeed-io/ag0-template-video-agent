import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/deno";
import { join } from "@std/path";
import { parsePort } from "@zypher/utils/env";
import { setupLogging } from "@ag0/logging";
import api from "./api/mod.ts";
import { proxy } from "./api/middlewares/proxy.ts";

async function main(): Promise<void> {
  await setupLogging();

  const app = new Hono()
    .use("*", cors())
    .route("/api", api)
    .get("/health", (c) => c.json({ status: "ok" }));

  // Proxy Remotion Studio through a single port so the iframe works in AG0/dev.
  // The main page loads at /remotion/ (prefix-stripped), but Remotion's HTML uses
  // absolute root paths (/bundle.js, /static-*, /api/*, /events, /stream) so we
  // also proxy those specific paths to Remotion Studio.
  const remotionPort = parsePort(Deno.env.get("REMOTION_PORT"), 3000);
  const remotionProxy = proxy(`http://localhost:${remotionPort}`);
  app.all(
    "/remotion/*",
    proxy(`http://localhost:${remotionPort}`, { stripPrefix: "/remotion" }),
  );
  // Remotion Studio uses hardcoded absolute root paths (no --base-path support).
  // When the iframe at /remotion/ loads, its JS requests these paths at the root.
  // Our app's /api/agent/* is matched first by .route("/api", api) above;
  // unmatched /api/* paths (Remotion's endpoints) fall through to this proxy.
  // Maintain this list when upgrading Remotion — check bundle.js for new paths.
  for (const p of [
    "/bundle.js",
    "/__webpack_hmr",
    "/events",
    "/stream",
    "/favicon.ico",
    "/beep.wav",
    "/source-map-helper.wasm",
  ]) app.all(p, remotionProxy);
  app.all("/static-:hash/*", remotionProxy);
  app.all("/outputs-:hash/*", remotionProxy);
  app.all("/api/*", remotionProxy);

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
  