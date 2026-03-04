import { createTool } from "@zypher/agent/tools";
import { z } from "zod";
import { join } from "@std/path";

const POLL_INTERVAL_MS = 2000;

const RenderVideoTool = createTool({
  name: "render_video",
  description:
    "Render a Remotion composition to video using the remote render server. " +
    "Requires the Remotion bundle to be built first (cd remotion && pnpm run bundle).",
  schema: z.object({
    compositionId: z.string().describe(
      "The Remotion composition ID to render (e.g. 'Main')",
    ),
    inputProps: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Input props to pass to the composition"),
    codec: z
      .enum(["h264", "h265", "vp8", "vp9", "mp3", "aac", "wav", "prores", "gif"])
      .optional()
      .describe("Video codec (default: h264)"),
    width: z.number().optional().describe("Override composition width"),
    height: z.number().optional().describe("Override composition height"),
  }),
  outputSchema: z.object({
    status: z
      .enum(["success", "failed"])
      .describe("Whether the render succeeded"),
    filePath: z
      .string()
      .optional()
      .describe("Local file path of the rendered video"),
    downloadUrl: z
      .string()
      .optional()
      .describe("URL to download the rendered video from the agent server"),
    renderServerUrl: z
      .string()
      .optional()
      .describe("The render server that handled the request"),
    error: z.string().optional().describe("Error message if render failed"),
  }),
  execute: async ({ compositionId, inputProps, codec, width, height }) => {
    const renderServerUrl = Deno.env.get("RENDER_SERVER_URL");
    if (!renderServerUrl) {
      throw new Error(
        "RENDER_SERVER_URL environment variable is not set. " +
          "Configure it in .env or ag0.jsonc.",
      );
    }

    const remotionSiteUrl = Deno.env.get("REMOTION_SITE_URL");
    if (!remotionSiteUrl) {
      throw new Error(
        "REMOTION_SITE_URL environment variable is not set. " +
          "Set it to the public URL of this server's /remotion-bundle/ path " +
          "(e.g. http://deckspeed.video-agent.orb.local:8080/remotion-bundle/).",
      );
    }

    // 1. Start the render job
    const startBody: Record<string, unknown> = {
      serveUrl: remotionSiteUrl,
      compositionId,
    };
    if (inputProps) startBody.inputProps = inputProps;
    if (codec) startBody.codec = codec;
    if (width) startBody.width = width;
    if (height) startBody.height = height;

    const startRes = await fetch(`${renderServerUrl}/renders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(startBody),
    });

    if (!startRes.ok) {
      const errText = await startRes.text();
      throw new Error(
        `Render server returned ${startRes.status}: ${errText}`,
      );
    }

    const startData = await startRes.json() as { jobId: string };
    const jobId = startData.jobId;

    // 2. Poll until completed or failed
    let status = "pending";
    let outputUrl = "";

    while (status !== "completed" && status !== "failed") {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const pollRes = await fetch(`${renderServerUrl}/renders/${jobId}`);
      if (!pollRes.ok) {
        const errText = await pollRes.text();
        throw new Error(
          `Poll failed with ${pollRes.status}: ${errText}`,
        );
      }

      const pollData = await pollRes.json() as {
        status: string;
        outputUrl?: string;
        error?: string;
      };
      status = pollData.status;

      if (status === "failed") {
        const errMsg = pollData.error ?? "Unknown render error";
        return {
          content: [{ type: "text" as const, text: `Render failed: ${errMsg}` }],
          structuredContent: {
            status: "failed" as const,
            error: errMsg,
            renderServerUrl,
          },
        };
      }

      if (status === "completed" && pollData.outputUrl) {
        outputUrl = pollData.outputUrl;
      }
    }

    // 3. Download the rendered file
    const codecExt: Record<string, string> = {
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
    const ext = codecExt[codec ?? "h264"] ?? "mp4";
    const timestamp = Date.now();
    const fileName = `${compositionId}-${timestamp}.${ext}`;
    const outDir = join("remotion", "out");
    await Deno.mkdir(outDir, { recursive: true });
    const filePath = join(outDir, fileName);

    // Resolve relative outputUrl against the render server.
    // The render server may return a localhost URL — replace the host with the
    // configured render server host so we can actually reach the file.
    let downloadUrl = outputUrl.startsWith("http")
      ? outputUrl
      : new URL(outputUrl, renderServerUrl).toString();

    // If the outputUrl host is localhost/127.0.0.1, substitute the render server's host/port
    try {
      const outputParsed = new URL(downloadUrl);
      const serverParsed = new URL(renderServerUrl);
      if (outputParsed.hostname === "localhost" || outputParsed.hostname === "127.0.0.1") {
        outputParsed.hostname = serverParsed.hostname;
        outputParsed.port = serverParsed.port;
        downloadUrl = outputParsed.toString();
      }
    } catch {
      // ignore URL parse errors; proceed with original
    }

    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) {
      throw new Error(
        `Failed to download render output: ${downloadRes.status}`,
      );
    }

    // Validate we got a real media file, not an HTML error page
    const contentType = downloadRes.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      throw new Error(
        `Download returned HTML instead of video. URL: ${downloadUrl}`,
      );
    }

    const fileData = new Uint8Array(await downloadRes.arrayBuffer());
    await Deno.writeFile(filePath, fileData);

    const serveUrl = `/out/${fileName}`;

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Video rendered successfully!\n` +
            `- Composition: ${compositionId}\n` +
            `- File: ${filePath}\n` +
            `- Download: ${serveUrl}`,
        },
      ],
      structuredContent: {
        status: "success" as const,
        filePath,
        downloadUrl: serveUrl,
        renderServerUrl,
      },
    };
  },
});

export { RenderVideoTool };
