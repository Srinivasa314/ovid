import { test, expect } from "@srinivasa314/ovid/test";

test("search works across API, web UI, and Flask CLI", async ({ ovid }) => {
  await ovid.terminal("rm -f api/notes.db", {
    name: "Setup",
    caption: "Reset the notes database before the search flow",
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

  await ovid.terminal("curl -s -X POST http://localhost:3001/notes -H 'Content-Type: application/json' -d '{\"body\":\"Buy oat milk\"}' && echo && curl -s -X POST http://localhost:3001/notes -H 'Content-Type: application/json' -d '{\"body\":\"Plan summer picnic\"}' && echo && curl -s -X POST http://localhost:3001/notes -H 'Content-Type: application/json' -d '{\"body\":\"Milk frother cleaning\"}'", {
    name: "Seed",
    expect: /Buy oat milk[\s\S]*Plan summer picnic[\s\S]*Milk frother cleaning/,
    caption: "Create three notes through the JSON API",
  });

  await ovid.terminal("curl -s 'http://localhost:3001/notes/search?q=milk'", {
    name: "API check",
    expect: /Buy oat milk[\s\S]*Milk frother cleaning/,
    not: /Plan summer picnic/,
    caption: "The search endpoint returns only notes matching the query",
  });

  await ovid.browser("Filter notes in the web UI with the search box", async (page) => {
    await page.goto("http://localhost:3000");
    await expect(page.locator("#counter")).toHaveText("3 notes");
    await expect(page.locator("#list li")).toHaveText([
      "Buy oat milk",
      "Plan summer picnic",
      "Milk frother cleaning",
    ]);

    await page.getByPlaceholder("Search notes").fill("milk");
    await expect(page.locator("#counter")).toHaveText("2 matching notes");
    await expect(page.locator("#list li")).toHaveText(["Buy oat milk", "Milk frother cleaning"]);

    await page.getByPlaceholder("Search notes").fill("zzz");
    await expect(page.locator("#counter")).toHaveText("0 matching notes");
    await expect(page.getByText("No matching notes.")).toBeVisible();
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes search milk)", {
    name: "CLI",
    expect: /#1  Buy oat milk[\s\S]*#3  Milk frother cleaning/,
    not: /Plan summer picnic/,
    caption: "The Flask CLI search subcommand prints the same matches",
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes search zzz)", {
    name: "CLI",
    expect: /\(no matching notes\)/,
    caption: "The Flask CLI reports when no notes match",
  });
});
