import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderTerminalVideo } from "./replay.js";
import { focusCutMerge, type MergeInput } from "./merge.js";
import { makeGif } from "./gif.js";
import { browserGeometry, ensureBrowserChrome } from "./chrome.js";
import { fontFile, REGULAR_TTF } from "./paths.js";
import { DEFAULTS, type ResolvedConfig } from "../config.js";
import type { TimelineJSON } from "../runner/timeline.js";

/**
 * Render a run directory's raw artifacts (terminal casts + browser clips +
 * timeline.json) into final.mp4 / final.gif. Reusable: called lazily by the
 * fixture (on failure) and by `ovid publish` (for featured specs).
 */
export async function renderRun(runDir: string, fallbackCfg: ResolvedConfig = DEFAULTS): Promise<{ mp4: string; gif: string } | null> {
  const timelinePath = join(runDir, "timeline.json");
  if (!existsSync(timelinePath)) return null;
  const tl = JSON.parse(readFileSync(timelinePath, "utf8")) as TimelineJSON & { config?: ResolvedConfig };
  if (!tl.segments?.length) return null;
  const cfg = tl.config ?? fallbackCfg;

  const terminalVideos = new Map<string, string>();
  for (const name of Object.keys(tl.terminals)) {
    const cast = join(runDir, `terminal-${name}.cast`);
    if (!existsSync(cast)) continue;
    const video = join(runDir, `terminal-${name}.mp4`);
    await renderTerminalVideo(cast, video, tl.labels?.[name] ?? "Terminal");
    terminalVideos.set(name, video);
  }

  const inputs: MergeInput[] = [...tl.segments]
    .sort((a, b) => a.start - b.start)
    .map((seg) => {
      if (seg.kind === "browser") {
        return { kind: "browser", sourceVideo: seg.clip!, endHold: cfg.pacing.browserEndHold, caption: seg.caption, title: seg.title };
      }
      const offset = tl.terminals[seg.source] ?? 0;
      return {
        kind: "terminal",
        sourceVideo: terminalVideos.get(seg.source)!,
        in: Math.max(0, seg.start - offset),
        duration: seg.end - seg.start,
        minTotal: cfg.pacing.terminalDwell,
        caption: seg.caption,
      };
    });

  const geo = browserGeometry(cfg.video.width, cfg.video.height, cfg.viewport.width / cfg.viewport.height);
  const chromeOverlay = await ensureBrowserChrome(
    join(runDir, "..", "..", "cache", `chrome-${geo.canvasW}x${geo.canvasH}.png`),
    geo,
  );

  const mp4 = join(runDir, "final.mp4");
  await focusCutMerge(inputs, mp4, join(runDir, "_work"), { fontFile: fontFile(REGULAR_TTF), chromeOverlay, geo });
  const gif = join(runDir, "final.gif");
  await makeGif(mp4, gif);
  return { mp4, gif };
}
