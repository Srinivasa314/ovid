import { createRequire } from "node:module";
import { readdirSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

// node-pty's prebuilt unix `spawn-helper` ships without the execute bit, which
// causes `posix_spawnp failed` at runtime. Restore +x on every install.
// Best-effort: never fail the install over this, and no-op where it doesn't apply.
try {
  const require = createRequire(import.meta.url);
  const ptyDir = dirname(require.resolve("node-pty/package.json"));
  const prebuilds = join(ptyDir, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, "spawn-helper");
      if (existsSync(helper)) {
        chmodSync(helper, 0o755);
        console.log("[ovid] chmod +x", helper);
      }
    }
  }
} catch (err) {
  console.warn("[ovid] postinstall spawn-helper fix skipped:", err?.message ?? err);
}
