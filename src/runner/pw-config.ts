import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig, CONFIG_ENV, type OvidConfig } from "../config.js";

// Shipped Playwright config used by `ovid test`. The CLI sets the env below,
// then spawns `playwright test --config <this>`.
const root = process.env.OVID_PROJECT_ROOT ?? process.cwd();
const userPath = process.env.OVID_USER_CONFIG;

let user: OvidConfig = {};
if (userPath && existsSync(userPath)) {
  try {
    const mod = (await import(pathToFileURL(userPath).href)) as { default?: OvidConfig };
    user = mod.default ?? {};
  } catch (e) {
    console.error(`ovid: failed to load ${userPath}:`, e);
  }
}

const cfg = resolveConfig(user);
// Propagates to worker processes (and thus the fixture).
process.env[CONFIG_ENV] = JSON.stringify(cfg);

export default defineConfig({
  testDir: join(root, cfg.specDir),
  fullyParallel: false,
  workers: 1,
  // Generous: terminal render + focus-cut merge run in fixture teardown.
  timeout: 240_000,
  reporter: "list",
  use: { launchOptions: { slowMo: cfg.slowMo } },
});
