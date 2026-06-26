import { spawn, execFileSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

let resolved: string | null = null;

function hasDrawtext(bin: string): boolean {
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

/**
 * Find an ffmpeg binary that supports the `drawtext` filter (libfreetype), which
 * ovid needs for captions + titlebars. Prefers the bundled ffmpeg-static — its
 * macOS build has drawtext — but the ffmpeg-static Linux build does NOT, so fall
 * back to a system `ffmpeg` on PATH there. Returns null if neither has drawtext.
 * Memoized once a working binary is found.
 */
export function findFfmpeg(): string | null {
  if (resolved) return resolved;
  const candidates = [(ffmpegStatic as unknown as string | null) ?? null, "ffmpeg"].filter(Boolean) as string[];
  for (const bin of candidates) {
    if (hasDrawtext(bin)) {
      resolved = bin;
      return bin;
    }
  }
  return null;
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
    const p = spawn(ffmpegBin(), ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
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
    const p = spawn(ffmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${err.slice(-1800)}`)),
    );
  });
}
