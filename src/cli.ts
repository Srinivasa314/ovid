import { Command } from "commander";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Terminal } from "./runner/pty.js";
import { renderTerminalVideo } from "./render/replay.js";
import { renderRun } from "./render/renderRun.js";
import { runTests } from "./run.js";
import { init } from "./scaffold.js";
import { doctor } from "./doctor.js";
import { preparePublish, applyPublish, type Claims } from "./publish.js";

const collect = (v: string, acc: string[]) => {
  acc.push(v);
  return acc;
};

const program = new Command();
program.name("ovid").description("Record terminal+browser test videos onto PRs").version("0.0.0");

program
  .command("init")
  .description("Scaffold ovid.config.ts, the test-writing guide, and .gitignore")
  .action(async () => {
    await init(process.cwd());
  });

program
  .command("doctor")
  .description("Check that external components (Chromium, ffmpeg, git, gh) are present")
  .action(async () => {
    process.exitCode = await doctor();
  });

program
  .command("test")
  .argument("[filter]", "only run specs matching this substring")
  .option("--json", "emit a machine-readable summary to stdout (used by the pi tool)")
  .description("Run ovid specs (records videos; assertions decide pass/fail)")
  .action(async (filter: string | undefined, options: { json?: boolean }) => {
    const code = await runTests(process.cwd(), { filter, json: !!options.json });
    process.exitCode = code;
  });

program
  .command("render")
  .argument("[filter]", "only render runs whose slug matches this substring")
  .description("Render saved runs (casts + clips) into final.mp4/gif — passing runs aren't rendered automatically")
  .action(async (filter: string | undefined) => {
    const runsDir = join(process.cwd(), ".ovid", "runs");
    if (!existsSync(runsDir)) {
      console.error("No runs found. Run `ovid test` first.");
      process.exitCode = 1;
      return;
    }
    const slugs = readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => !filter || name.includes(filter));
    if (slugs.length === 0) {
      console.error(filter ? `No runs match "${filter}".` : "No runs found. Run `ovid test` first.");
      process.exitCode = 1;
      return;
    }
    let rendered = 0;
    for (const slug of slugs) {
      const out = await renderRun(join(runsDir, slug));
      if (out) {
        console.log(`ovid → ${out.mp4}`);
        rendered++;
      } else {
        console.log(`(skipped ${slug}: no recorded segments)`);
      }
    }
    if (rendered === 0) process.exitCode = 1;
  });

program
  .command("publish")
  .description("Prepare (results + keyframes) or apply (upload + create/update PR)")
  .option("--apply", "upload media and create/update the PR (default: prepare + print JSON)")
  .option("--feature <title>", "spec title to feature with a video (repeatable)", collect, [])
  .option("--claims <file>", "JSON file of per-spec claims (apply mode)")
  .option("--pr-title <title>", "title for a newly created PR")
  .option("--pr-summary <text>", "summary body for a newly created PR (above the ovid section)")
  .option("--dry-run", "compose the PR body but don't call gh")
  .action(
    async (opts: {
      apply?: boolean;
      feature: string[];
      claims?: string;
      prTitle?: string;
      prSummary?: string;
      dryRun?: boolean;
    }) => {
      const cwd = process.cwd();
      if (opts.apply) {
        const claims: Claims = opts.claims ? JSON.parse(readFileSync(opts.claims, "utf8")) : {};
        const res = await applyPublish(cwd, {
          feature: opts.feature,
          claims,
          dryRun: !!opts.dryRun,
          prTitle: opts.prTitle,
          prSummary: opts.prSummary,
        });
        console.log(JSON.stringify(res, null, 2));
      } else {
        const res = await preparePublish(cwd, opts.feature);
        console.log(JSON.stringify(res, null, 2));
      }
    },
  );

// TODO(M4): remove `demo:terminal`. It exists only to exercise the M1 pipeline
// (pty -> .cast -> xterm.js replay -> mp4) until the real spec/CLI surface lands.
program
  .command("demo:terminal")
  .description("[temporary] record a demo terminal session to mp4 (M1 smoke test)")
  .action(async () => {
    const runDir = join(process.cwd(), ".ovid", "runs", "demo");
    await mkdir(runDir, { recursive: true });
    await ensureArtifactGitignore();

    const term = new Terminal(100, 30);
    await term.setup();

    const commands = [
      'echo "👋  Hello from ovid"',
      "ls",
      'echo "starting a slow build..." && sleep 1 && echo "build done ✓"',
      "cat /nope/missing.txt",
    ];
    const results = [];
    for (const c of commands) results.push(await term.run(c));
    await term.settle();

    const castPath = join(runDir, "terminal.cast");
    await term.save(castPath);
    term.dispose();
    console.log("cast    →", castPath);

    const mp4 = join(runDir, "terminal.mp4");
    await renderTerminalVideo(castPath, mp4);

    console.log("\ncommands:");
    for (const r of results) {
      const tag = r.exitCode === 0 ? "ok  " : `exit ${r.exitCode}`;
      console.log(`  [${tag}] ${r.command}`);
    }
    console.log("\nvideo   →", mp4);
  });

async function ensureArtifactGitignore(): Promise<void> {
  const path = join(process.cwd(), ".ovid", ".gitignore");
  if (!existsSync(path)) await writeFile(path, "*\n", "utf8");
}

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
