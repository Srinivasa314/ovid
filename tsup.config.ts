import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts", "src/test.ts", "src/runner/pw-config.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // Native addon + heavy browser runtime stay external; the font/xterm assets
  // are read from disk at runtime, not bundled.
  external: ["node-pty", "playwright", "playwright-recorder-plus", "ffmpeg-static", "@xterm/xterm"],
  banner: { js: "#!/usr/bin/env node" },
});
