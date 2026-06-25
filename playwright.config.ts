import { defineConfig } from "@playwright/test";

// M2: points at the sample app's specs. In M4 `ovid test` will supply this.
export default defineConfig({
  testDir: "examples/notes/ovid",
  fullyParallel: false,
  workers: 1,
  // Generous: terminal cast render + focus-cut merge happen in fixture teardown.
  timeout: 240_000,
  reporter: "list",
  // slowMo makes browser interactions (typing/clicks) visible in the recording.
  // (M4: move to ovid.config.ts.)
  use: { launchOptions: { slowMo: 800 } },
});
