# ovid — Plan (M1–M5)

A minimal coding-agent layer on **pi**. After implementing a feature, the agent writes a
**test-as-code**, runs it, and records a **polished video** of the terminal + browser, then
attaches it to the PR. Tests are re-runnable cheaply with no LLM.

> **Platform (v1):** macOS, local, single-machine. Node required to run ovid itself, but the
> **projects under test can be any language** (Python/Go/Rust/…). Parallel execution, Linux/CI,
> and remote are explicitly future work. Cross-language usage is documented in the README.

---

## 1. Architecture

Single npm package `ovid`, two entry points:

- **`ovid` (CLI + test lib)** — the standalone runner. No LLM. Makes re-runs cheap.
- **`ovid/pi`** — the pi extension; thin tools that call the runner.

**Self-contained:** **Local devDependency** (`npm i -D @srinivasa314/ovid`), run via `npx ovid`;
the pi extension resolves the project-local CLI so Playwright loads as a single instance. Bundles
Playwright + node-pty + xterm. **TS specs and `ovid.config.ts` execute via the Playwright Test
runner's built-in TypeScript** — no extra transpiler. A project gains `ovid/` specs + `ovid.config.ts`
plus a dev dependency in `package.json`. Works in any-language repos (Node only needed to run ovid).

**Dependencies**
- Bundled via ovid's npm install: `node-pty`, `@playwright/test` (also provides TS execution), `xterm`.
- System tools: **ffmpeg**, **gh**. One-time `playwright install chromium`.
- `ovid doctor` + auto-preflight verify ffmpeg/gh/chromium; hint Xcode CLT if node-pty must compile.

---

## 2. Integration with pi

- pi **extension** (no edits to the user's `AGENTS.md` or any file they own).
- Workflow guidance via `tool.promptSnippet` + a `before_agent_start` hook that appends ovid's
  *implement → test → record → publish* rules and **points the agent at `ovid/WRITING-OVID-E2E-TESTS.md`**.
- **No `agent_end` enforcement hook** — trust the model to follow the injected workflow.
- Agent-facing tools:
  - `ovid_test(specPath)` — run + assert + capture. Returns `{status, failedAssertions, artifactPaths, summary}`. Full terminal/Playwright logs written to disk for the agent to read.
  - `ovid_publish({feature: string[]})` — create/update the PR (see §7).

---

## 3. Test DSL (Playwright Test + `ovid` fixture)

Specs live in **`ovid/` at project root**, committed, `*.spec.ts`. Run by ovid's bundled runtime
(project needs no TS setup).

```ts
import { test, expect } from 'ovid';

test('user creates a note that persists', async ({ ovid }) => {
  await ovid.terminal('flask db upgrade', { name: 'api', expect: /migrated/ });
  await ovid.terminal('flask run -p 3001', { name: 'api', waitFor: /Running on .*3001/ });
  await ovid.terminal('npm run web',      { name: 'web', waitFor: /ready on 3000/ });

  await ovid.browser('Create a note', async (page) => {
    await page.goto('http://localhost:3000');
    await page.getByPlaceholder('New note').fill('Buy milk');
    await page.getByText('Save').click();
    await expect(page.getByText('Buy milk')).toBeVisible();
  });

  await ovid.terminal('sqlite3 api/notes.db "select count(*)"', { expect: /1/ });

  await ovid.browser('Note persists after reload', async (page) => {
    await page.reload();
    await expect(page.getByText('Buy milk')).toBeVisible();
  });
});
```

**API**
- `ovid.terminal(cmd, opts)` — opts: `name` (named long-lived pty; enables multi-server),
  `waitFor` (regex to await, for servers), `expect` (regex output must match),
  `exitCode` (default 0 for one-shots), `not` (regex must NOT appear), `caption` (optional;
  shown only if provided), `trim` (collapse idle for this command, e.g. installs).
- `ovid.browser(caption, async (page) => {…})` — explicit browser segment with a caption;
  `page` is a normal Playwright page. Multiple pages (multi-tab) supported.
- **Assertions = truth:** Playwright `expect` (browser) + terminal regex/exit checks.

**N-source model:** each named terminal and each page is a recorded source. The runner tags every
segment `{source, kind, start, end, caption}` into `timeline.json` against a single `t0`. Focus-cut
handles terminal→browser→terminal switches and multi-server/multi-tab for free.

---

## 4. Capture (every run; cheap)

- **Terminal:** own the pty stream.
  Completion via **sentinel marker + exit code** (token stripped from video). Write **asciinema
  v2 `.cast`** directly from pty data. Default timeout **30s → fail with captured output**.
  Default shell **`bash --norc --noprofile`** (ignores user dotfiles for reproducibility; override via `config.shell`).
- **Browser:** Playwright **headless**, one video per page, viewport **1440×900** (configurable).
- **No idle trim by default**; per-command `trim` opt-in.
- Emits `timeline.json`.

---

## 5. Render (lazy — only on failure or publish)

Captured raw sources (`.cast`/`.webm`) are cheap; the ffmpeg merge runs only when a test **fails**
(for debugging) or at **publish** (selected specs).

- **Terminal video:** replay `.cast` in a headless **xterm.js** page (dark theme, mac window
  chrome / traffic-light dots, monospace, commands appear instantly), recorded by Playwright.
- **Merge:** **focus-cut** by timeline — slice each source's active segments, concat in order.
  **Hard cuts.** **Letterbox/pad** to canvas (preserve aspect).
- **Overlays:** caption text only (no source badge). **Cursor + click-ripple** on browser actions.
  **No title/outro cards.**
- **Output:** **720p @ 30fps H.264 mp4** (configurable).
- **GIF:** full walkthrough, capped (~12fps, width-capped).
- **Keyframes:** one per segment + one per assertion (for vision review).

---

## 6. Verify

- **Assertions gate pass/fail** on every run — cheap, deterministic, no LLM on re-runs.
- **One-time vision review** (current session model) on **selected specs** (new specs always;
  modified specs by the agent's judgment). Looks at the keyframes, emits **per-step claims**.
- If the review raises a **visual concern**, the agent **attempts to fix it**, but the test still
  counts as **pass** (assertions remain the source of truth).
- Claims become the PR's "what this shows" bullets — human-auditable next to the video.

---

## 7. Publish (`ovid_publish` / `ovid pr`)

- **PR:** create if none for the branch, else update the ovid section.
- **Results:** a compact **`spec | status` table for ALL specs** at the top.
- **Videos:** per-test sections (inline **gif** + **mp4 link** + claims, no re-run line) for
  **selected specs** — ovid suggests new/modified via git; **new specs always included**, modified
  specs per the agent's judgment.
- **Hosting:** assets on a single reusable **`ovid-media` release**, keyed `branch__test__<sha>`,
  via `gh release upload --clobber`. **No git bloat.** Inline gif renders; mp4 is a click-to-open
  link (GitHub has no API for an inline *player* — accepted).
- **Forks:** assets live on the fork; links work throughout review. Post-fork-deletion link-rot
  **accepted**. No drag-drop hint.
- **Failures:** render up to the failure point, attach to the tool result, **never publish**.
  Only passing tests are published.
- **Missing preconditions** (no pushed branch / no gh auth / on default branch): **fail fast** with
  a clear message and still emit the PR markdown + local artifact paths.

---

## 8. Artifacts & config

- **Artifacts:** `.ovid/runs/<test>/` — `*.cast`, `*.webm`, `timeline.json`, `keyframes/`,
  `final.mp4`, `final.gif`, logs. Ignored via a generated **`.ovid/.gitignore` (`*`)** — no edits
  to the user's files.
- **`ovid.config.ts`** (core + appearance; all optional with defaults):
  `viewport`, `baseURL`, `shell`, `terminalTheme`, `video {width,height,fps}`.
- **Teardown:** spawn terminals in their own process group; kill the group + close the browser on
  teardown/SIGINT; warn on a stuck port.
- **Execution:** serial, fixed ports (parallel documented as future).
- **`ovid init`** scaffolds: `ovid.config.ts`, `ovid/WRITING-OVID-E2E-TESTS.md`, `.ovid/.gitignore`, a
  starter spec.

---

## 9. CLI

- `ovid init` — scaffold a project.
- `ovid test [spec]` — run + assert + capture (lazy render). No LLM. The cheap re-run.
- `ovid render <run>` — (re)merge a polished video from existing raw sources.
- `ovid pr [--feature spec…]` — publish (create/update PR).
- `ovid doctor` — verify environment.

---

## 10. Repo layout

```
ovid/
  package.json                # bin: "ovid"; exports ".", "./pi"
  src/
    runner/{pty,cast,fixture,timeline}.ts
    render/{replay.html,replay,merge,polish,gif}.ts
    pi/{extension,review,publish}.ts
    cli.ts
  examples/notes/             # sample: PROVES all features + cross-language
    api/        # Python (Flask) + SQLite on :3001     (non-JS backend; also exposes
                #   CLI commands, e.g. `flask notes add/list`, for the terminal-only case)
    web/        # JS frontend on :3000
    ovid/
      cli.spec.ts             # terminal-only: exercises the app's own CLI commands
      webapp.spec.ts          # mixed terminal+browser, multi-server, interleaving
  PLAN.md
```

---

## 11. Milestones

| M | Deliverable | Proves |
|---|---|---|
| **M1** | pty/`.cast` manager (sentinel completion) → xterm.js replay → `terminal.mp4` | terminal recording |
| **M2** | Playwright fixture + `timeline.json` + focus-cut merge → combined `final.mp4` | core terminal↔browser video |
| **M3** | polish: caption overlays, cursor+click ripple, letterbox, hard cuts, gif export | PR-quality output |
| **M4** | pi extension: `ovid_test` tool + `before_agent_start` injection + `WRITING-OVID-E2E-TESTS.md` | agent integration |
| **M5** | keyframe vision review → claims + `ovid_publish` (results table + selected videos, release upload) | end-to-end PR |

Each of M2–M5 is demoed against `examples/notes/`. Build order starts at **M1** (riskiest unknown).
