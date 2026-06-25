export type SegmentKind = "terminal" | "browser";

export interface Segment {
  kind: SegmentKind;
  /** Terminal name, or "browser". */
  source: string;
  /** Seconds since the timeline origin. */
  start: number;
  end: number;
  caption?: string;
  /** For browser segments: the recorded clip path. */
  clip?: string;
  /** For browser segments: the titlebar text (URL by default, or explicit). */
  title?: string;
}

/**
 * One shared monotonic clock for a test run. Terminal casts and browser clips
 * each have their own internal time axis; the timeline records, against a single
 * origin, when every segment happened and where each terminal's cast began, so
 * the merge can slice the right window out of each source video.
 */
export class Timeline {
  private readonly t0 = process.hrtime.bigint();
  private readonly terminalOffsets = new Map<string, number>();
  private readonly terminalLabels = new Map<string, string>();
  readonly segments: Segment[] = [];

  /** Seconds elapsed since the timeline origin. */
  now(): number {
    return Number(process.hrtime.bigint() - this.t0) / 1e9;
  }

  /** Record when a terminal's cast recording began (relative to the origin) and its titlebar label. */
  registerTerminal(name: string, castStartMono: bigint, label: string): void {
    this.terminalOffsets.set(name, Number(castStartMono - this.t0) / 1e9);
    this.terminalLabels.set(name, label);
  }

  terminalOffset(name: string): number {
    return this.terminalOffsets.get(name) ?? 0;
  }

  add(segment: Segment): void {
    this.segments.push(segment);
  }

  toJSON(): TimelineJSON {
    return {
      terminals: Object.fromEntries(this.terminalOffsets),
      labels: Object.fromEntries(this.terminalLabels),
      segments: this.segments,
    };
  }
}

export interface TimelineJSON {
  terminals: Record<string, number>;
  labels: Record<string, string>;
  segments: Segment[];
}
