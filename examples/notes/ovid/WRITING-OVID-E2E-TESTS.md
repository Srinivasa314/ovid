# Writing ovid e2e tests

ovid records a polished video (terminal + browser) of a test **and** asserts behavior in code.
Specs live in `ovid/*.spec.ts` and run with `ovid test`. Assertions decide pass/fail; the video is for humans.

## Skeleton
```ts
import { test, expect } from "ovid/test";

test("user can save a note", async ({ ovid }) => {
  // ovid.terminal(...) and ovid.browser(...) steps
});
```

## ovid.terminal(command, opts?)
Runs `command` in a shell.
- `name?` — named long-lived terminal (its own shell). **Give distinct names when a test uses more than one terminal** (titlebar shows `Terminal: <name>`; unnamed → `Terminal`). Reuse a name to run more commands in that shell.
- `waitFor?: RegExp` — **server mode**: resolves once output matches, leaving the process running (e.g. a dev server). A foreground server occupies its terminal — use a different `name` for other commands.
- `expect?: RegExp` — output must match.
- `not?: RegExp` — output must NOT match.
- `exitCode?: number` — required exit code (defaults to 0 when no other assertion).
- `caption?` — caption shown under the step.
- `timeout?` — ms (default 30000).

## ovid.browser(caption, async (page) => { ... }, opts?)
Drives a Playwright `page` (full Playwright API). `caption` is shown under the step.
Titlebar shows the page URL by default; override with `opts.title`. Assert with Playwright `expect`.

## Example (multi-terminal + browser)
```ts
import { test, expect } from "ovid/test";

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
```

## Rules of thumb
- Commands run from the project root (cwd of `ovid test`); use paths relative to it.
- Servers are killed automatically when the test ends.
- Each terminal/browser block becomes one video segment — keep them focused.
- Run all specs with `ovid test`, or one with `ovid test <name-substring>`.
