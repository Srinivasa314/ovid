import { attachRecorder } from "playwright-recorder-plus";
import { launchChromium } from "./browser.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCast, type CastEvent } from "../runner/cast.js";

const require = createRequire(import.meta.url);

const CANVAS = { width: 1280, height: 720 };
const FPS = 30;
const TAIL_MS = 1000; // linger on the final frame before stopping

// Playwright's built-in recordVideo is hardcoded to a low VP8 bitrate (blurry
// text, color shift). We capture via CDP screencast at JPEG q100 and transcode
// to crisp H.264 instead.
const H264_ARGS = [
  "-c:v", "libx264",
  "-preset", "slow",
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
];

/**
 * Replay a `.cast` in a headless xterm.js page (dark mac-window chrome, bundled
 * JetBrains Mono) and record it to a high-quality mp4. Returns the mp4 path.
 */
export async function renderTerminalVideo(
  castPath: string,
  outMp4: string,
  label = "",
): Promise<string> {
  const cast = await parseCast(castPath);
  const { html, xtermJs, initScript } = await buildAssets(label);

  const browser = await launchChromium();
  const context = await browser.newContext({ viewport: CANVAS, deviceScaleFactor: 2 });
  const page = await context.newPage();
  if (process.env.OVID_DEBUG) {
    page.on("console", (m) => console.error(`[page:${m.type()}]`, m.text()));
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  }

  try {
    await page.setContent(html, { waitUntil: "load" });
    // Inject scripts as element textContent (not via document.write) so the
    // large minified xterm bundle can't trip the HTML parser.
    await page.addScriptTag({ content: xtermJs });
    await page.addScriptTag({ content: initScript });
    await page.waitForFunction("window.__ovidReady === true", null, { timeout: 15_000 });

    const recorder = await attachRecorder(page, {
      path: outMp4,
      autoStart: false,
      fps: FPS,
      jpegQuality: 100,
      size: CANVAS,
      ffmpegArgs: H264_ARGS,
    });
    await recorder.start();

    await page.evaluate(
      ([events, tail]) =>
        (window as unknown as OvidWindow).__ovidPlay(events as CastEvent[], tail as number),
      [cast.events, TAIL_MS] as const,
    );

    await recorder.stop();
    await recorder.finalized;
    return outMp4;
  } finally {
    await context.close();
    await browser.close();
  }
}

interface OvidWindow {
  __ovidReady: boolean;
  __ovidPlay: (events: CastEvent[], tailMs: number) => Promise<void>;
}

async function buildAssets(label: string): Promise<{ html: string; xtermJs: string; initScript: string }> {
  const titleText = label.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const xtermDir = dirname(require.resolve("@xterm/xterm/package.json"));
  const xtermJs = await readFile(join(xtermDir, "lib", "xterm.js"), "utf8");
  const xtermCss = await readFile(join(xtermDir, "css", "xterm.css"), "utf8");

  const fontsDir = join(packageRoot(), "assets", "fonts");
  const regularB64 = (await readFile(join(fontsDir, "JetBrainsMono-Regular.woff2"))).toString("base64");
  const boldB64 = (await readFile(join(fontsDir, "JetBrainsMono-Bold.woff2"))).toString("base64");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>${xtermCss}</style>
<style>
@font-face {
  font-family: 'JetBrains Mono';
  font-weight: 400;
  src: url(data:font/woff2;base64,${regularB64}) format('woff2');
}
@font-face {
  font-family: 'JetBrains Mono';
  font-weight: 700;
  src: url(data:font/woff2;base64,${boldB64}) format('woff2');
}
html, body { margin: 0; padding: 0; }
body {
  width: ${CANVAS.width}px;
  height: ${CANVAS.height}px;
  background: #0d0d12;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.window {
  background: #1e1e2e;
  border-radius: 10px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.titlebar {
  position: relative;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  background: #181825;
}
.title {
  position: absolute;
  left: 0; right: 0;
  text-align: center;
  font: 12px/30px 'JetBrains Mono', monospace;
  color: #9399b2;
  pointer-events: none;
}
.dot { width: 12px; height: 12px; border-radius: 50%; }
.red { background: #ff5f56; }
.yellow { background: #ffbd2e; }
.green { background: #27c93f; }
.term { padding: 12px; }
.xterm { padding: 0; }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>${titleText ? `<span class="title">${titleText}</span>` : ""}</div>
  <div class="term"><div id="term"></div></div>
</div>
</body>
</html>`;

  const initScript = `(async () => {
  try {
    await document.fonts.load("15px 'JetBrains Mono'");
    await document.fonts.load("bold 15px 'JetBrains Mono'");
    await document.fonts.ready;

    const term = new Terminal({
      cols: 100,
      rows: 30,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 15,
      lineHeight: 1.2,
      cursorBlink: false,
      scrollback: 0,
      theme: {
        background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
        black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
        blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
        brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5', brightWhite: '#a6adc8',
      },
    });
    term.open(document.getElementById('term'));

    // JetBrains Mono has tall metrics, so a 100x30 grid can exceed the canvas.
    // Scale the whole window to fit (with padding) so the mac chrome stays
    // visible and nothing is clipped. We render at 2x, so downscaling is crisp.
    const win = document.querySelector('.window');
    const padX = 64, padY = 48;
    const s = Math.min(
      1,
      (${CANVAS.width} - padX * 2) / win.offsetWidth,
      (${CANVAS.height} - padY * 2) / win.offsetHeight,
    );
    win.style.transform = 'scale(' + s + ')';

    window.__ovidPlay = (events, tailMs) => new Promise((resolve) => {
      let i = 0;
      const t0 = performance.now();
      function step() {
        if (i >= events.length) { setTimeout(resolve, tailMs); return; }
        const due = events[i][0] * 1000;
        const now = performance.now() - t0;
        if (now >= due) { term.write(events[i][2]); i++; step(); }
        else setTimeout(step, due - now);
      }
      step();
    });
    window.__ovidReady = true;
  } catch (e) {
    console.error('init failed:', e && e.message);
  }
})();`;

  return { html, xtermJs, initScript };
}

/** Walk up from this file until we find the package root (has package.json). */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate ovid package root");
}
