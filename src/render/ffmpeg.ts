import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

let resolved: string | null = null;

// Live ffmpeg children we spawned directly (render/merge/duration). If this
// process exits while one is mid-encode — e.g. `ovid render`/`ovid publish` is
// interrupted — kill them so no ffmpeg is orphaned. Only an "exit" handler is
// installed here (synchronous, no re-raise) so importing this module inside the
// Playwright worker can't interfere with Playwright's own signal handling; the
// CLI converts SIGINT/SIGTERM into a clean exit for the standalone commands.
const liveFfmpeg = new Set<ChildProcess>();
let exitHookInstalled = false;

function track<T extends ChildProcess>(p: T): T {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const c of liveFfmpeg) {
        try {
          c.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    });
  }
  liveFfmpeg.add(p);
  p.on("exit", () => liveFfmpeg.delete(p));
  p.on("error", () => liveFfmpeg.delete(p));
  return p;
}

/** True if `bin` is an ffmpeg that exposes the `drawtext` filter. Any spawn
 *  failure (missing binary, non-ffmpeg, error exit) is treated as "no drawtext". */
export function hasDrawtext(bin: string): boolean {
  try {
    const out = execFileSync(bin, ["-hide_banner", "-filters"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return /\bdrawtext\b/.test(out);
  } catch {
    return false;
  }
}

/** Pure selection: the first candidate (in preference order) that passes `probe`,
 *  skipping null/empty entries. Returns null if none qualify. Exposed for testing. */
export function selectFfmpeg(
  candidates: ReadonlyArray<string | null | undefined>,
  probe: (bin: string) => boolean = hasDrawtext,
): string | null {
  for (const bin of candidates) {
    if (bin && probe(bin)) return bin;
  }
  return null;
}

/** Candidate ffmpeg binaries, in preference order: the bundled ffmpeg-static
 *  first (its macOS build has drawtext), then a system `ffmpeg` on PATH (needed
 *  on Linux, where the ffmpeg-static build lacks drawtext). */
export function ffmpegCandidates(): Array<string | null> {
  return [(ffmpegStatic as unknown as string | null) ?? null, "ffmpeg"];
}

/**
 * Find an ffmpeg binary that supports the `drawtext` filter (libfreetype), which
 * ovid needs for captions + titlebars. Returns null if none qualify. Memoized
 * once a working binary is found (a null result is not cached, so a later install
 * of a system ffmpeg is picked up).
 */
export function findFfmpeg(): string | null {
  if (resolved) return resolved;
  resolved = selectFfmpeg(ffmpegCandidates());
  return resolved;
}

function ffmpegBin(): string {
  const bin = findFfmpeg();
  if (!bin) {
    throw new Error(
      "ovid needs an ffmpeg built with the drawtext filter (libfreetype) to render captions and titlebars.\n" +
        "The bundled ffmpeg-static lacks drawtext on this platform — install a system ffmpeg:\n" +
        "  Debian/Ubuntu:  sudo apt-get install -y ffmpeg\n" +
        "  Fedora:         sudo dnf install -y ffmpeg\n" +
        "  macOS:          brew install ffmpeg",
    );
  }
  return bin;
}

/** Read a media file's duration (seconds) by parsing ffmpeg's stderr header. */
export function getDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = track(spawn(ffmpegBin(), ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] }));
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", () => resolve(0));
    p.on("exit", () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    });
  });
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = track(
      spawn(ffmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", ...args], {
        stdio: ["ignore", "ignore", "pipe"],
      }),
    );
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${err.slice(-1800)}`)),
    );
  });
}
