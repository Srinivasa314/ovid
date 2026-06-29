import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectDescendants } from "../src/runner/kill.js";
import { findFfmpeg } from "../src/render/ffmpeg.js";

// Fix D: a live ffmpeg started via runFfmpeg() must be killed when the process
// exits, so an interrupted `ovid render`/`ovid publish` can't orphan an encode.
// Needs a drawtext-capable ffmpeg (ffmpegBin throws otherwise); skip if absent.

const skip = findFfmpeg() ? false : "no drawtext-capable ffmpeg on this machine";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

test("ffmpeg children are killed when the process exits (no orphaned encode)", { skip, timeout: 40_000 }, async () => {
  const ffmpegUrl = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "ffmpeg.ts"),
  ).href;
  // A child that starts a long real-time ffmpeg via the tracked runFfmpeg(), then
  // exits normally. Without the exit-hook the encode would outlive it.
  const code =
    `import(${JSON.stringify(ffmpegUrl)}).then((m) => {` +
    `m.runFfmpeg(["-re","-f","lavfi","-i","testsrc=duration=60:rate=25","-f","null","-"]).catch(() => {});` +
    `setTimeout(() => process.exit(0), 3000);` +
    `});`;
  const child = spawn(process.execPath, ["--import", "tsx", "-e", code], { stdio: "ignore" });

  // Capture the ffmpeg grandchild while the child is alive.
  let ff = 0;
  await until(() => {
    const live = collectDescendants(child.pid!).filter(alive);
    if (live.length) ff = live[0];
    return ff !== 0;
  }, 15_000);
  assert.ok(ff && alive(ff), "ffmpeg encode should be running while the process is alive");

  // The child self-exits; its exit-hook must SIGKILL the ffmpeg.
  await until(() => child.exitCode !== null || child.signalCode !== null, 12_000);
  const dead = await until(() => !alive(ff), 8_000);
  // Safety net so a failure can't leave a 60s encode running.
  if (!dead) {
    try {
      process.kill(ff, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  assert.ok(dead, `ffmpeg pid ${ff} should be killed on exit, not orphaned`);
});
