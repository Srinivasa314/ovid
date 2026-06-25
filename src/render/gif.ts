import { runFfmpeg } from "./ffmpeg.js";

export interface GifOptions {
  fps?: number;
  width?: number;
}

/**
 * Convert the final mp4 to an inline-PR gif. Two-pass palette (palettegen +
 * paletteuse) for clean color; fps/width capped to keep the file small.
 */
export async function makeGif(inputMp4: string, outGif: string, opts: GifOptions = {}): Promise<string> {
  const fps = opts.fps ?? 12;
  const width = opts.width ?? 960;
  const filter =
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];` +
    `[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`;
  await runFfmpeg(["-i", inputMp4, "-vf", filter, "-loop", "0", outGif]);
  return outGif;
}
