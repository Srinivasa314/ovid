import { readFile, writeFile } from "node:fs/promises";

/** A single asciinema v2 output event: [time-in-seconds, "o", data]. */
export type CastEvent = [number, "o", string];

export interface ParsedCast {
  width: number;
  height: number;
  events: CastEvent[];
}

/**
 * Writes an asciinema v2 cast directly from a pty stream. We own the stream,
 * so rather than shelling out to the `asciinema` binary we record events with a
 * monotonic clock and serialize the well-documented v2 line format ourselves.
 */
export class CastWriter {
  private events: CastEvent[] = [];
  private startNs: bigint | null = null;

  constructor(
    public readonly cols: number,
    public readonly rows: number,
  ) {}

  /** Begin the timeline. The first recorded event sits at t=0. */
  start(): void {
    this.startNs = process.hrtime.bigint();
  }

  write(data: string): void {
    if (this.startNs === null) this.start();
    const elapsed = Number(process.hrtime.bigint() - this.startNs!) / 1e9;
    this.events.push([Number(elapsed.toFixed(6)), "o", data]);
  }

  get lastTime(): number {
    return this.events.length ? this.events[this.events.length - 1][0] : 0;
  }

  async save(path: string): Promise<void> {
    const header = {
      version: 2,
      width: this.cols,
      height: this.rows,
      timestamp: Math.floor(Date.now() / 1000),
      env: { SHELL: "/bin/bash", TERM: "xterm-256color" },
    };
    const lines = [JSON.stringify(header), ...this.events.map((e) => JSON.stringify(e))];
    await writeFile(path, lines.join("\n") + "\n", "utf8");
  }
}

export async function parseCast(path: string): Promise<ParsedCast> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = JSON.parse(lines[0]) as { width: number; height: number };
  const events = lines.slice(1).map((l) => JSON.parse(l) as CastEvent);
  return { width: header.width, height: header.height, events };
}
