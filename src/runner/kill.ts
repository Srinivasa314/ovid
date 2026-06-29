import { execFileSync } from "node:child_process";

// Synchronous, best-effort process-tree termination. Used to reap orphans that a
// bare kill of a parent would miss: interactive bash puts foreground jobs in their
// own process group, and node-pty's kill() only signals the shell — so dev servers
// started via `ovid.terminal(.., { waitFor })` (npm/vite/nodemon/flask reloaders)
// survive unless we walk the descendant tree by ppid and kill each pid.
//
// macOS + Linux only (the supported platforms); relies on `ps -A -o pid=,ppid=`.

/** Parent-pid → child-pids map from a single `ps` snapshot. */
function processMap(): Map<number, number[]> {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const arr = children.get(ppid);
    if (arr) arr.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/**
 * All descendant pids of `root` (excluding `root`), breadth-first so parents come
 * before their children. Returns [] if the process table can't be read.
 */
export function collectDescendants(root: number): number[] {
  let map: Map<number, number[]>;
  try {
    map = processMap();
  } catch {
    return [];
  }
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const child of map.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** SIGKILL (or `signal`) each pid, best-effort. Never touches pid ≤ 1. */
export function killPids(pids: Iterable<number>, signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of pids) {
    if (!pid || pid <= 1) continue;
    try {
      process.kill(pid, signal);
    } catch {
      /* ESRCH (already gone) / EPERM — best-effort */
    }
  }
}

/**
 * Kill `root` and every descendant. Snapshots the tree first (after the root dies,
 * children reparent to pid 1 and the ppid linkage is lost), then kills root→leaves
 * by pid — so reparenting can't save anything in the snapshot. Returns the pids it
 * attempted to kill. Synchronous, so it is safe to call from a `process.on("exit")`
 * handler. A pid ≤ 1 is ignored (never signal the whole process group / init).
 */
export function killTreeSync(root: number | undefined, signal: NodeJS.Signals = "SIGKILL"): number[] {
  if (!root || root <= 1) return [];
  const all = [root, ...collectDescendants(root)];
  killPids(all, signal);
  return all;
}
