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
  const remotionPort = parsePort(Deno.env.get("REMOTION_PORT"), 4321);
  const remotionProxy = proxy(`http://localhost:${remotionPort}`);
  app.all(
    "/remotion/*",
    proxy(`http://localhost:${remotionPort}`, { stripPrefix: "/remotion" }),
  );
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

  // Serve the Remotion bundle so the remote render server can fetch it.
  // Request: /remotion-bundle/bundle.js → file: ./remotion/bundle/bundle.js
  app.get("/remotion-bundle/*", async (c) => {
    const subPath = c.req.path.replace(/^\/remotion-bundle\//, "");
    const filePath = join("remotion", "bundle", subPath);
    try {
      const file = await Deno.readFile(filePath);
      const ext = subPath.split(".").pop() ?? "";
      const mimeTypes: Record<string, string> = {
        html: "text/html",
        js: "application/javascript",
        css: "text/css",
        json: "application/json",
        png: "image/png",
        jpg: "image/jpeg",
        svg: "image/svg+xml",
        ico: "image/x-icon",
        wasm: "application/wasm",
        map: "application/json",
      };
      return c.body(file, 200, {
        "Content-Type": mimeTypes[ext] ?? "application/octet-stream",
      });
    } catch {
      return c.notFound();
    }
  });

  // Serve rendered video output files (streamed, with proper MIME types).
  // Request: /out/Main-123.mp4 → file: ./remotion/out/Main-123.mp4
  app.use(
    "/out/*",
    serveStatic({
      root: "./remotion/out",
      rewriteRequestPath: (path: string) => path.replace(/^\/out/, ""),
    }),
  );

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
