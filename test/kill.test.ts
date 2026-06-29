import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { collectDescendants, killTreeSync } from "../src/runner/kill.js";

/** True while `pid` exists (signal 0 probes without killing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `fn` is true or we time out. */
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

/**
 * Spawn a node process that itself spawns a long-lived grandchild, then prints
 * both pids. Returns { parent, child } once both are known. The parent stays
 * alive (it keeps a timer), so the grandchild is a true descendant, not an
 * orphan, when we snapshot.
 */
function spawnTree(): Promise<{ parent: import("node:child_process").ChildProcess; child: number }> {
  const code = `
    const cp = require("node:child_process");
    const g = cp.spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" });
    process.stdout.write(g.pid + "\\n");
    setInterval(() => {}, 1e9);
  `;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const line = out.split("\n")[0].trim();
      if (line) resolve({ parent: p, child: Number(line) });
    });
    p.on("error", reject);
  });
}

test("collectDescendants: finds a grandchild under the root", async () => {
  const { parent, child } = await spawnTree();
  try {
    const desc = collectDescendants(parent.pid!);
    assert.ok(desc.includes(child), `expected descendants ${JSON.stringify(desc)} to include ${child}`);
  } finally {
    killTreeSync(parent.pid);
  }
});

test("killTreeSync: kills the root and the whole descendant tree", async () => {
  const { parent, child } = await spawnTree();
  assert.ok(alive(parent.pid!), "parent should be alive before kill");
  assert.ok(alive(child), "child should be alive before kill");

  const killed = killTreeSync(parent.pid);
  assert.ok(killed.includes(parent.pid!), "root pid should be in the kill set");
  assert.ok(killed.includes(child), "grandchild pid should be in the kill set");

  assert.ok(await until(() => !alive(parent.pid!)), "parent should be dead after killTreeSync");
  assert.ok(await until(() => !alive(child)), "grandchild should be dead after killTreeSync");
});

test("killTreeSync: ignores invalid roots (never signals pid <= 1)", () => {
  assert.deepEqual(killTreeSync(undefined), []);
  assert.deepEqual(killTreeSync(0), []);
  assert.deepEqual(killTreeSync(1), []);
});
