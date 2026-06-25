import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractKeyframes } from "./render/keyframes.js";
import { renderRun } from "./render/renderRun.js";
import { slugify } from "./config.js";
import { runTests } from "./run.js";

/** Render a run's video if it wasn't already (lazy rendering: passing runs defer it to here). */
async function ensureRendered(runDir: string): Promise<void> {
  if (!existsSync(join(runDir, "final.mp4"))) await renderRun(runDir);
}

const RELEASE_TAG = "ovid-media";
const OVID_START = "<!-- ovid:start -->";
const OVID_END = "<!-- ovid:end -->";

interface Sh {
  code: number;
  stdout: string;
  stderr: string;
  /** true when the executable itself is missing (ENOENT). */
  notFound: boolean;
}
function sh(cmd: string, args: string[], cwd: string): Promise<Sh> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        notFound: !!err && err.code === "ENOENT",
      });
    });
  });
}
const git = (args: string[], cwd: string) => sh("git", args, cwd);
const gh = (args: string[], cwd: string) => sh("gh", args, cwd);

interface RepoCtx {
  repo: string;
  branch: string;
  sha: string;
  defaultBranch: string;
}

async function preconditions(cwd: string): Promise<{ ok: boolean; error?: string; ctx?: RepoCtx }> {
  const inRepo = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inRepo.notFound) return { ok: false, error: "git is not installed — install it and try again." };
  if (inRepo.code !== 0) return { ok: false, error: "not a git repository" };
  const branch = (await git(["branch", "--show-current"], cwd)).stdout.trim();
  if (!branch) return { ok: false, error: "detached HEAD — check out a branch" };
  const sha = (await git(["rev-parse", "--short", "HEAD"], cwd)).stdout.trim();

  const view = await gh(["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], cwd);
  if (view.notFound)
    return { ok: false, error: "GitHub CLI (`gh`) not found — install it from https://cli.github.com, then run `gh auth login`." };
  if (view.code !== 0)
    return {
      ok: false,
      error: `gh repo view failed — no GitHub remote, or not authenticated (run \`gh auth login\`):\n${view.stderr.trim()}`,
    };
  const rv = JSON.parse(view.stdout) as { nameWithOwner: string; defaultBranchRef?: { name: string } };
  const defaultBranch = rv.defaultBranchRef?.name ?? "main";
  if (branch === defaultBranch)
    return { ok: false, error: `on the default branch '${branch}' — create a feature branch first` };
  if ((await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)).code !== 0)
    return { ok: false, error: `branch '${branch}' is not pushed — run: git push -u origin ${branch}` };

  return { ok: true, ctx: { repo: rv.nameWithOwner, branch, sha, defaultBranch } };
}

interface SpecResult {
  title: string;
  ok: boolean;
  file: string;
}
function collectSpecs(reportPath: string): SpecResult[] {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { suites?: PwSuite[] };
  const out: SpecResult[] = [];
  const walk = (suite: PwSuite, file?: string) => {
    const f = suite.file ?? file;
    for (const sp of suite.specs ?? []) out.push({ title: sp.title, ok: !!sp.ok, file: f ?? "" });
    for (const c of suite.suites ?? []) walk(c, f);
  };
  for (const s of report.suites ?? []) walk(s, s.file);
  return out;
}

interface SpecStatus {
  added: Set<string>;
  modified: Set<string>;
}
async function gitSpecStatus(cwd: string, defaultBranch: string): Promise<SpecStatus> {
  const added = new Set<string>();
  const modified = new Set<string>();
  const diff = await git(["diff", "--name-status", `origin/${defaultBranch}...HEAD`], cwd);
  if (diff.code === 0) {
    for (const line of diff.stdout.split("\n")) {
      const m = line.match(/^([A-Z])\d*\s+(.+\.spec\.ts)$/);
      if (m) (m[1] === "A" ? added : modified).add(m[2].trim());
    }
  }
  const status = await git(["status", "--porcelain"], cwd);
  if (status.code === 0) {
    for (const line of status.stdout.split("\n")) {
      const path = line.slice(3).trim();
      if (!path.endsWith(".spec.ts")) continue;
      (line.startsWith("??") || line.trimStart().startsWith("A") ? added : modified).add(path);
    }
  }
  return { added, modified };
}
const matches = (set: Set<string>, file: string) => [...set].some((f) => f.endsWith(file) || file.endsWith(f));

const artifact = (runDir: string, name: string) => (existsSync(join(runDir, name)) ? join(runDir, name) : undefined);

/** Phase 1: gather results + keyframes (for new/modified + requested specs). */
export async function preparePublish(cwd: string, feature: string[] = []): Promise<unknown> {
  const reportPath = join(cwd, ".ovid", "last-run.json");
  if (!existsSync(reportPath)) await runTests(cwd, { json: true });
  if (!existsSync(reportPath)) return { ready: false, error: "no test results — run `npx ovid test` first", tests: [] };

  const pre = await preconditions(cwd);
  const specs = collectSpecs(reportPath);
  const status = pre.ctx ? await gitSpecStatus(cwd, pre.ctx.defaultBranch) : { added: new Set<string>(), modified: new Set<string>() };

  const tests = [];
  for (const s of specs) {
    const slug = slugify(s.title);
    const runDir = join(cwd, ".ovid", "runs", slug);
    const suggested = matches(status.added, s.file) || matches(status.modified, s.file);
    const featured = (suggested || feature.some((f) => s.title.includes(f) || s.file.includes(f))) && s.ok;
    let keyframes: Awaited<ReturnType<typeof extractKeyframes>> = [];
    if (featured) {
      await ensureRendered(runDir); // lazy: render now if a passing run deferred it
      keyframes = await extractKeyframes(runDir);
    }
    tests.push({
      title: s.title,
      file: s.file,
      status: s.ok ? "passed" : "failed",
      suggested,
      mp4: artifact(runDir, "final.mp4"),
      gif: artifact(runDir, "final.gif"),
      keyframes: keyframes.map((k) => ({ path: k.path, kind: k.kind, label: k.label, caption: k.caption })),
    });
  }
  return {
    ready: pre.ok,
    preconditionError: pre.error,
    repo: pre.ctx?.repo,
    branch: pre.ctx?.branch,
    tests,
  };
}

export interface Claims {
  [title: string]: { summary?: string; steps?: string[] };
}

/** Phase 2: upload assets + create/update the PR. */
export async function applyPublish(
  cwd: string,
  opts: { feature: string[]; claims: Claims; dryRun?: boolean; prTitle?: string; prSummary?: string },
): Promise<unknown> {
  const reportPath = join(cwd, ".ovid", "last-run.json");
  if (!existsSync(reportPath)) return { ok: false, error: "no test results — run `npx ovid test` first" };
  const specs = collectSpecs(reportPath);

  const pre = await preconditions(cwd);
  // New specs (git-added) are ALWAYS featured; the agent can add more via opts.feature.
  const status = pre.ctx ? await gitSpecStatus(cwd, pre.ctx.defaultBranch) : { added: new Set<string>(), modified: new Set<string>() };
  const featured = specs.filter(
    (s) => s.ok && (matches(status.added, s.file) || opts.feature.some((f) => s.title === f || s.title.includes(f))),
  );

  if (!pre.ok || !pre.ctx) {
    const body = composeBody(specs, featured, opts.claims, {});
    return { ok: false, error: pre.error, markdown: body };
  }
  const { repo, branch, sha } = pre.ctx;

  const assets: Record<string, { mp4Url: string; gifUrl: string }> = {};
  const uploadDir = join(cwd, ".ovid", "upload");
  await mkdir(uploadDir, { recursive: true });
  for (const s of featured) {
    const slug = slugify(s.title);
    const runDir = join(cwd, ".ovid", "runs", slug);
    await ensureRendered(runDir); // lazy: render now if a passing run deferred it
    const base = `${branch}__${slug}__${sha}`.replace(/[^a-z0-9_]+/gi, "-");
    const mp4 = join(uploadDir, `${base}.mp4`);
    const gif = join(uploadDir, `${base}.gif`);
    await copyFile(join(runDir, "final.mp4"), mp4);
    await copyFile(join(runDir, "final.gif"), gif);
    if (!opts.dryRun) {
      await ensureRelease(cwd, pre.ctx);
      const up = await gh(["release", "upload", RELEASE_TAG, mp4, gif, "--clobber"], cwd);
      if (up.code !== 0) return { ok: false, error: `release upload failed: ${up.stderr.trim()}` };
    }
    const url = (ext: string) => `https://github.com/${repo}/releases/download/${RELEASE_TAG}/${base}.${ext}`;
    assets[s.title] = { mp4Url: url("mp4"), gifUrl: url("gif") };
  }

  const ovidSection = composeBody(specs, featured, opts.claims, assets);
  if (opts.dryRun) return { ok: true, dryRun: true, markdown: ovidSection, featured: featured.map((f) => f.title) };

  const prUrl = await upsertPr(cwd, pre.ctx, ovidSection, opts.prTitle, opts.prSummary);
  return { ok: true, prUrl, featured: featured.map((f) => f.title) };
}

async function ensureRelease(cwd: string, ctx: RepoCtx): Promise<void> {
  if ((await gh(["release", "view", RELEASE_TAG], cwd)).code === 0) return;
  await gh(
    ["release", "create", RELEASE_TAG, "--title", "ovid media", "--notes", "Test videos uploaded by ovid.", "--target", ctx.defaultBranch],
    cwd,
  );
}

async function upsertPr(
  cwd: string,
  ctx: RepoCtx,
  ovidSection: string,
  prTitle?: string,
  prSummary?: string,
): Promise<string> {
  const bf = join(cwd, ".ovid", "pr-body.md");
  const existing = await gh(["pr", "view", "--json", "number,body,url"], cwd);
  if (existing.code === 0) {
    const pr = JSON.parse(existing.stdout) as { body: string; url: string };
    await writeFile(bf, replaceOvidSection(pr.body ?? "", ovidSection), "utf8");
    await gh(["pr", "edit", "--body-file", bf], cwd);
    return pr.url;
  }
  // Creating the PR: agent's summary (from the blocked `gh pr create`) + ovid section.
  const body = (prSummary?.trim() ? prSummary.trim() + "\n\n" : "") + ovidSection;
  await writeFile(bf, body, "utf8");
  const created = await gh(
    ["pr", "create", "--base", ctx.defaultBranch, "--title", prTitle?.trim() || `ovid: ${ctx.branch}`, "--body-file", bf],
    cwd,
  );
  return created.stdout.trim().split("\n").pop() ?? created.stdout.trim();
}

function replaceOvidSection(existing: string, ovid: string): string {
  const block = `${OVID_START}\n${ovid}\n${OVID_END}`;
  if (existing.includes(OVID_START) && existing.includes(OVID_END)) {
    return existing.replace(new RegExp(`${OVID_START}[\\s\\S]*${OVID_END}`), block);
  }
  return (existing.trim() ? existing.trim() + "\n\n" : "") + block;
}

function composeBody(specs: SpecResult[], featured: SpecResult[], claims: Claims, assets: Record<string, { mp4Url: string; gifUrl: string }>): string {
  const lines: string[] = [OVID_START, "## 🎬 ovid e2e tests", ""];
  lines.push("| spec | status |", "| --- | --- |");
  for (const s of specs) lines.push(`| ${s.title} | ${s.ok ? "✅ pass" : "❌ fail"} |`);
  lines.push("");

  for (const s of featured) {
    const a = assets[s.title];
    const c = claims[s.title];
    lines.push(`### ${s.title}`, "");
    if (c?.summary) lines.push(c.summary, "");
    for (const step of c?.steps ?? []) lines.push(`- ${step}`);
    if (c?.steps?.length) lines.push("");
    if (a) {
      lines.push(`![${s.title}](${a.gifUrl})`, "");
      lines.push(`[▶ Full video (mp4)](${a.mp4Url})`, "");
    }
  }
  lines.push(OVID_END);
  return lines.join("\n");
}

interface PwSpec {
  title: string;
  ok?: boolean;
}
interface PwSuite {
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
