import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "./render/paths.js";

const PKG_NAME = "@srinivasa314/ovid";

function ownVersion(): string {
  try {
    return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version as string;
  } catch {
    return "latest";
  }
}

/**
 * Ensure the project has ovid as a devDependency (creating package.json if
 * absent). ovid runs via the project-local CLI, so it must be installed locally.
 * Returns true if the file was created/changed and `npm install` is needed.
 */
async function ensureDevDependency(projectRoot: string): Promise<boolean> {
  const pkgPath = join(projectRoot, "package.json");
  const version = `^${ownVersion()}`;
  let pkg: Record<string, any> = {};
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return false; // don't clobber an unparseable package.json
    }
  }
  pkg.devDependencies ??= {};
  if (pkg.devDependencies[PKG_NAME]) return false; // already present
  pkg.name ??= "ovid-project";
  pkg.version ??= "0.0.0";
  pkg.private ??= true;
  pkg.devDependencies[PKG_NAME] = version;
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  return true;
}

const CONFIG_TEMPLATE = `import { defineConfig } from "@srinivasa314/ovid";

// All fields optional; values shown are the defaults.
export default defineConfig({
  // specDir: "ovid",
  // viewport: { width: 1440, height: 900 },
  // video: { width: 1280, height: 720, fps: 30 },
  // slowMo: 800,
  // pacing: { terminalDwell: 2.5, browserEndHold: 1.2 },
});
`;

const GUIDE = `# Writing ovid e2e tests

ovid records a polished video (terminal + browser) of a test **and** asserts behavior in code.
Specs live in \`ovid/*.spec.ts\` and run with \`npx ovid test\`. Assertions decide pass/fail; the video is for humans.

## Skeleton
\`\`\`ts
import { test, expect } from "@srinivasa314/ovid/test";

test("user can save a note", async ({ ovid }) => {
  // ovid.terminal(...) and ovid.browser(...) steps
});
\`\`\`

## ovid.terminal(command, opts?)
Runs \`command\` in a shell.
- \`name?\` — named long-lived terminal (its own shell). **Give distinct names when a test uses more than one terminal** (titlebar shows \`Terminal: <name>\`; unnamed → \`Terminal\`). Reuse a name to run more commands in that shell.
- \`waitFor?: RegExp\` — **server mode**: resolves once output matches, leaving the process running (e.g. a dev server). A foreground server occupies its terminal — use a different \`name\` for other commands.
- \`expect?: RegExp\` — output must match.
- \`not?: RegExp\` — output must NOT match.
- \`exitCode?: number\` — required exit code (defaults to 0 when no other assertion).
- \`caption?\` — caption shown under the step.
- \`timeout?\` — ms (default 30000).

## ovid.browser(caption, async (page) => { ... }, opts?)
Drives a Playwright \`page\` (full Playwright API). \`caption\` is shown under the step.
Titlebar shows the page URL by default; override with \`opts.title\`. Assert with Playwright \`expect\`.

## Example (multi-terminal + browser)
\`\`\`ts
import { test, expect } from "@srinivasa314/ovid/test";

test("note persists", async ({ ovid }) => {
  await ovid.terminal("flask --app api/app.py run -p 3001", { name: "API", waitFor: /Running on/, caption: "Start the API" });
  await ovid.terminal("python3 -m http.server 3000 --directory web", { name: "Web", waitFor: /Serving HTTP/, caption: "Serve the UI" });

  await ovid.browser("Create a note", async (page) => {
    await page.goto("http://localhost:3000");
    await page.getByPlaceholder("New note").fill("Buy milk");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Buy milk")).toBeVisible();
  });

  await ovid.terminal('sqlite3 api/notes.db "select count(*)"', { name: "DB", expect: /1/, caption: "Persisted to SQLite" });
});
\`\`\`

## Rules of thumb
- Commands run from the project root (cwd of \`ovid test\`); use paths relative to it.
- Servers are killed automatically when the test ends.
- Each terminal/browser block becomes one video segment — keep them focused.
- Run all specs with \`npx ovid test\`, or one with \`npx ovid test <name-substring>\`.
- Passing runs save raw artifacts but don't render a video (kept cheap); run \`npx ovid render <name-substring>\` to produce \`final.mp4\`/\`.gif\` for one.
`;

async function writeIfAbsent(path: string, content: string): Promise<"created" | "exists"> {
  if (existsSync(path)) return "exists";
  await writeFile(path, content, "utf8");
  return "created";
}

/** Scaffold config + guide + gitignore (never overwrites existing files). */
export async function init(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, "ovid"), { recursive: true });
  await mkdir(join(projectRoot, ".ovid"), { recursive: true });
  await mkdir(join(projectRoot, ".pi", "extensions"), { recursive: true });

  const extension = await readFile(join(packageRoot(), "assets", "pi-extension.ts"), "utf8");

  const items: Array<[string, string]> = [
    ["ovid.config.ts", await writeIfAbsent(join(projectRoot, "ovid.config.ts"), CONFIG_TEMPLATE)],
    ["ovid/WRITING-OVID-E2E-TESTS.md", await writeIfAbsent(join(projectRoot, "ovid", "WRITING-OVID-E2E-TESTS.md"), GUIDE)],
    [".ovid/.gitignore", await writeIfAbsent(join(projectRoot, ".ovid", ".gitignore"), "*\n")],
    [".pi/extensions/ovid.ts", await writeIfAbsent(join(projectRoot, ".pi", "extensions", "ovid.ts"), extension)],
  ];

  const needsInstall = await ensureDevDependency(projectRoot);
  for (const [name, status] of items) console.log(`  ${status === "created" ? "+ created" : "= exists "} ${name}`);
  if (needsInstall) console.log(`  + added ${PKG_NAME} to package.json devDependencies`);

  console.log(
    (needsInstall ? "\nNext: run `npm install` to install ovid locally, then" : "\nNext:") +
      " add a spec in ./ovid/*.spec.ts (see ovid/WRITING-OVID-E2E-TESTS.md), then run `npx ovid test`." +
      "\npi will auto-discover the ovid_test tool from .pi/extensions/ovid.ts.",
  );
}
