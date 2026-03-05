/**
 * Custom Remotion Studio startup script.
 *
 * Replaces `remotion studio` CLI so we can inject custom queueMethods that
 * forward render jobs to a remote render server instead of rendering locally
 * (which causes OOM in resource-constrained environments).
 */

import path from "path";
import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { createRequire } from "module";
import { StudioServerInternals } from "@remotion/studio-server";
import type { RenderJob, RenderJobWithCleanup } from "@remotion/studio-shared";

const require = createRequire(import.meta.url);

// Load .env from project root (Node.js doesn't auto-load like Deno)
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const RENDER_SERVER_URL = process.env.RENDER_SERVER_URL ?? "";
const DESIRED_PORT = parseInt(process.env.REMOTION_PORT || "4321", 10);
const POLL_INTERVAL_MS = 2000;

/** Detect the first non-internal IPv4 address. */
function getNetworkIP(): string {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Derive the serve URL for the remote render server.
 * Uses the Hono server's /remotion-bundle/ path (the bundled Remotion project).
 */
function getServeUrl(): string {
  const honoPort = process.env.PORT || "8080";
  return `http://${getNetworkIP()}:${honoPort}/remotion-bundle/`;
}

// ---------------------------------------------------------------------------
// Job Queue
// ---------------------------------------------------------------------------

const jobQueue: RenderJobWithCleanup[] = [];

/** Strip cleanup arrays before sending to clients. */
function getRenderQueue(): RenderJob[] {
  return jobQueue.map(({ cleanup: _cleanup, ...rest }) => rest);
}

/** Broadcast the current queue to all connected Studio clients. */
async function notifyClientsOfJobUpdate(): Promise<void> {
  const listener = await StudioServerInternals.waitForLiveEventsListener();
  listener.sendEventToClient({
    type: "render-queue-updated",
    queue: getRenderQueue(),
  });
}

/** Update a job in-place and notify clients. */
function updateJob(
  jobId: string,
  updater: (job: RenderJobWithCleanup) => void,
): void {
  const job = jobQueue.find((j) => j.id === jobId);
  if (job) {
    updater(job);
    notifyClientsOfJobUpdate();
  }
}

// ---------------------------------------------------------------------------
// Remote Render
// ---------------------------------------------------------------------------

let processing = false;

async function processJobIfPossible(): Promise<void> {
  if (processing) return;

  const job = jobQueue.find(
    (j) => j.status === "idle",
  ) as RenderJobWithCleanup | undefined;
  if (!job) return;

  processing = true;

  // Mark running with initial progress
  Object.assign(job, {
    status: "running",
    progress: {
      message: "Starting remote render...",
      value: 0,
      rendering: null,
      stitching: null,
      downloads: [],
      bundling: null,
      browser: { progress: 1, doneIn: null, alreadyAvailable: true },
      copyingState: { bytes: 0, doneIn: null },
      artifactState: { received: [] },
      logs: [],
    },
  });
  await notifyClientsOfJobUpdate();

  if (!RENDER_SERVER_URL) {
    failJob(job, "RENDER_SERVER_URL environment variable is not set");
    processing = false;
    processJobIfPossible();
    return;
  }

  try {
    // Bundle the Remotion project so /remotion-bundle/ is up to date
    updateJob(job.id, (j) => {
      if (j.status === "running" && j.progress) {
        j.progress.message = "Bundling Remotion project...";
      }
    });
    console.log("[studio] Bundling Remotion project...");
    execSync("pnpm run bundle", { cwd: __dirname, stdio: "inherit" });
    console.log("[studio] Bundle complete");

    // Parse inputProps from the serialized form
    let inputProps: Record<string, unknown> = {};
    try {
      if (job.serializedInputPropsWithCustomSchema) {
        inputProps = JSON.parse(job.serializedInputPropsWithCustomSchema);
      }
    } catch {
      // If parsing fails, send empty props
    }

    const serveUrl = getServeUrl();
    const body: Record<string, unknown> = {
      serveUrl,
      compositionId: job.compositionId,
    };
    if (Object.keys(inputProps).length > 0) {
      body.inputProps = inputProps;
    }

    // Common params
    if (job.scale !== 1) body.scale = job.scale;
    if (job.logLevel) body.logLevel = job.logLevel;
    if (job.delayRenderTimeout !== 30000) body.timeoutInMilliseconds = job.delayRenderTimeout;
    if (job.envVariables && Object.keys(job.envVariables).length > 0) {
      body.envVariables = job.envVariables;
    }

    if (job.type === "still") {
      body.type = "still";
      body.imageFormat = job.imageFormat;
      if (job.frame !== 0) body.frame = job.frame;
      // jpegQuality only valid when imageFormat is jpeg
      if (job.imageFormat === "jpeg" && job.jpegQuality) body.jpegQuality = job.jpegQuality;
    } else {
      // Both "video" and "sequence" map to the remote server's "video" type
      body.type = "video";
      if (job.type === "video") {
        const codec = job.codec;
        body.codec = codec;
        if (job.audioCodec) body.audioCodec = job.audioCodec;
        if (job.muted) body.muted = job.muted;
        if (job.enforceAudioTrack) body.enforceAudioTrack = job.enforceAudioTrack;
        if (job.crf) body.crf = job.crf;
        if (job.videoBitrate) body.videoBitrate = job.videoBitrate;
        if (job.audioBitrate) body.audioBitrate = job.audioBitrate;
        // jpegQuality only when videoImageFormat is jpeg (default)
        if (job.jpegQuality && (job.imageFormat ?? "jpeg") === "jpeg") {
          body.jpegQuality = job.jpegQuality;
        }
        // x264Preset only for h264 codecs
        if (job.x264Preset && ["h264", "h264-mkv", "h264-ts"].includes(codec)) {
          body.x264Preset = job.x264Preset;
        }
        // gif-only params
        if (codec === "gif") {
          if (job.everyNthFrame !== 1) body.everyNthFrame = job.everyNthFrame;
          if (job.numberOfGifLoops !== null) body.numberOfGifLoops = job.numberOfGifLoops;
        }
        // proResProfile only for prores codec
        if (job.proResProfile && codec === "prores") {
          body.proResProfile = job.proResProfile;
        }
        if (job.pixelFormat !== "yuv420p") body.pixelFormat = job.pixelFormat;
        if (job.colorSpace !== "default") body.colorSpace = job.colorSpace;
        if (job.encodingMaxRate) body.encodingMaxRate = job.encodingMaxRate;
        if (job.encodingBufferSize) body.encodingBufferSize = job.encodingBufferSize;
        if (job.disallowParallelEncoding) body.disallowParallelEncoding = job.disallowParallelEncoding;
        if (job.forSeamlessAacConcatenation) body.forSeamlessAacConcatenation = job.forSeamlessAacConcatenation;
        if (job.startFrame > 0 || job.endFrame > 0) {
          body.frameRange = [job.startFrame, job.endFrame];
        }
      }
      if (job.concurrency > 1) body.concurrency = job.concurrency;
    }

    // Start the remote render
    const startRes = await fetch(`${RENDER_SERVER_URL}/remotion-renders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!startRes.ok) {
      const errText = await startRes.text();
      throw new Error(
        `Render server returned ${startRes.status}: ${errText}`,
      );
    }

    const startData = (await startRes.json()) as { jobId: string };
    const remoteJobId = startData.jobId;

    console.log(
      `[studio] Remote render started: ${remoteJobId} for ${job.compositionId}`,
    );

    // Listen for cancellation via Remotion's cancelToken
    // cancelSignal is a function that registers a callback, not an AbortSignal
    let cancelled = false;
    if (job.cancelToken?.cancelSignal) {
      job.cancelToken.cancelSignal(() => {
        cancelled = true;
      });
    }

    // Poll for completion
    let status = "pending";
    while (status !== "completed" && status !== "failed") {
      if (cancelled) {
        // Attempt to cancel on remote server
        try {
          await fetch(`${RENDER_SERVER_URL}/remotion-renders/${remoteJobId}`, {
            method: "DELETE",
          });
        } catch {
          // Best effort
        }
        failJob(job, "Render cancelled by user");
        processing = false;
        processJobIfPossible();
        return;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const pollRes = await fetch(
        `${RENDER_SERVER_URL}/remotion-renders/${remoteJobId}`,
      );
      if (!pollRes.ok) {
        const errText = await pollRes.text();
        throw new Error(`Poll failed with ${pollRes.status}: ${errText}`);
      }

      const pollData = (await pollRes.json()) as {
        status: string;
        progress?: number;
        outputUrl?: string;
        error?: string;
      };
      status = pollData.status;

      if (status === "failed") {
        throw new Error(pollData.error ?? "Unknown render error");
      }

      // Update progress
      if (status === "rendering" || status === "pending") {
        const progressValue = pollData.progress ?? 0;
        updateJob(job.id, (j) => {
          if (j.status === "running" && j.progress) {
            j.progress.value = progressValue;
            j.progress.message = `Rendering... ${
              Math.round(progressValue * 100)
            }%`;
          }
        });
      }

      if (status === "completed" && pollData.outputUrl) {
        // Download the result
        updateJob(job.id, (j) => {
          if (j.status === "running" && j.progress) {
            j.progress.value = 0.95;
            j.progress.message = "Downloading rendered video...";
          }
        });

        let downloadUrl = pollData.outputUrl.startsWith("http")
          ? pollData.outputUrl
          : new URL(pollData.outputUrl, RENDER_SERVER_URL).toString();

        // Fix localhost URLs
        try {
          const outputParsed = new URL(downloadUrl);
          const serverParsed = new URL(RENDER_SERVER_URL);
          if (
            outputParsed.hostname === "localhost" ||
            outputParsed.hostname === "127.0.0.1"
          ) {
            outputParsed.hostname = serverParsed.hostname;
            outputParsed.port = serverParsed.port;
            downloadUrl = outputParsed.toString();
          }
        } catch {
          // ignore
        }

        const downloadRes = await fetch(downloadUrl);
        if (!downloadRes.ok) {
          throw new Error(
            `Failed to download render output: ${downloadRes.status}`,
          );
        }

        const fileData = new Uint8Array(await downloadRes.arrayBuffer());
        const outDir = path.dirname(job.outName);
        if (outDir) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        fs.writeFileSync(job.outName, fileData);

        console.log(
          `[studio] Render complete: ${job.outName} (${fileData.length} bytes)`,
        );

        // Mark done
        Object.assign(job, {
          status: "done",
          progress: {
            message: "Render complete",
            value: 1,
            rendering: null,
            stitching: null,
            downloads: [],
            bundling: null,
            browser: { progress: 1, doneIn: null, alreadyAvailable: true },
            copyingState: { bytes: 0, doneIn: null },
            artifactState: { received: [] },
            logs: [],
          },
        });
        await notifyClientsOfJobUpdate();
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failJob(job, message);
  }

  processing = false;
  processJobIfPossible();
}

async function failJob(
  job: RenderJobWithCleanup,
  message: string,
): Promise<void> {
  console.error(`[studio] Render failed: ${message}`);
  Object.assign(job, {
    status: "failed",
    error: { message, stack: undefined },
  });
  await notifyClientsOfJobUpdate();

  // Send failure event
  const listener = await StudioServerInternals.waitForLiveEventsListener();
  listener.sendEventToClient({
    type: "render-job-failed",
    compositionId: job.compositionId,
    error: new Error(message),
  });
}

// ---------------------------------------------------------------------------
// Queue Methods (passed to startStudio)
// ---------------------------------------------------------------------------

function addJob({
  job,
}: {
  job: RenderJobWithCleanup;
  entryPoint: string;
  remotionRoot: string;
  logLevel: string;
}): void {
  jobQueue.push(job);
  notifyClientsOfJobUpdate();
  processJobIfPossible();
}

function cancelJob(jobId: string): void {
  const job = jobQueue.find((j) => j.id === jobId);
  if (!job) return;

  if (job.cancelToken?.cancel) {
    job.cancelToken.cancel();
  }
}

function removeJob(jobId: string): void {
  const idx = jobQueue.findIndex((j) => j.id === jobId);
  if (idx === -1) return;

  const [removed] = jobQueue.splice(idx, 1);
  if (removed.cleanup) {
    for (const fn of removed.cleanup) {
      try {
        fn();
      } catch {
        // ignore cleanup errors
      }
    }
  }
  notifyClientsOfJobUpdate();
}

// ---------------------------------------------------------------------------
// Start Studio
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[studio] Starting Remotion Studio on port ${DESIRED_PORT}`);
  if (RENDER_SERVER_URL) {
    console.log(`[studio] Remote render server: ${RENDER_SERVER_URL}`);
    console.log(`[studio] Serve URL for renders: ${getServeUrl()}`);
  } else {
    console.warn(
      "[studio] WARNING: RENDER_SERVER_URL not set — renders will fail",
    );
  }

  await StudioServerInternals.startStudio({
    fullEntryPath: path.resolve(__dirname, "src/index.tsx"),
    remotionRoot: __dirname,
    desiredPort: DESIRED_PORT,
    shouldOpenBrowser: false,
    logLevel: "info",
    webpackOverride: (config) => config,
    previewEntry: require.resolve("@remotion/studio/previewEntry"),
    queueMethods: { addJob, cancelJob, removeJob },
    getRenderQueue,
    getRenderDefaults: () => ({
      jpegQuality: 80,
      scale: 1,
      logLevel: "info" as const,
      codec: "h264" as const,
      concurrency: 1,
      minConcurrency: 1,
      maxConcurrency: 1,
      muted: false,
      stillImageFormat: "png" as const,
      videoImageFormat: "jpeg" as const,
      audioCodec: null,
      enforceAudioTrack: false,
      proResProfile: null,
      x264Preset: "medium" as const,
      pixelFormat: "yuv420p" as const,
      audioBitrate: null,
      videoBitrate: null,
      encodingBufferSize: null,
      encodingMaxRate: null,
      userAgent: null,
      everyNthFrame: 1,
      numberOfGifLoops: null,
      delayRenderTimeout: 30000,
      disableWebSecurity: false,
      openGlRenderer: null,
      ignoreCertificateErrors: false,
      mediaCacheSizeInBytes: null,
      offthreadVideoCacheSizeInBytes: null,
      offthreadVideoThreads: null,
      headless: true,
      colorSpace: "default" as const,
      multiProcessOnLinux: true,
      darkMode: true,
      beepOnFinish: false,
      repro: false,
      forSeamlessAacConcatenation: false,
      metadata: null,
      hardwareAcceleration: "disable" as const,
      chromeMode: "headless-shell" as const,
      publicLicenseKey: null,
      outputLocation: null,
    }),
    keyboardShortcutsEnabled: true,
    experimentalClientSideRenderingEnabled: false,
    experimentalVisualModeEnabled: false,
    relativePublicDir: "public",
    numberOfAudioTags: 0,
    browserArgs: "",
    browserFlag: "",
    getCurrentInputProps: () => ({}),
    getEnvVariables: () => ({}),
    maxTimelineTracks: null,
    bufferStateDelayInMilliseconds: null,
    poll: null,
    gitSource: null,
    binariesDirectory: null,
    forceIPv4: false,
    audioLatencyHint: null,
    enableCrossSiteIsolation: false,
    askAIEnabled: false,
    forceNew: false,
    rspack: false,
  });

  console.log(`[studio] Remotion Studio is running on port ${DESIRED_PORT}`);
}

main().catch((err) => {
  console.error("[studio] Failed to start:", err);
  process.exit(1);
});
