import { test, expect } from "@srinivasa314/ovid/test";

test("web UI creates, escapes, reloads, and shares persisted notes", async ({ ovid }) => {
  await ovid.terminal("rm -f api/notes.db", {
    name: "Setup",
    caption: "Reset the notes database before the web flow",
  });

  await ovid.terminal("cd api && ../.venv/bin/flask --app app run -p 3001", {
    name: "API",
    waitFor: /Running on .*3001/,
    caption: "Start the Flask REST API on port 3001",
  });

  await ovid.terminal("cd web && python3 -m http.server 3000", {
    name: "Web",
    waitFor: /Serving HTTP on .*3000/,
    caption: "Serve the static web UI on port 3000",
  });

  await ovid.browser("Use the Notes UI from an empty state", async (page) => {
    await page.goto("http://localhost:3000");
    await expect(page).toHaveTitle("Notes");
    await expect(page.getByRole("heading", { name: "📝 Notes" })).toBeVisible();
    await expect(page.locator("#counter")).toHaveText("0 notes");
    await expect(page.getByText("No notes yet — add one above.")).toBeVisible();

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#list li")).toHaveCount(1);
    await expect(page.getByText("No notes yet — add one above.")).toBeVisible();

    await page.getByPlaceholder("New note").fill("   ");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#list li")).toHaveCount(1);
    await expect(page.getByText("No notes yet — add one above.")).toBeVisible();
  });

  await ovid.browser("Create notes by clicking Save and pressing Enter", async (page) => {
    await page.goto("http://localhost:3000");

    await page.getByPlaceholder("New note").fill("Buy milk");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByPlaceholder("New note")).toHaveValue("");
    await expect(page.locator("#counter")).toHaveText("1 note");
    await expect(page.locator("#list li")).toHaveText(["Buy milk"]);

    const special = 'Read <Ovid> & write "tests"';
    await page.getByPlaceholder("New note").fill(special);
    await page.getByPlaceholder("New note").press("Enter");
    await expect(page.locator("#counter")).toHaveText("2 notes");
    await expect(page.locator("#list li")).toHaveText(["Buy milk", special]);

    await page.reload();
    await expect(page.locator("#counter")).toHaveText("2 notes");
    await expect(page.locator("#list li")).toHaveText(["Buy milk", special]);
  });

  await ovid.terminal("sqlite3 api/notes.db \"select count(*) from notes; select body from notes order by id;\"", {
    name: "DB",
    expect: /2\s+Buy milk\s+Read <Ovid> & write "tests"/,
    caption: "The browser-created notes persisted to SQLite in order",
  });

  await ovid.terminal("cd api && ../.venv/bin/flask --app app notes add 'CLI-created note'", {
    name: "CLI",
    expect: /Added #3: CLI-created note/,
    caption: "Add a note through the Flask CLI while the web app is running",
  });

  await ovid.browser("Reload the browser and see the CLI-created note", async (page) => {
    await page.goto("http://localhost:3000");
    await expect(page.locator("#counter")).toHaveText("3 notes");
    await expect(page.locator("#list li")).toHaveText([
      "Buy milk",
      'Read <Ovid> & write "tests"',
      "CLI-created note",
    ]);
  });

  await ovid.terminal("curl -s -o - -w '\\n%{http_code}' -X POST http://localhost:3001/notes -H 'Content-Type: application/json' -d '{\"body\":\"   \"}'", {
    name: "API check",
    expect: /body required[\s\S]*400/,
    caption: "The API rejects blank notes with a 400 response",
  });
});
