import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { launchChromium } from "./browser.js";

// Visual constants kept in sync with the terminal chrome in replay.ts.
const PAD_BG = "#0d0d12";
const WIN_BG = "#1e1e2e";
const TITLEBAR_BG = "#181825";
const RADIUS = 10;
export const TITLEBAR_H = 30;
/** Chroma-key color for the content hole (ffmpeg colorkeys this to the video). */
export const CHROMA_KEY = "0xff00ff";

export interface ChromeGeometry {
  canvasW: number;
  canvasH: number;
  winX: number;
  winY: number;
  winW: number;
  winH: number;
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
}

/** A centered window whose content area fits `contentAspect` into the canvas. */
export function browserGeometry(canvasW = 1280, canvasH = 720, contentAspect = 1440 / 900): ChromeGeometry {
  const padX = 64;
  const padY = 48;
  const maxW = canvasW - padX * 2;
  const maxH = canvasH - padY * 2 - TITLEBAR_H;
  let contentW = maxW;
  let contentH = contentW / contentAspect;
  if (contentH > maxH) {
    contentH = maxH;
    contentW = contentH * contentAspect;
  }
  contentW = Math.round(contentW);
  contentH = Math.round(contentH);
  const winW = contentW;
  const winH = contentH + TITLEBAR_H;
  const winX = Math.round((canvasW - winW) / 2);
  const winY = Math.round((canvasH - winH) / 2);
  return {
    canvasW,
    canvasH,
    winX,
    winY,
    winW,
    winH,
    contentX: winX,
    contentY: winY + TITLEBAR_H,
    contentW,
    contentH,
  };
}

/**
 * Render the mac window chrome (rounded window, titlebar, dots) once and
 * screenshot it to a PNG with the content area painted the chroma-key color.
 * Cached: re-used for every browser segment at this resolution.
 */
export async function ensureBrowserChrome(cachePath: string, geo: ChromeGeometry): Promise<string> {
  if (existsSync(cachePath)) return cachePath;
  await mkdir(dirname(cachePath), { recursive: true });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; }
    body { width: ${geo.canvasW}px; height: ${geo.canvasH}px; background: ${PAD_BG}; position: relative; }
    .window {
      position: absolute; left: ${geo.winX}px; top: ${geo.winY}px;
      width: ${geo.winW}px; height: ${geo.winH}px;
      background: ${WIN_BG}; border-radius: ${RADIUS}px; overflow: hidden;
      box-shadow: 0 24px 60px rgba(0,0,0,0.55);
    }
    .titlebar { height: ${TITLEBAR_H}px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: ${TITLEBAR_BG}; }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .red { background: #ff5f56; } .yellow { background: #ffbd2e; } .green { background: #27c93f; }
    .content { height: ${geo.contentH}px; background: #ff00ff; }
  </style></head><body>
    <div class="window">
      <div class="titlebar"><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></div>
      <div class="content"></div>
    </div>
  </body></html>`;

  // deviceScaleFactor 1 keeps the magenta pure and the PNG exactly canvas-sized,
  // so the colorkey has no anti-aliased fringe to bleed through.
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: geo.canvasW, height: geo.canvasH } });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: cachePath, clip: { x: 0, y: 0, width: geo.canvasW, height: geo.canvasH } });
  } finally {
    await browser.close();
  }
  return cachePath;
}
