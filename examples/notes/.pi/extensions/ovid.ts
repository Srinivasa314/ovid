// ovid pi extension — written by `ovid init` into .pi/extensions/, auto-discovered by pi.
// Lets the agent run ovid e2e tests and publish them to a PR. It shells out to the
// project-local ovid CLI (resolved from node_modules), so it has no ovid imports
// of its own. ovid must be installed as a project devDependency.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const WORKFLOW = [
  "## ovid e2e testing",
  "When you implement or change a feature in this project, verify it with an ovid e2e test",
  "(it records a terminal+browser video and asserts behavior in code):",
  "1. Write or update a spec in ./ovid/*.spec.ts — see ./ovid/WRITING-OVID-E2E-TESTS.md for the API.",
  "2. Run it with the ovid_test tool.",
  "3. If it fails, fix the code or the spec and re-run until green.",
  "To open a pull request for code changes, use the ovid_publish tool (NOT `gh pr create`):",
  "1. Call ovid_publish with no claims. It returns the suggested specs (new AND modified) plus keyframe image paths.",
  "2. READ those keyframe images to see what each step actually produced.",
  "3. Call ovid_publish again with: `feature` = every spec whose behavior your change touched (new specs are",
  "   auto-featured, but a MODIFIED spec gets a video ONLY if you list it in `feature`); `claims` = a short",
  "   summary + per-step bullets (grounded in the keyframes) per featured spec; and `prTitle`/`prSummary`.",
  "This runs the tests, attaches the e2e videos, and opens the PR.",
  "Give terminals distinct names when a test uses more than one. Assertions decide pass/fail; the video is for humans.",
].join("\n");

interface Summary {
  ok: boolean;
  passed: number;
  failed: number;
  tests?: { title: string; status: string; mp4?: string; gif?: string; errors?: string[] }[];
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ovid_test",
    label: "ovid test",
    description:
      "Run ovid e2e specs (records a terminal+browser video; code assertions decide pass/fail). " +
      "Optionally filter by a spec-name substring. Returns pass/fail, any failures, and the video paths.",
    promptSnippet: "ovid_test — run ovid e2e specs (terminal+browser video + assertions)",
    parameters: Type.Object({
      spec: Type.Optional(Type.String({ description: "Substring to filter which spec(s) to run. Omit to run all." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = ["test", "--json"];
      if (params.spec) args.push(params.spec);
      const out = await runOvid(args, ctx.cwd);
      let summary: Summary | null = null;
      try {
        summary = JSON.parse(out.stdout) as Summary;
      } catch {
        /* not JSON — fall through */
      }
      const text = summary
        ? formatSummary(summary)
        : `ovid_test exited ${out.code}\n${(out.stdout + out.stderr).slice(0, 4000)}`;
      return { content: [{ type: "text", text }], details: summary ?? { code: out.code } };
    },
  });

  pi.registerTool({
    name: "ovid_publish",
    label: "ovid publish",
    description:
      "Publish ovid test results to the PR. Call with NO claims first: it returns each featured " +
      "spec's keyframe image paths (read them to see what each step produced). Then call again with " +
      "`claims` (a concise summary + per-step bullets per spec) to upload the video and create/update the PR. " +
      "`feature` optionally adds spec titles to feature beyond the new/modified ones ovid detects.",
    promptSnippet: "ovid_publish — review keyframes, then publish test videos to the PR",
    parameters: Type.Object({
      feature: Type.Optional(Type.Array(Type.String(), { description: "Spec titles to feature with a video." })),
      claims: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            summary: Type.Optional(Type.String()),
            steps: Type.Optional(Type.Array(Type.String())),
          }),
          { description: "Per-spec-title claims to render in the PR." },
        ),
      ),
      prTitle: Type.Optional(Type.String({ description: "Title for a newly created PR." })),
      prSummary: Type.Optional(Type.String({ description: "PR description (above the ovid section) for a new PR." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const featureArgs = (params.feature ?? []).flatMap((t) => ["--feature", t]);
      if (!params.claims) {
        const out = await runOvid(["publish", ...featureArgs], ctx.cwd);
        let prep: PreparePayload | null = null;
        try {
          prep = JSON.parse(out.stdout) as PreparePayload;
        } catch {
          /* fall through */
        }
        const text = prep ? formatPrepare(prep) : `ovid publish exited ${out.code}\n${(out.stdout + out.stderr).slice(0, 4000)}`;
        return { content: [{ type: "text", text }], details: prep ?? { code: out.code } };
      }
      const claimsFile = join(ctx.cwd, ".ovid", "claims.json");
      writeFileSync(claimsFile, JSON.stringify(params.claims));
      const prArgs: string[] = [];
      if (params.prTitle) prArgs.push("--pr-title", params.prTitle);
      if (params.prSummary) prArgs.push("--pr-summary", params.prSummary);
      const out = await runOvid(["publish", "--apply", "--claims", claimsFile, ...featureArgs, ...prArgs], ctx.cwd);
      let res: { ok?: boolean; prUrl?: string; error?: string } | null = null;
      try {
        res = JSON.parse(out.stdout);
      } catch {
        /* fall through */
      }
      const text = res?.ok
        ? `Published. PR: ${res.prUrl}`
        : `ovid publish failed: ${res?.error ?? out.stderr ?? out.stdout}`;
      return { content: [{ type: "text", text }], details: res ?? { code: out.code } };
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (!existsSync(join(cwd, "ovid.config.ts")) && !existsSync(join(cwd, "ovid"))) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + WORKFLOW };
  });

  // Route PR creation through ovid: block a raw `gh pr create` and tell the agent
  // to use ovid_publish instead (which opens the PR with the e2e video attached).
  // The agent reacts to this block mid-turn, so it works even in one-shot -p mode.
  // ovid's own gh calls run as subprocesses (not bash tool calls), so no loop.
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command: string = (event as any).input?.command ?? "";
    if (/\bgh\s+pr\s+create\b/.test(command)) {
      return {
        block: true,
        reason:
          "Don't open the PR with `gh pr create` here. Use the ovid_publish tool: (1) call it with no claims " +
          "to get the suggested specs + keyframe image paths; (2) READ those keyframe images; (3) call it again " +
          "with `feature` (list every spec whose behavior you changed — a MODIFIED spec is shown ONLY if you " +
          "feature it; new specs are automatic), `claims` (per-step bullets grounded in the keyframes), and " +
          "`prTitle`/`prSummary` (your intended PR title + description). It runs the tests, attaches the videos, and opens the PR.",
      };
    }
  });
}

interface PreparePayload {
  ready: boolean;
  preconditionError?: string;
  repo?: string;
  branch?: string;
  tests?: {
    title: string;
    status: string;
    suggested: boolean;
    keyframes?: { path: string; kind: string; label: string; caption?: string }[];
  }[];
}

// Resolve the project-local ovid CLI (dist/cli.js) from the project's node_modules,
// via the package main entry (dist/index.js) so it doesn't depend on the
// package.json subpath being exported. Returns null when ovid isn't installed.
function ovidCli(cwd: string): string | null {
  try {
    const req = createRequire(join(cwd, "noop.js"));
    const entry = req.resolve("@srinivasa314/ovid"); // -> .../dist/index.js
    return join(dirname(entry), "cli.js"); // -> .../dist/cli.js
  } catch {
    return null;
  }
}

// Run the local ovid CLI with the current Node, so the Playwright that runs the
// tests is the same instance the spec's "@srinivasa314/ovid/test" import resolves to.
function runOvid(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const cli = ovidCli(cwd);
  if (!cli) {
    return Promise.resolve({
      code: 127,
      stdout: "",
      stderr: "ovid is not installed in this project. Run: npm i -D @srinivasa314/ovid",
    });
  }
  return sh(process.execPath, [cli, ...args], cwd);
}

function sh(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function formatSummary(s: Summary): string {
  const lines = [s.ok ? "✅ ovid tests passed" : "❌ ovid tests failed", `${s.passed} passed, ${s.failed} failed`, ""];
  for (const t of s.tests ?? []) {
    lines.push(`${t.status === "passed" ? "✓" : "✗"} ${t.title}`);
    if (t.mp4) lines.push(`   video: ${t.mp4}`);
    if (t.gif) lines.push(`   gif:   ${t.gif}`);
    for (const e of t.errors ?? []) lines.push(`   ${e.split("\n")[0]}`);
  }
  return lines.join("\n");
}

function formatPrepare(p: PreparePayload): string {
  if (!p.ready) return `Not ready to publish: ${p.preconditionError}`;
  const lines = [`Ready to publish to ${p.repo} (branch ${p.branch}).`, "Review the keyframes below, then call ovid_publish again with `claims`.", ""];
  for (const t of p.tests ?? []) {
    if (!t.keyframes?.length) continue;
    lines.push(`### ${t.title} (${t.suggested ? "new/modified" : "selected"})`);
    for (const k of t.keyframes) lines.push(`- [${k.label}] ${k.caption ?? ""} → ${k.path}`);
    lines.push("");
  }
  return lines.join("\n");
}
