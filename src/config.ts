/** User-facing config (all optional) — `ovid.config.ts` default-exports this. */
export interface OvidConfig {
  /** Directory (relative to project root) holding *.spec.ts. Default "ovid". */
  specDir?: string;
  /** Browser viewport. Default 1440x900. */
  viewport?: { width: number; height: number };
  /** Final video size + fps. Default 1280x720 @ 30. */
  video?: { width: number; height: number; fps: number };
  /** Playwright slowMo (ms) — makes browser interactions visible. Default 800. */
  slowMo?: number;
  /** Per-segment dwell tuning (seconds). */
  pacing?: { terminalDwell?: number; browserEndHold?: number };
}

export interface ResolvedConfig {
  specDir: string;
  viewport: { width: number; height: number };
  video: { width: number; height: number; fps: number };
  slowMo: number;
  pacing: { terminalDwell: number; browserEndHold: number };
}

export const DEFAULTS: ResolvedConfig = {
  specDir: "ovid",
  viewport: { width: 1440, height: 900 },
  video: { width: 1280, height: 720, fps: 30 },
  slowMo: 800,
  pacing: { terminalDwell: 2.5, browserEndHold: 1.2 },
};

export function resolveConfig(user: OvidConfig = {}): ResolvedConfig {
  return {
    specDir: user.specDir ?? DEFAULTS.specDir,
    viewport: { ...DEFAULTS.viewport, ...user.viewport },
    video: { ...DEFAULTS.video, ...user.video },
    slowMo: user.slowMo ?? DEFAULTS.slowMo,
    pacing: { ...DEFAULTS.pacing, ...user.pacing },
  };
}

/** Env var carrying the resolved config from the `ovid test` CLI into the fixture. */
export const CONFIG_ENV = "OVID_CONFIG_JSON";

export function configFromEnv(): ResolvedConfig {
  try {
    return resolveConfig(JSON.parse(process.env[CONFIG_ENV] ?? "{}") as OvidConfig);
  } catch {
    return DEFAULTS;
  }
}

/** Helper for `ovid.config.ts` authors: `export default defineConfig({...})`. */
export function defineConfig(config: OvidConfig): OvidConfig {
  return config;
}

/** Test title → run-dir slug. Shared by the fixture and the `--json` parser. */
export function slugify(title: string): string {
  return title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "test";
}
