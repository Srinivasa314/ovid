import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { findFfmpeg } from "./render/ffmpeg.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** "test" components block `ovid test`; "publish" components only block `ovid publish`. */
  scope: "test" | "publish";
}

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string; notFound: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d));
    p.stderr.on("data", (d: Buffer) => (out += d));
    p.on("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, out: e.message, notFound: e.code === "ENOENT" }));
    p.on("exit", (code) => resolve({ ok: code === 0, out: out.trim(), notFound: false }));
  });
}

/** Check every external component ovid relies on; report and exit non-zero if a test-blocking one is missing. */
export async function doctor(): Promise<number> {
  const checks: Check[] = [];

  const bash = await run("bash", ["--version"]);
  checks.push({ name: "bash (for terminals)", ok: bash.ok, scope: "test", detail: bash.ok ? bash.out.split("\n")[0] : "not found on PATH" });

  const chromePath = chromium.executablePath();
  const hasChromium = !!chromePath && existsSync(chromePath);
  const pwHint = `run: npx playwright install ${process.platform === "linux" ? "--with-deps " : ""}chromium`;
  checks.push({ name: "Chromium (Playwright)", ok: hasChromium, scope: "test", detail: hasChromium ? chromePath : pwHint });

  // ovid renders captions/titlebars with ffmpeg's drawtext filter. The bundled
  // ffmpeg-static has it on macOS but NOT on Linux, where a system ffmpeg is needed.
  const ff = findFfmpeg();
  checks.push({
    name: "ffmpeg (with drawtext)",
    ok: !!ff,
    scope: "test",
    detail: ff
      ? ff
      : "no ffmpeg with the drawtext filter — install a system ffmpeg (Linux: sudo apt-get install -y ffmpeg; macOS: brew install ffmpeg)",
  });

  const git = await run("git", ["--version"]);
  checks.push({ name: "git", ok: git.ok, scope: "publish", detail: git.ok ? git.out : "not installed" });

  const ghv = await run("gh", ["--version"]);
  if (!ghv.ok) {
    checks.push({ name: "GitHub CLI (gh)", ok: false, scope: "publish", detail: ghv.notFound ? "not installed — https://cli.github.com" : ghv.out.split("\n")[0] });
  } else {
    const auth = await run("gh", ["auth", "status"]);
    checks.push({ name: "GitHub CLI (gh)", ok: auth.ok, scope: "publish", detail: auth.ok ? "installed + authenticated" : "installed, not authenticated — run `gh auth login`" });
  }

  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name}`);
    console.log(`    ${c.detail}`);
  }
  console.log();

  const testReady = checks.filter((c) => c.scope === "test").every((c) => c.ok);
  const publishReady = checks.filter((c) => c.scope === "publish").every((c) => c.ok);
  if (!testReady) console.log("✗ Not ready to run `npx ovid test` — install the components marked above.");
  else if (!publishReady) console.log("✓ Ready for `npx ovid test`.  `npx ovid publish` also needs git + an authenticated gh.");
  else console.log("✓ Ready for `npx ovid test` and `npx ovid publish`.");

  return testReady ? 0 : 1;
}
