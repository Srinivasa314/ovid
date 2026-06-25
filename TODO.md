# TODO

- [ ] **Agent guide (M4):** in `WRITING-OVID-E2E-TESTS.md` + the `before_agent_start`
  injection, strongly encourage giving `ovid.terminal` a `name` when a test uses
  more than one terminal (so the video's titlebars read "Terminal: API" etc.).
  A single-terminal test can omit it (titlebar shows bare "Terminal").
- [ ] **Remove `demo:terminal`** — it's M1 scaffolding only (a smoke test for the
  pty → `.cast` → xterm.js replay → mp4 pipeline). Replace with the real spec-driven
  CLI surface in M4 (`ovid test`, `ovid_test` tool). Tracked from the M1 build.
