import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

// Use the bundled ffmpeg: it has drawtext (libfreetype); the system ffmpeg often
// doesn't. recorder-plus bundles the same binary, so ovid needs no system ffmpeg.
export const FFMPEG: string = (ffmpegStatic as unknown as string | null) ?? "ffmpeg";

/** Read a media file's duration (seconds) by parsing ffmpeg's stderr header. */
export function getDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
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
    const p = spawn(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", ...args], {
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
