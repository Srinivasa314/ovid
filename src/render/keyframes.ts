import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpeg } from "./ffmpeg.js";

interface Segment {
  kind: "terminal" | "browser";
  source: string;
  start: number;
  end: number;
  caption?: string;
  clip?: string;
  title?: string;
}
interface Timeline {
  terminals: Record<string, number>;
  segments: Segment[];
}

export interface Keyframe {
  index: number;
  kind: "terminal" | "browser";
  /** Terminal name or browser title (URL). */
  label: string;
  caption?: string;
  path: string;
}

/**
 * Extract one end-state keyframe per timeline segment from a run's source
 * clips, so the agent can vision-review what each step produced. Lazy: only
 * called at publish time.
 */
export async function extractKeyframes(runDir: string, width = 960): Promise<Keyframe[]> {
  const timelinePath = join(runDir, "timeline.json");
  if (!existsSync(timelinePath)) return [];
  const timeline = JSON.parse(readFileSync(timelinePath, "utf8")) as Timeline;
  const outDir = join(runDir, "keyframes");
  await mkdir(outDir, { recursive: true });

  // Preferred: grab from the final video during each segment's freeze-held end
  // state (clear, fully-rendered). Falls back to source clips if unavailable.
  const finalMp4 = join(runDir, "final.mp4");
  const segTimesPath = join(runDir, "segment-times.json");
  if (existsSync(finalMp4) && existsSync(segTimesPath)) {
    const times = JSON.parse(readFileSync(segTimesPath, "utf8")) as { index: number; end: number }[];
    const frames: Keyframe[] = [];
    for (const { index, end } of times) {
      const seg = timeline.segments[index];
      if (!seg) continue;
      const path = join(outDir, `seg-${String(index).padStart(2, "0")}-${seg.kind}.png`);
      await runFfmpeg(["-ss", Math.max(0, end - 0.25).toFixed(3), "-i", finalMp4, "-vf", `scale=${width}:-1`, "-frames:v", "1", path]);
      frames.push({
        index,
        kind: seg.kind,
        label: seg.kind === "browser" ? seg.title ?? "browser" : seg.source,
        caption: seg.caption,
        path,
      });
    }
    return frames;
  }

  const frames: Keyframe[] = [];
  let browserIdx = 0;

  for (let i = 0; i < timeline.segments.length; i++) {
    const seg = timeline.segments[i];
    const path = join(outDir, `seg-${String(i).padStart(2, "0")}-${seg.kind}.png`);
    const scale = ["-vf", `scale=${width}:-1`, "-frames:v", "1"];

    if (seg.kind === "browser") {
      const clip = seg.clip ?? join(runDir, `browser-${String(browserIdx).padStart(2, "0")}.mp4`);
      browserIdx++;
      if (!existsSync(clip)) continue;
      // last frame = end state of the interaction
      await runFfmpeg(["-sseof", "-0.3", "-i", clip, ...scale, path]);
      frames.push({ index: i, kind: "browser", label: seg.title ?? "browser", caption: seg.caption, path });
    } else {
      const video = join(runDir, `terminal-${seg.source}.mp4`);
      if (!existsSync(video)) continue;
      const offset = timeline.terminals[seg.source] ?? 0;
      const t = Math.max(0, seg.end - offset - 0.05);
      await runFfmpeg(["-ss", t.toFixed(3), "-i", video, ...scale, path]);
      frames.push({ index: i, kind: "terminal", label: seg.source, caption: seg.caption, path });
    }
  }
  return frames;
}
