import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from this file until we find the package root (has package.json). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate ovid package root");
}

export function fontFile(name: string): string {
  return join(packageRoot(), "assets", "fonts", name);
}

export const REGULAR_TTF = "JetBrainsMono-Regular.ttf";
