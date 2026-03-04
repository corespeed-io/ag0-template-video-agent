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
  const remotionPort = parsePort(Deno.env.get("REMOTION_PORT"), 6000);
  const remotionProxy = proxy(`http://localhost:${remotionPort}`);
  const remotionStripProxy = proxy(`http://localhost:${remotionPort}`, {
    stripPrefix: "/remotion",
  });
  app.all("/remotion/*", async (c, next) => {
    // For the initial HTML page load, fetch from Remotion and inject a script
    // that rewrites window.location.pathname to "/" so Remotion doesn't try to
    // resolve the "/remotion" prefix as a composition ID.
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      try {
        const res = await fetch(`http://localhost:${remotionPort}/`);
        let html = await res.text();
        html = html.replace(
          "<head>",
          `<head><script>history.replaceState(null,"","/")</script>`,
        );
        return c.html(html);
      } catch {
        return c.json({ error: "Remotion Studio unavailable" }, 502);
      }
    }
    return remotionStripProxy(c, next);
  });
  // Remotion Studio uses hardcoded absolute root paths (no --base-path support). Proxy those specific paths to ensure the studio works correctly when embedded in AG0/dev.
  for (
    const p of [
      "/bundle.js",
      "/__webpack_hmr",
      "/events",
      "/stream",
      "/favicon.ico",
      "/beep.wav",
      "/source-map-helper.wasm",
    ]
  ) app.all(p, remotionProxy);
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
