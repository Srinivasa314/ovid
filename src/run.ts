import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { packageRoot } from "./render/paths.js";
import { slugify } from "./config.js";

const require = createRequire(import.meta.url);

export interface RunOptions {
  filter?: string;
  /** Emit a machine-readable JSON summary to stdout (used by the pi tool). */
  json?: boolean;
}

export interface TestResult {
  title: string;
  status: string;
  mp4?: string;
  gif?: string;
  errors?: string[];
}

/**
 * Run the project's ovid specs via the shipped Playwright config.
 * Human mode streams Playwright's list reporter; json mode prints an ovid summary.
 */
export async function runTests(projectRoot: string, opts: RunOptions = {}): Promise<number> {
  await mkdir(join(projectRoot, ".ovid"), { recursive: true });
  const gitignore = join(projectRoot, ".ovid", ".gitignore");
  if (!existsSync(gitignore)) await writeFile(gitignore, "*\n", "utf8");

  const root = packageRoot();
  const distCfg = join(root, "dist", "runner", "pw-config.js");
  const srcCfg = join(root, "src", "runner", "pw-config.ts");
  const configPath = existsSync(distCfg) ? distCfg : srcCfg;

  const pwDir = dirname(require.resolve("playwright/package.json"));
  const pwBin = join(dirname(pwDir), ".bin", "playwright");

  const userConfig = join(projectRoot, "ovid.config.ts");
  const jsonReport = join(projectRoot, ".ovid", "last-run.json");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OVID_PROJECT_ROOT: projectRoot,
    OVID_USER_CONFIG: existsSync(userConfig) ? userConfig : "",
  };

  const args = ["test", "--config", configPath];
  if (opts.json) {
    args.push("--reporter=json");
    env.PLAYWRIGHT_JSON_OUTPUT_NAME = jsonReport;
  }
  if (opts.filter) args.push(opts.filter);

  const code = await new Promise<number>((resolve) => {
    const p = spawn(pwBin, args, {
      cwd: projectRoot,
      stdio: opts.json ? ["ignore", "ignore", "inherit"] : "inherit",
      env,
    });
    p.on("error", (e) => {
      console.error("ovid: failed to launch Playwright:", e.message);
      resolve(1);
    });
    p.on("exit", (c) => resolve(c ?? 1));
  });

  if (opts.json) {
    const summary = summarize(projectRoot, jsonReport, code);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }
  return code;
}

function summarize(projectRoot: string, jsonReport: string, code: number) {
  const tests: TestResult[] = [];
  try {
    const report = JSON.parse(readFileSync(jsonReport, "utf8")) as { suites?: PwSuite[] };
    const specs: PwSpec[] = [];
    const walk = (s: PwSuite) => {
      for (const sp of s.specs ?? []) specs.push(sp);
      for (const c of s.suites ?? []) walk(c);
    };
    for (const s of report.suites ?? []) walk(s);

    for (const spec of specs) {
      const result = spec.tests?.[0]?.results?.slice(-1)[0];
      const runDir = join(projectRoot, ".ovid", "runs", slugify(spec.title));
      const mp4 = join(runDir, "final.mp4");
      const gif = join(runDir, "final.gif");
      const errors = (result?.errors ?? []).map((e) => e.message ?? String(e)).filter(Boolean);
      tests.push({
        title: spec.title,
        status: spec.ok ? "passed" : result?.status ?? "failed",
        mp4: existsSync(mp4) ? mp4 : undefined,
        gif: existsSync(gif) ? gif : undefined,
        errors: errors.length ? errors : undefined,
      });
    }
  } catch (e) {
    return { ok: code === 0, passed: 0, failed: 0, tests, error: `could not parse results: ${String(e)}` };
  }
  const passed = tests.filter((t) => t.status === "passed").length;
  return { ok: code === 0, passed, failed: tests.length - passed, tests };
}

interface PwSpec {
  title: string;
  ok?: boolean;
  tests?: { results?: { status?: string; errors?: { message?: string }[] }[] }[];
}
interface PwSuite {
  specs?: PwSpec[];
  suites?: PwSuite[];
}
