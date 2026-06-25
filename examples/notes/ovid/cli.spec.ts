import { test } from "@srinivasa314/ovid/test";

test("flask notes CLI manages notes end to end", async ({ ovid }) => {
  await ovid.terminal("rm -f api/notes.db", {
    name: "Setup",
    caption: "Start with a clean SQLite database",
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes list)", {
    name: "CLI",
    expect: /\(no notes yet\)/,
    caption: "Listing an empty notebook shows a friendly message",
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes --help)", {
    name: "CLI",
    expect: /Manage notes from the terminal\.[\s\S]*add[\s\S]*list/,
    caption: "The notes command exposes add and list subcommands",
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes add 'Buy milk')", {
    name: "CLI",
    expect: /Added #1: Buy milk/,
    caption: "Add the first note from the Flask CLI",
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes add 'Call <Mom> & Dad')", {
    name: "CLI",
    expect: /Added #2: Call <Mom> & Dad/,
    caption: "Add a second note containing punctuation and HTML-like text",
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes list)", {
    name: "CLI",
    expect: /#1  Buy milk[\s\S]*#2  Call <Mom> & Dad/,
    caption: "List shows every note in insertion order with stable IDs",
  });

  await ovid.terminal("sqlite3 api/notes.db \"select count(*) from notes; select body from notes order by id;\"", {
    name: "DB",
    expect: /2\s+Buy milk\s+Call <Mom> & Dad/,
    caption: "CLI writes the expected rows to SQLite",
  });

  await ovid.terminal("(cd api && ../.venv/bin/flask --app app notes add)", {
    name: "CLI",
    exitCode: 2,
    expect: /Missing argument 'BODY'/,
    caption: "The CLI rejects add without the required note body",
  });
});
