import { spawn, type IPty } from "node-pty";
import { randomBytes } from "node:crypto";
import { CastWriter } from "./cast.js";
import { killTreeSync } from "./kill.js";

// Private OSC marker: ESC ] 5379 ; <nonce> ; <exitcode> BEL
// Emitted (invisibly) by bash's PROMPT_COMMAND before every prompt. We parse it
// live to learn command boundaries + exit codes, then strip it from the cast so
// the rendered video never shows it. The nonce guards against the (unlikely)
// case of program output containing the same OSC code.
const OSC_PREFIX = "\x1b]5379;";
const BEL = "\x07";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RunResult {
  command: string;
  exitCode: number;
  output: string;
}

export interface RunOptions {
  /** Milliseconds before the command is considered timed out. */
  timeout?: number;
}

export interface ServerOptions {
  /** Resolve once this regex appears in the output (e.g. /listening on 3000/). */
  waitFor: RegExp;
  timeout?: number;
}

export class Terminal {
  private readonly pty: IPty;
  private readonly nonce = randomBytes(6).toString("hex");
  private readonly markerRe: RegExp;
  private readonly cast: CastWriter;

  private residual = "";
  private recording = false;
  private currentOutput = "";
  private lastExit = 0;

  private ready = false;
  private readyResolve?: () => void;
  private pending: { resolve: (code: number) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private pendingWait: { re: RegExp; resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private castStartMono = 0n;

  constructor(
    public readonly cols = 100,
    public readonly rows = 30,
  ) {
    this.markerRe = new RegExp(`\\x1b\\]5379;${this.nonce};(-?\\d+)\\x07`);
    this.cast = new CastWriter(cols, rows);
    this.pty = spawn("bash", ["--norc", "--noprofile", "-i"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color", PROMPT_COMMAND: "" },
    });
    this.pty.onData((d) => this.onData(d));
  }

  /**
   * Configure the shell (invisible completion marker + a clean green prompt),
   * wait for it to be ready, then begin recording from a freshly redrawn prompt.
   */
  async setup(): Promise<void> {
    // Double-quote the printf format so it nests inside the single-quoted
    // PROMPT_COMMAND without a quote collision.
    const promptCommand = `printf "\\033]5379;${this.nonce};%s\\007" "$?"`;
    const ps1 = `\\[\\e[32m\\]$\\[\\e[0m\\] `;
    this.write(`PROMPT_COMMAND='${promptCommand}'; PS1='${ps1}'\n`);
    await this.waitReady(10_000);

    // Start the cast on a clean slate: Ctrl-L (form feed) makes readline clear
    // the screen and redraw the prompt without echoing a command.
    this.castStartMono = process.hrtime.bigint();
    this.cast.start();
    this.recording = true;
    this.pty.write("\f");
    await delay(250);
  }

  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    const timeout = opts.timeout ?? 30_000;
    this.currentOutput = "";
    this.pty.write(command + "\n");
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(
          new Error(
            `Timed out after ${timeout}ms running: ${command}\n--- output so far ---\n${this.currentOutput}`,
          ),
        );
      }, timeout);
      this.pending = { resolve, timer };
    });
    return { command, exitCode, output: this.currentOutput };
  }

  /**
   * Start a long-running process (e.g. a dev server) and resolve once `waitFor`
   * matches its output. The process is left running in this pty (so this pty is
   * now occupied); it is killed on dispose().
   */
  async start(command: string, opts: ServerOptions): Promise<void> {
    const timeout = opts.timeout ?? 30_000;
    this.currentOutput = "";
    this.pty.write(command + "\n");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWait = null;
        reject(
          new Error(
            `Timed out after ${timeout}ms waiting for ${opts.waitFor} from: ${command}\n` +
              `--- output so far ---\n${this.currentOutput}`,
          ),
        );
      }, timeout);
      this.pendingWait = { re: opts.waitFor, resolve: () => { clearTimeout(timer); resolve(); }, timer };
    });
  }

  /** Monotonic timestamp (hrtime ns) when this terminal's cast recording began. */
  get castStart(): bigint {
    return this.castStartMono;
  }

  /** OS pid of the shell process backing this terminal. */
  get pid(): number {
    return this.pty.pid;
  }

  /** Let the trailing prompt/output land in the cast before we stop. */
  async settle(ms = 400): Promise<void> {
    await delay(ms);
  }

  async save(path: string): Promise<void> {
    await this.cast.save(path);
  }

  dispose(): void {
    // Kill the whole descendant tree, not just the shell: a server started via
    // start()/{ waitFor } runs in its own (foreground job) process group, and
    // node-pty's kill() only signals the shell — so killing the shell alone
    // would orphan the server. Snapshot + SIGKILL the tree, then kill the shell
    // as a backstop.
    try {
      killTreeSync(this.pty.pid);
    } catch {
      /* best-effort */
    }
    try {
      this.pty.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  // --- internals ---

  private write(data: string): void {
    this.pty.write(data);
  }

  private onData(chunk: string): void {
    const clean = this.parse(chunk);
    if (clean.length && this.recording) {
      this.currentOutput += clean;
      this.cast.write(clean);
      if (this.pendingWait && this.pendingWait.re.test(this.currentOutput)) {
        const w = this.pendingWait;
        this.pendingWait = null;
        w.resolve();
      }
    }
  }

  /** Strip complete markers (handling chunk-split markers) and return clean text. */
  private parse(chunk: string): string {
    let buf = this.residual + chunk;
    this.residual = "";
    let out = "";
    for (;;) {
      const start = buf.indexOf(OSC_PREFIX);
      if (start === -1) {
        const hold = this.tailPrefixIndex(buf);
        if (hold !== -1) {
          out += buf.slice(0, hold);
          this.residual = buf.slice(hold);
        } else {
          out += buf;
        }
        break;
      }
      out += buf.slice(0, start);
      const end = buf.indexOf(BEL, start);
      if (end === -1) {
        this.residual = buf.slice(start); // incomplete marker; wait for more
        break;
      }
      const marker = buf.slice(start, end + 1);
      const m = marker.match(this.markerRe);
      if (m) this.handleMarker(parseInt(m[1], 10));
      buf = buf.slice(end + 1);
    }
    return out;
  }

  /** If buf ends with a strict prefix of the marker start, return that index. */
  private tailPrefixIndex(buf: string): number {
    const max = Math.min(OSC_PREFIX.length - 1, buf.length);
    for (let k = max; k > 0; k--) {
      if (buf.endsWith(OSC_PREFIX.slice(0, k))) return buf.length - k;
    }
    return -1;
  }

  private handleMarker(code: number): void {
    this.lastExit = code;
    if (!this.ready) {
      this.ready = true;
      this.readyResolve?.();
    }
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const resolve = this.pending.resolve;
      this.pending = null;
      resolve(code);
    }
  }

  private waitReady(timeout = 10_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.ready) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`shell did not become ready within ${timeout}ms`)),
        timeout,
      );
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
