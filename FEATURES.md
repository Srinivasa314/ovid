# ovid — features & implementation (running list)

> Living document. Folded into the README at the end. Updated as milestones land.

## Features

### Core
- **Test videos that capture terminal + browser** in one polished, timeline-accurate video.
- **Tests-as-code** — committed specs, re-runnable cheaply with **no LLM**.
- **Assertions = truth** — pass/fail from code, not vibes: terminal `expect` / `exitCode` / `not`, plus Playwright `expect` for the browser.
- **Mixed, interleaved workflows** — terminal → browser → terminal, etc., stitched as a **focus-cut** (cut to whichever surface is active).

### Terminal
- **Multiple named terminals** (`name`) — each its own long-lived shell; servers and one-shot commands coexist.
- **Server mode** (`waitFor`) vs **one-shot** commands (marker + exit code).
- **Per-terminal titlebar labels** (`Terminal: API`); bare `Terminal` when unnamed.

### Browser
- **Multiple browser blocks / pages** (multi-tab / multi-window) — each recorded independently.
- **Browser windows in matching mac chrome**, titlebar shows the **URL** by default or an explicit `title`.
- **Cursor + click-ripple** overlay so interactions are visible.

### Cross-language
- **Works on any-language projects** (Python / Go / Rust / …). Node is required only to *run ovid*, never added to the project under test.

### Output & polish
- **Mac window chrome** (rounded window, traffic-light dots, shadow) on both terminal and browser.
- **Lower-third captions** per step.
- **Pacing** — terminal freeze-hold dwell; browser slowMo + end-hold (so instant localhost ops are watchable).
- **MP4 + GIF** outputs (gif capped fps/width for inline PR embedding).
- **Configurable** (viewport, pacing, theme, video size) — *config file lands in M4*.

### CLI & agent integration (M4 Stage 1)
- **`npx ovid init`** — scaffolds `ovid.config.ts`, the test-writing guide, `.ovid/.gitignore`, the pi extension at `.pi/extensions/ovid.ts`, and records ovid as a project devDependency.
- **`npx ovid test [filter] [--json]`** — runs specs via a generated Playwright config; `--json` emits a structured summary (used by the agent).
- **pi extension** — registers an `ovid_test` tool the agent calls; injects the *implement → test → fix* workflow into the system prompt (only when the project is ovid-initialized).

### PR publishing (M4 Stage 2)
- **`npx ovid publish`** — prepares results + extracts keyframes (LLM-free); `--apply` uploads the mp4/gif to a reusable `ovid-media` GitHub release and creates/updates the PR (idempotent, single `<!-- ovid -->` section).
- **PR body** — a results table for all specs + per-featured-spec section: inline gif, mp4 link, and agent-written per-step claims.
- **The agent reviews the recorded keyframes.** ovid extracts one keyframe per step (from that step's freeze-held end state); the agent *looks at those images* to confirm the behavior and write the per-step claims. The CLI itself stays LLM-free.
- **The agent chooses which videos to attach.** *New* specs are always featured with a video; *modified* specs are flagged as suggested (detected via git) and the agent **decides** whether to include each one; unchanged specs are skipped.
- **`ovid_publish` tool** — review-then-publish: call 1 returns the keyframes; the agent reviews; call 2 publishes with claims (+ PR title/summary).
- **Auto-attach on PR** — the extension blocks a raw `gh pr create` and routes it through `ovid_publish`, so opening a PR always attaches the e2e video.

## Using ovid with pi

The pi extension (`.pi/extensions/ovid.ts`, written by `npx ovid init`) is **project-local**, so pi loads it only after the project is **trusted**:

- **Interactive:** the first time you run `pi` in the project, accept the trust prompt (or run `/trust` once). The `ovid_test` / `ovid_publish` tools and the workflow then load automatically.
- **Non-interactive / headless / CI (`pi -p`, `--mode json`):** there is no trust prompt — pass **`-a` / `--approve`** to trust for that run (or set `defaultProjectTrust: "always"` in `~/.pi/agent/settings.json`). Without trust, pi silently ignores the extension and its ovid tools are unavailable.

Once loaded, the agent: writes/runs ovid tests for features, and when it opens a PR (a raw `gh pr create` is **blocked and redirected** to `ovid_publish`) it attaches the e2e video + per-step claims automatically.

### Planned (later)
- Runs on macOS and Linux (on Linux: node-pty builds from source, and rendering uses a system ffmpeg with drawtext).
- Parallel execution, CI, remote — future.

## Technical implementation

- **Language/build:** TypeScript (ESM), `tsup` build, `tsc` typecheck. Specs run via Playwright Test's built-in TS.
- **Packaging:** single `ovid` package (CLI/lib + pi extension entry); self-contained, no toolchain added to the target repo.
- **Terminal capture:** `node-pty` runs a real shell; an **invisible private OSC marker** in `PROMPT_COMMAND` carries the exit code and is stripped from the recording; output written as a self-authored **asciinema v2 `.cast`**.
- **Terminal render:** the `.cast` is replayed in **headless xterm.js** (mac chrome, bundled JetBrains Mono, scale-to-fit) and recorded.
- **Browser:** `@playwright/test` fixture; live recording via **playwright-recorder-plus** (CDP screencast at JPEG q100 → H.264) — *not* Playwright's built-in `recordVideo` (hardcoded low-bitrate VP8 = blurry/flicker).
- **Browser chrome:** the chrome HTML is screenshotted once with a magenta content hole and **cached per resolution**; each clip is **ffmpeg colorkey-composited** into it (identical chrome to terminals, single encode).
- **Timeline:** one shared monotonic clock; records per-terminal cast offsets and `{source, kind, start, end, caption, title}` segments → `timeline.json`.
- **Merge (focus-cut):** per segment, slice (terminal) or whole (browser) → normalize/letterbox to 1280×720 → `drawtext` captions/titles → `tpad` freeze-hold → **CFR re-encode concat** (hard cuts).
- **ffmpeg:** all compositing uses bundled **ffmpeg-static** (has `drawtext`/libfreetype); **no system ffmpeg required**.
- **Fonts:** JetBrains Mono — woff2 (xterm) + TTF (ffmpeg drawtext), bundled & base64-inlined where needed.
- **Artifacts:** `.ovid/runs/<test>/` (self-ignored via generated `.ovid/.gitignore`); chrome overlay cached in `.ovid/cache/`.
- **Sample app:** `examples/notes/` — Flask API + SQLite (:3001) + vanilla web UI via `http.server` (:3000) + a `flask notes` CLI; proves cross-language and multi-server.
