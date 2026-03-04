// See all configuration options: https://remotion.dev/docs/config
// Each option also is available as a CLI flag: https://remotion.dev/docs/cli

// Note: When using the Node.JS APIs, the config file doesn't apply. Instead, pass options directly to the APIs

import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// publicPath for remote rendering is set via the `bundle` script's
// --public-path flag. Do NOT override it here — it breaks the dev server
// by serving bundle.js at /remotion-bundle/bundle.js instead of /bundle.js.

