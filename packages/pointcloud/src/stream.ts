/**
 * Streaming schedule: how much decoded point data reaches the GPU per frame, and how often the
 * level of detail is reselected while the camera moves. Pure: no three.js, no I/O.
 *
 * Decoded nodes arrive from the workers in bursts. Attaching each one as its message lands puts
 * every geometry creation, buffer upload and bookkeeping pass of a burst into one frame; the
 * upload queue spreads them over frames under a byte and time budget instead.
 */

/** GPU bytes attached per frame (a few nodes; one node always goes even when larger). */
export const UPLOAD_BYTES_PER_FRAME = 6 * 2 ** 20;
/** Main-thread time spent attaching nodes per frame, ms (checked between nodes). */
export const UPLOAD_MS_PER_FRAME = 4;
/** Reselect the level of detail at most this often while the camera moves, ms. */
export const LOD_INTERVAL_MS = 100;
/** Publish point counts, classes and the elevation range at most this often while streaming, ms. */
export const STATS_INTERVAL_MS = 250;

interface Entry<T> {
  item: T;
  bytes: number;
  /** Lower goes first (octree depth: coarse nodes cover the view before fine ones). */
  rank: number;
  seq: number;
}

/** Decoded items waiting for the GPU, taken a frame's budget at a time. */
export class UploadQueue<T> {
  private entries: Entry<T>[] = [];
  private seq = 0;

  constructor(
    readonly bytesPerFrame = UPLOAD_BYTES_PER_FRAME,
    readonly msPerFrame = UPLOAD_MS_PER_FRAME,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  /** Bytes waiting. */
  get bytes(): number {
    let n = 0;
    for (const e of this.entries) n += e.bytes;
    return n;
  }

  push(item: T, bytes: number, rank = 0): void {
    this.entries.push({ item, bytes, rank, seq: this.seq++ });
  }

  /** Drops the items `drop` accepts; returns them. */
  remove(drop: (item: T) => boolean): T[] {
    const out: T[] = [];
    this.entries = this.entries.filter((e) => {
      if (!drop(e.item)) return true;
      out.push(e.item);
      return false;
    });
    return out;
  }

  /**
   * Hands this frame's items to `attach`, lowest rank first then oldest, while the bytes stay
   * within the budget and the time spent (by `now`) within `msPerFrame`. The first item always
   * goes, so a node larger than the budget still lands. Returns the bytes attached.
   */
  drain(attach: (item: T) => void, now: () => number = () => performance.now()): number {
    if (!this.entries.length) return 0;
    this.entries.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    const t0 = now();
    let bytes = 0;
    let taken = 0;
    for (const e of this.entries) {
      if (taken > 0 && (bytes + e.bytes > this.bytesPerFrame || now() - t0 >= this.msPerFrame))
        break;
      bytes += e.bytes;
      taken++;
      attach(e.item);
    }
    this.entries.splice(0, taken);
    return bytes;
  }

  clear(): T[] {
    const out = this.entries.map((e) => e.item);
    this.entries = [];
    return out;
  }
}

/** True at most once per `intervalMs`: `due(now)` checks, `mark(now)` starts a new interval. */
export class IntervalGate {
  private last = -Infinity;

  constructor(readonly intervalMs: number) {}

  due(now: number): boolean {
    return now - this.last >= this.intervalMs;
  }

  mark(now: number): void {
    this.last = now;
  }

  /** The next call to `due` passes. */
  reset(): void {
    this.last = -Infinity;
  }
}
