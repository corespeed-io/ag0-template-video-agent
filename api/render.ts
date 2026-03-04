import { Hono } from "hono";
import { join } from "@std/path";

const CODEC_EXT: Record<string, string> = {
  h264: "mp4",
  h265: "mp4",
  vp8: "webm",
  vp9: "webm",
  mp3: "mp3",
  aac: "aac",
  wav: "wav",
  prores: "mov",
  gif: "gif",
};

function getEnvOrThrow(name: string, hint: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

/** Rewrite localhost URLs to the actual render server host. */
function fixLocalhostUrl(url: string, renderServerUrl: string): string {
  try {
    const parsed = new URL(url);
    const server = new URL(renderServerUrl);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = server.hostname;
      parsed.port = server.port;
      return parsed.toString();
    }
  } catch {
    // ignore parse errors
  }
  return url;
}

const render = new Hono();

// POST /api/render -- start a render job
render.post("/", async (c) => {
  const renderServerUrl = getEnvOrThrow(
    "RENDER_SERVER_URL",
    "Configure it in .env or ag0.jsonc.",
  );
  const remotionSiteUrl = getEnvOrThrow(
    "REMOTION_SITE_URL",
    "Set it to the public URL of /remotion-bundle/.",
  );

  const body = await c.req.json();
  const startBody: Record<string, unknown> = {
    serveUrl: remotionSiteUrl,
    compositionId: body.compositionId,
  };
  if (body.inputProps) startBody.inputProps = body.inputProps;
  if (body.codec) startBody.codec = body.codec;
  if (body.width) startBody.width = body.width;
  if (body.height) startBody.height = body.height;

  const res = await fetch(`${renderServerUrl}/renders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(startBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    return c.json(
      { error: `Render server returned ${res.status}: ${errText}` },
      502,
    );
  }

  const data = (await res.json()) as { jobId: string };
  return c.json({ jobId: data.jobId });
});

// GET /api/render/:jobId -- poll render status, download on completion
render.get("/:jobId", async (c) => {
  const renderServerUrl = getEnvOrThrow(
    "RENDER_SERVER_URL",
    "Configure it in .env or ag0.jsonc.",
  );
  const jobId = c.req.param("jobId");

  const pollRes = await fetch(`${renderServerUrl}/renders/${jobId}`);
  if (!pollRes.ok) {
    const errText = await pollRes.text();
    return c.json(
      { error: `Poll failed: ${pollRes.status} ${errText}` },
      502,
    );
  }

  const pollData = (await pollRes.json()) as {
    status: string;
    outputUrl?: string;
    error?: string;
    codec?: string;
    compositionId?: string;
  };

  if (pollData.status === "failed") {
    return c.json({
      status: "failed",
      error: pollData.error ?? "Unknown render error",
    });
  }

  if (pollData.status !== "completed" || !pollData.outputUrl) {
    return c.json({ status: pollData.status });
  }

  // Download the rendered file from the render server
  let downloadUrl = pollData.outputUrl.startsWith("http")
    ? pollData.outputUrl
    : new URL(pollData.outputUrl, renderServerUrl).toString();
  downloadUrl = fixLocalhostUrl(downloadUrl, renderServerUrl);

  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    return c.json({ error: `Download failed: ${downloadRes.status}` }, 502);
  }

  const contentType = downloadRes.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return c.json(
      {
        error: `Download returned HTML instead of video. URL: ${downloadUrl}`,
      },
      502,
    );
  }

  const ext = CODEC_EXT[pollData.codec ?? "h264"] ?? "mp4";
  const compositionId = pollData.compositionId ?? "render";
  const fileName = `${compositionId}-${Date.now()}.${ext}`;
  const outDir = join("remotion", "out");
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeFile(
    join(outDir, fileName),
    new Uint8Array(await downloadRes.arrayBuffer()),
  );

  return c.json({ status: "completed", downloadUrl: `/out/${fileName}` });
});

export default render;
