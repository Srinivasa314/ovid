# examples/notes — ovid sample app

A tiny notes app used to demonstrate ovid end-to-end:

- **`api/`** — Flask + SQLite backend (REST on `:3001`, plus a `flask notes` CLI). Non-JS, to prove ovid drives any language.
- **`web/`** — vanilla HTML/JS UI, served statically on `:3000`.

## One-time setup (prerequisite)

```bash
python3 -m venv examples/notes/.venv
examples/notes/.venv/bin/pip install -r examples/notes/api/requirements.txt
```

The `.venv` is gitignored. Setup is a prerequisite (like `npm install`) — it is **not** part of the recorded test.

## Run by hand

```bash
# terminal 1 — API
cd examples/notes/api && ../.venv/bin/flask --app app run -p 3001

# terminal 2 — web UI
cd examples/notes/web && python3 -m http.server 3000

# CLI (terminal-only)
cd examples/notes/api && ../.venv/bin/flask --app app notes add "Buy milk"
../.venv/bin/flask --app app notes list
../.venv/bin/flask --app app notes search milk
```

Then open http://localhost:3000.

## ovid specs

- `ovid/webapp.spec.ts` — mixed terminal + browser (start servers, add a note in the UI, assert it persisted in SQLite, reload).
- `ovid/cli.spec.ts` — terminal-only (`flask notes add/list`).
- `ovid/search.spec.ts` — full-text search across the REST API, web UI, and CLI.
