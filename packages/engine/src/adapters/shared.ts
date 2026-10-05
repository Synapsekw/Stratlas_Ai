/**
 * Assets shared between stages: when two 3D views show the same file (the comparison of two
 * dates keeps the main view's layers loaded), the file is fetched and parsed once. Entries are
 * counted; the last release frees the value.
 */

export interface Lease<T> {
  readonly value: T;
  /** Give the value back; the last holder's release frees it. Safe to call twice. */
  release(): void;
}

interface Entry<T> {
  promise: Promise<T>;
  refs: number;
  value: T | undefined;
  settled: boolean;
}

export interface SharedStats {
  /** Keys held now, with their holder counts. */
  held: Record<string, number>;
  /** Loads started (a miss). */
  loads: number;
  /** Acquires served by a load already made or running (a hit). */
  hits: number;
}

export class SharedAssets<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private loads = 0;
  private hits = 0;

  constructor(private readonly free: (value: T) => void) {}

  /** The value for `key`, loading it with `load` unless another holder has it already. */
  async acquire(key: string, load: () => Promise<T>): Promise<Lease<T>> {
    let entry = this.entries.get(key);
    if (entry) this.hits++;
    else {
      this.loads++;
      const fresh: Entry<T> = { promise: load(), refs: 0, value: undefined, settled: false };
      entry = fresh;
      this.entries.set(key, fresh);
      fresh.promise.then(
        (v) => {
          fresh.value = v;
          fresh.settled = true;
          // every holder let go while it loaded
          if (fresh.refs === 0 && this.entries.get(key) !== fresh) this.free(v);
        },
        () => {
          if (this.entries.get(key) === fresh) this.entries.delete(key);
        },
      );
    }
    entry.refs++;
    const held = entry;
    let value: T;
    try {
      value = await held.promise;
    } catch (e) {
      held.refs--;
      throw e;
    }
    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        this.drop(key, held);
      },
    };
  }

  private drop(key: string, entry: Entry<T>): void {
    entry.refs--;
    if (entry.refs > 0) return;
    if (this.entries.get(key) === entry) this.entries.delete(key);
    if (entry.settled && entry.value !== undefined) this.free(entry.value);
  }

  stats(): SharedStats {
    const held: Record<string, number> = {};
    for (const [k, e] of this.entries) held[k] = e.refs;
    return { held, loads: this.loads, hits: this.hits };
  }
}
