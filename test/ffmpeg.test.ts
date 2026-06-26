import { test } from "node:test";
import assert from "node:assert/strict";
import ffmpegStatic from "ffmpeg-static";
import { selectFfmpeg, hasDrawtext, findFfmpeg, ffmpegCandidates } from "../src/render/ffmpeg.js";

// --- selectFfmpeg: pure selection logic, deterministic via an injected probe ---

test("selectFfmpeg: returns the first candidate whose probe is true", () => {
  assert.equal(selectFfmpeg(["a", "b"], (b) => b === "a"), "a");
});

test("selectFfmpeg: falls through to a later candidate", () => {
  assert.equal(selectFfmpeg(["a", "b"], (b) => b === "b"), "b");
});

test("selectFfmpeg: prefers the earlier candidate when several match (ffmpeg-static over system)", () => {
  assert.equal(selectFfmpeg(["static", "ffmpeg"], () => true), "static");
});

test("selectFfmpeg: skips null/undefined candidates (e.g. ffmpeg-static not installed)", () => {
  assert.equal(selectFfmpeg([null, undefined, "ffmpeg"], (b) => b === "ffmpeg"), "ffmpeg");
});

test("selectFfmpeg: returns null when no candidate has drawtext", () => {
  assert.equal(selectFfmpeg([null, "ffmpeg"], () => false), null);
});

test("selectFfmpeg: returns null for an empty candidate list", () => {
  assert.equal(selectFfmpeg([], () => true), null);
});

test("selectFfmpeg: a null candidate is never probed", () => {
  const probed: Array<string> = [];
  selectFfmpeg([null, "x"], (b) => {
    probed.push(b);
    return false;
  });
  assert.deepEqual(probed, ["x"]); // null skipped, only "x" probed
});

// --- hasDrawtext: real spawns against real binaries on this machine ---

test("hasDrawtext: false for a nonexistent binary (ENOENT handled, no throw)", () => {
  assert.equal(hasDrawtext("/no/such/ffmpeg-binary-xyz"), false);
});

test("hasDrawtext: false for a non-ffmpeg binary (no drawtext in output)", () => {
  // `true` ignores args, exits 0, prints nothing -> no "drawtext" match.
  assert.equal(hasDrawtext("true"), false);
});

test("hasDrawtext: true for bundled ffmpeg-static on macOS", () => {
  if (process.platform !== "darwin" || !ffmpegStatic) return; // ffmpeg-static lacks drawtext on Linux
  assert.equal(hasDrawtext(ffmpegStatic as unknown as string), true);
});

// --- integration: candidates + resolution on the host running the tests ---

test("ffmpegCandidates: ffmpeg-static first, system ffmpeg as fallback", () => {
  const c = ffmpegCandidates();
  assert.equal(c.length, 2);
  assert.equal(c[1], "ffmpeg");
});

test("findFfmpeg: resolves a real drawtext-capable ffmpeg on this machine", () => {
  const f = findFfmpeg();
  assert.ok(f, "expected to find an ffmpeg with drawtext (ffmpeg-static on macOS)");
  assert.equal(hasDrawtext(f), true);
});

test("findFfmpeg: memoizes (second call returns the same path)", () => {
  assert.equal(findFfmpeg(), findFfmpeg());
});
