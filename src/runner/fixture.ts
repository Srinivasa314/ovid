import { test as base, expect, type Page } from "@playwright/test";
import { attachRecorder } from "playwright-recorder-plus";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Terminal, type RunResult } from "./pty.js";
import { Timeline } from "./timeline.js";
import { renderRun } from "../render/renderRun.js";
import { configFromEnv, slugify } from "../config.js";

const H264 = [
  "-c:v", "libx264", "-preset", "slow", "-crf", "18",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart",
];

// Injected into every browser page: a cursor that follows the mouse and a
// ripple on click, so slowMo'd interactions are visible in the recording.
const CURSOR_SCRIPT = `
(() => {
  const add = () => {
    if (!document.body || document.getElementById('__ovid_cursor')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #__ovid_cursor{position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;
        border-radius:50%;border:2px solid rgba(0,0,0,0.6);box-shadow:0 0 0 2px rgba(255,255,255,0.7);
        z-index:2147483647;pointer-events:none;transition:left .05s linear,top .05s linear}
      .__ovid_ripple{position:fixed;border-radius:50%;background:rgba(250,204,21,0.6);
        z-index:2147483646;pointer-events:none}
    \`;
    document.head.appendChild(style);
    const cur = document.createElement('div');
    cur.id = '__ovid_cursor';
    document.body.appendChild(cur);
    addEventListener('mousemove', (e) => { cur.style.left = e.clientX+'px'; cur.style.top = e.clientY+'px'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div'); r.className = '__ovid_ripple';
      r.style.left = e.clientX+'px'; r.style.top = e.clientY+'px';
      document.body.appendChild(r);
      // JS rAF (main-thread paints) so the CDP screencast captures the animation;
      // a CSS transform keyframe runs on the compositor and isn't reliably recorded.
      const t0 = performance.now(), dur = 500, maxR = 80;
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const size = 12 + k * maxR;
        r.style.width = size+'px'; r.style.height = size+'px';
        r.style.marginLeft = (-size/2)+'px'; r.style.marginTop = (-size/2)+'px';
        r.style.opacity = String(1 - k);
        if (k < 1) requestAnimationFrame(tick); else r.remove();
      };
      requestAnimationFrame(tick);
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add);
  else add();
})();
`;

const formatUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");

export interface TerminalOptions {
  /** Named long-lived terminal (own pty). Defaults to "shell". */
  name?: string;
  /** Server mode: resolve once this matches output; leave the process running. */
  waitFor?: RegExp;
  /** One-shot assertion: output must match this. */
  expect?: RegExp;
  /** One-shot assertion: output must NOT match this. */
  not?: RegExp;
  /** Required exit code (one-shot). Defaults to 0 when no other assertion given. */
  exitCode?: number;
  /** Optional caption (shown in the video; rendered in M3). */
  caption?: string;
  timeout?: number;
}

export interface BrowserOptions {
  /** Titlebar text. Defaults to the page's URL (host:port/path). */
  title?: string;
}

export interface Ovid {
  terminal(command: string, opts?: TerminalOptions): Promise<void>;
  browser(caption: string, fn: (page: Page) => Promise<void>, opts?: BrowserOptions): Promise<void>;
}

export const test = base.extend<{ ovid: Ovid }>({
  ovid: async ({ browser }, use, testInfo) => {
    const cfg = configFromEnv();
    const slug = slugify(testInfo.title);
    const runDir = join(process.cwd(), ".ovid", "runs", slug);
    await rm(runDir, { recursive: true, force: true });
    await mkdir(runDir, { recursive: true });
    ensureArtifactGitignore();

    const timeline = new Timeline();
    const terminals = new Map<string, Terminal>();
    let browserIdx = 0;

    const ovid: Ovid = {
      async terminal(command, opts = {}) {
        const name = opts.name ?? "shell";
        let term = terminals.get(name);
        if (!term) {
          term = new Terminal();
          await term.setup();
          terminals.set(name, term);
          // Labelled "Terminal: <name>" when named; bare "Terminal" otherwise.
          timeline.registerTerminal(name, term.castStart, opts.name ? `Terminal: ${opts.name}` : "Terminal");
        }
        const start = timeline.now();
        // Record the segment even if the command/assertion fails, so a failing
        // test still produces a debug video.
        try {
          if (opts.waitFor) {
            await term.start(command, { waitFor: opts.waitFor, timeout: opts.timeout });
          } else {
            const res = await term.run(command, { timeout: opts.timeout });
            assertResult(command, res, opts);
          }
        } finally {
          timeline.add({ kind: "terminal", source: name, start, end: timeline.now(), caption: opts.caption });
        }
      },

      async browser(caption, fn, opts = {}) {
        const clip = join(runDir, `browser-${String(browserIdx++).padStart(2, "0")}.mp4`);
        const context = await browser.newContext({ viewport: cfg.viewport, deviceScaleFactor: 2 });
        await context.addInitScript({ content: CURSOR_SCRIPT });
        const page = await context.newPage();
        const recorder = await attachRecorder(page, {
          path: clip,
          autoStart: false,
          fps: cfg.video.fps,
          jpegQuality: 100,
          size: cfg.viewport,
          ffmpegArgs: H264,
        });
        const start = timeline.now();
        await recorder.start();
        // Record the segment + close the context even if the browser steps fail,
        // so a failing test still produces a debug video (and no context leaks).
        try {
          await fn(page);
        } finally {
          await recorder.stop();
          await recorder.finalized;
          const title = opts.title ?? formatUrl(page.url());
          await context.close();
          timeline.add({ kind: "browser", source: "browser", start, end: timeline.now(), caption, clip, title });
        }
      },
    };

    await use(ovid);

    // --- teardown: always save the cheap raw artifacts ---
    for (const [name, term] of terminals) {
      await term.settle(200);
      await term.save(join(runDir, `terminal-${name}.cast`));
      term.dispose();
    }
    await writeFile(join(runDir, "timeline.json"), JSON.stringify({ ...timeline.toJSON(), config: cfg }, null, 2));

    // Lazy rendering: only produce the merged video when the test FAILED (so the
    // agent can see what broke). Passing runs stay cheap; `ovid publish` renders
    // the videos it needs at publish time.
    if (timeline.segments.length > 0 && testInfo.status !== "passed") {
      const out = await renderRun(runDir, cfg);
      if (out) console.log(`\novid → ${out.mp4}`);
    }
  },
});

export { expect };

function assertResult(command: string, res: RunResult, opts: TerminalOptions): void {
  if (opts.exitCode !== undefined) {
    if (res.exitCode !== opts.exitCode)
      throw new Error(`Expected exit ${opts.exitCode}, got ${res.exitCode}: ${command}\n${res.output}`);
  } else if (opts.expect === undefined && opts.not === undefined && res.exitCode !== 0) {
    throw new Error(`Command failed (exit ${res.exitCode}): ${command}\n${res.output}`);
  }
  if (opts.expect && !opts.expect.test(res.output))
    throw new Error(`Expected output to match ${opts.expect}: ${command}\n${res.output}`);
  if (opts.not && opts.not.test(res.output))
    throw new Error(`Expected output NOT to match ${opts.not}: ${command}\n${res.output}`);
}

function ensureArtifactGitignore(): void {
  const path = join(process.cwd(), ".ovid", ".gitignore");
  if (!existsSync(path)) {
    // best-effort; .ovid already exists by the time this runs
    void writeFile(path, "*\n", "utf8").catch(() => {});
  }
}
