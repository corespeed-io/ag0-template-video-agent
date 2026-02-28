/**
 * This is an example of a server that returns dynamic video.
 * Run `bun run server` to try it out!
 * If you don't want to render videos on a server, you can safely
 * delete this file.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import express from "express";

const app = express();
const port = process.env.PORT || 8000;
const compositionId = "Main";

const cache = new Map<string, string>();

const webpackOverride: Parameters<typeof bundle>[0]["webpackOverride"] = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...config.resolve?.alias,
      "react-native$": "react-native-web",
    },
  },
});

app.get("/", async (req, res) => {
  try {
    const cacheKey = JSON.stringify(req.query);

    if (cache.has(cacheKey)) {
      res.set("content-type", "video/mp4");
      fs.createReadStream(cache.get(cacheKey)!).pipe(res);
      return;
    }

    const bundled = await bundle({
      entryPoint: path.join(__dirname, "./src/index.tsx"),
      webpackOverride,
    });

    const composition = await selectComposition({
      serveUrl: bundled,
      id: compositionId,
      inputProps: req.query,
    });

    const outputPath = path.join(os.tmpdir(), `remotion-${Date.now()}.mp4`);

    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: "h264",
      outputLocation: outputPath,
      inputProps: req.query,
    });

    cache.set(cacheKey, outputPath);
    res.set("content-type", "video/mp4");
    fs.createReadStream(outputPath).pipe(res);
    console.log("Video rendered and sent!");
  } catch (err) {
    console.error(err);
    res.json({ error: err });
  }
});

app.listen(port);

console.log(
  [
    `The server has started on http://localhost:${port}!`,
    "You can render a video by passing props as URL parameters.",
    "",
    "If you are running Hello World, try this:",
    "",
    `http://localhost:${port}?titleText=Hello,+World!&titleColor=red`,
    "",
  ].join("\n")
);
