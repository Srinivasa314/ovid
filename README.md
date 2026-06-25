# ovid

ovid makes [pi](https://github.com/earendil-works/pi) verify the features it builds and record a polished terminal + browser videos of each verification onto your PR. The verifications are ordinary code (assertions decide pass/fail), so re-running them is cheap and no LLM is needed.

Works on any-language projects (Node is only needed to run ovid). Today it plugs into the pi coding agent; support for others (Codex, Claude Code) may come later.

## Quick start

```bash
cd your-project
npm i -D @srinivasa314/ovid       # Node ≥20; also needs Chromium (`npx playwright install chromium`) and `gh`
npx ovid init                     # scaffolds config, the spec guide, and the pi extension
```

Then use pi as normal. (Note: You have to trust the project the first time so the extension loads or pass `-a` in headless/CI). When you ask the agent to build something and open a PR, it will, on its own:

- write and run an ovid e2e test for the change,
- review the recorded keyframes
- attach the terminal+browser video + per-step notes to the PR

New tests are always shown with a video; tests it only *modified* are included at its discretion.

## Features

- Terminal + browser in one video, stitched on a shared timeline as a focus-cut (cuts to whichever surface is active).
- Multiple terminals (named, long-lived shells) and multiple browser tabs/pages in a single test.
- Polished output: mac window chrome, titlebar labels, lower-third captions, a moving cursor + click-ripple, readable pacing
- configurable (viewport, video size/fps, pacing) via `ovid.config.ts`.
- Lazy rendering: videos are produced only when you need them, like when a PR is created or a test fails so passing runs stay fast.

## Using the ovid CLI (without an agent)

You can drive ovid yourself too but its primarily for agents. Write specs in `ovid/*.spec.ts`, use `ovid.terminal(cmd, opts)` for shells and `ovid.browser(caption, fn)` for a Playwright page. The full docs are in `ovid/WRITING-OVID-E2E-TESTS.md`.

| Command | What it does |
| --- | --- |
| `npx ovid init` | Scaffold config, guide, `.gitignore`, pi extension |
| `npx ovid test [filter]` | Run specs (records raw artifacts; videos render lazily — only on failure) |
| `npx ovid render [filter]` | Render saved runs into `final.mp4`/`.gif` (e.g. to view a passing run) |
| `npx ovid publish [--apply]` | Extract keyframes / upload media + create-or-update the PR |
| `npx ovid doctor` | Check external components (Chromium, ffmpeg, git, gh) |

## How it works

A generated spec looks like this:

```ts
import { test, expect } from "@srinivasa314/ovid/test";

test("note persists", async ({ ovid }) => {
  await ovid.terminal("flask --app api/app.py run -p 3001", { name: "API", waitFor: /Running on/ });
  await ovid.browser("Create a note", async (page) => {
    await page.goto("http://localhost:3000");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Buy milk")).toBeVisible();
  });
});
```

A spec drives terminals and browsers and asserts behavior in code. ovid runs it while recording the real shell and the live browser against a shared timeline, then stitches a video showing them, then overlays window chrome, captions, and a cursor.

Built with: node-pty + an asciinema cast replayed in headless xterm.js (terminal), @playwright/test + playwright-recorder-plus (browser), a timeline-driven focus-cut composited with ffmpeg.

## Sample

`examples/notes/` a Flask API + SQLite + vanilla web UI application and a `flask notes` CLI, with ovid specs covering both multi-server and  mixed terminal+browser flows.

## Scope

v0 targets macOS, local, single-machine. Parallel execution, Linux/CI, and remote runs are future work.
