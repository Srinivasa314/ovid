import { test } from "node:test";
import assert from "node:assert/strict";
import { Terminal } from "../src/runner/pty.js";
import { collectDescendants } from "../src/runner/kill.js";

/** True while `pid` exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

// The actual bug: a long-lived server started via `ovid.terminal(.., { waitFor })`
// runs in its own (foreground job) process group inside the shell. dispose() must
// take the whole tree down, not just the shell.
test("Terminal.dispose(): kills a long-lived server started in the shell", async () => {
  const term = new Terminal();
  await term.setup();

  // A trivial long-lived node server; print a line so `waitFor` resolves.
  const cmd = `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(0,()=>console.log('LISTENING'))"`;
  await term.start(cmd, { waitFor: /LISTENING/, timeout: 15_000 });

  // The server is a descendant of the shell pid while the shell is alive.
  const descendants = collectDescendants(term.pid);
  const servers = descendants.filter((pid) => alive(pid));
  assert.ok(servers.length > 0, "expected at least one live descendant (the node server)");

  term.dispose();

  assert.ok(await until(() => !alive(term.pid)), "shell should be dead after dispose");
  for (const pid of servers) {
    assert.ok(await until(() => !alive(pid)), `server pid ${pid} should be dead after dispose`);
  }
});
