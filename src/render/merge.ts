import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runFfmpeg as ffmpeg, getDuration } from "./ffmpeg.js";
import { TITLEBAR_H, type ChromeGeometry } from "./chrome.js";

const CANVAS = { w: 1280, h: 720 };
const PAD_COLOR = "0x0d0d12";
const ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"];

export interface MergeInput {
  kind: "terminal" | "browser";
  sourceVideo: string;
  in?: number; // terminal slice start (s)
  duration?: number; // terminal slice length (s)
  minTotal?: number; // terminal: freeze-hold to at least this long
  endHold?: number; // browser: freeze-hold this long on the end state
  caption?: string; // lower-third
  title?: string; // browser titlebar (URL or explicit)
}

export interface MergeOptions {
  fontFile: string;
  chromeOverlay: string;
  geo: ChromeGeometry;
}

export async function focusCutMerge(
  inputs: MergeInput[],
  outMp4: string,
  workDir: string,
  opts: MergeOptions,
): Promise<string> {
  await mkdir(workDir, { recursive: true });
  const clips: string[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const clip = join(workDir, `seg-${String(i).padStart(3, "0")}.mp4`);
    const tag = String(i).padStart(3, "0");

    // Write caption/title to files so ffmpeg drawtext needs no string escaping.
    const captionFile = input.caption ? join(workDir, `cap-${tag}.txt`) : undefined;
    if (captionFile) await writeFile(captionFile, input.caption!, "utf8");
    const titleFile = input.title ? join(workDir, `title-${tag}.txt`) : undefined;
    if (titleFile) await writeFile(titleFile, input.title!, "utf8");

    if (input.kind === "terminal") {
      await renderTerminalSegment(input, clip, captionFile, opts.fontFile);
    } else {
      await renderBrowserSegment(input, clip, captionFile, titleFile, opts);
    }
    clips.push(clip);
  }

  // Record each segment's end-time in the final video (cumulative clip durations)
  // so keyframes can be grabbed from the freeze-held end state of each step.
  const segmentTimes: { index: number; kind: string; end: number }[] = [];
  let cum = 0;
  for (let i = 0; i < clips.length; i++) {
    cum += await getDuration(clips[i]);
    segmentTimes.push({ index: i, kind: inputs[i].kind, end: cum });
  }
  await writeFile(join(dirname(outMp4), "segment-times.json"), JSON.stringify(segmentTimes, null, 2));

  const listPath = join(workDir, "concat.txt");
  await writeFile(listPath, clips.map((c) => `file '${c}'`).join("\n") + "\n", "utf8");
  // Re-encode at concat with forced CFR — stream-copy leaves the tpad freeze
  // frames with broken PTS (plays too fast).
  await ffmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-r", "30", "-fps_mode", "cfr",
    ...ENCODE, "-movflags", "+faststart", outMp4,
  ]);
  return outMp4;
}

async function renderTerminalSegment(
  input: MergeInput,
  clip: string,
  captionFile: string | undefined,
  fontFile: string,
): Promise<void> {
  const duration = Math.max(0.1, input.duration ?? 0.1);
  const hold = Math.max(0, (input.minTotal ?? 0) - duration);
  const filters = [
    `scale=${CANVAS.w}:${CANVAS.h}:force_original_aspect_ratio=decrease`,
    `pad=${CANVAS.w}:${CANVAS.h}:(ow-iw)/2:(oh-ih)/2:color=${PAD_COLOR}`,
    "fps=30",
    "format=yuv420p",
  ];
  if (captionFile) filters.push(captionFilter(fontFile, captionFile));
  if (hold > 0) filters.push(`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`);
  // -ss/-t are INPUT options so tpad can extend the output past the slice.
  await ffmpeg([
    "-ss", Math.max(0, input.in ?? 0).toFixed(3),
    "-t", duration.toFixed(3),
    "-i", input.sourceVideo,
    "-vf", filters.join(","),
    ...ENCODE, "-an", clip,
  ]);
}

async function renderBrowserSegment(
  input: MergeInput,
  clip: string,
  captionFile: string | undefined,
  titleFile: string | undefined,
  opts: MergeOptions,
): Promise<void> {
  const { geo, chromeOverlay, fontFile } = opts;
  const hold = input.endHold ?? 0;

  // Place the browser video in the chrome's content rect, then key the magenta
  // hole out of the overlay so the video shows through the rounded window.
  const chain: string[] = [];
  if (titleFile) {
    const titleY = geo.winY + Math.round((TITLEBAR_H - 15) / 2);
    chain.push(
      `drawtext=fontfile='${fontFile}':textfile='${titleFile}':expansion=none:` +
        `fontcolor=0x9399b2:fontsize=15:x=(w-text_w)/2:y=${titleY}`,
    );
  }
  if (captionFile) chain.push(captionFilter(fontFile, captionFile));
  if (hold > 0) chain.push(`tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`);
  const tail = chain.length ? "," + chain.join(",") : "";

  const filterComplex =
    `[0:v]scale=${geo.contentW}:${geo.contentH},fps=30,` +
    `pad=${CANVAS.w}:${CANVAS.h}:${geo.contentX}:${geo.contentY}:color=${PAD_COLOR}[wv];` +
    `[1:v]colorkey=0xff00ff:0.30:0.05[ck];` +
    `[wv][ck]overlay=0:0:shortest=1,format=yuv420p${tail}[out]`;

  await ffmpeg([
    "-i", input.sourceVideo,
    "-loop", "1", "-i", chromeOverlay,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    ...ENCODE, "-an", clip,
  ]);
}

function captionFilter(fontFile: string, captionFile: string): string {
  return (
    `drawtext=fontfile='${fontFile}':textfile='${captionFile}':expansion=none:` +
    `fontcolor=white:fontsize=24:box=1:boxcolor=0x000000@0.6:boxborderw=16:` +
    `x=(w-text_w)/2:y=h-text_h-44`
  );
}
