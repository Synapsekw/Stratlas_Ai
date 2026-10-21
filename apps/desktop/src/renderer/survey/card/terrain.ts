/**
 * The terrain under a measurement, read once for its card (the panel's, the Volumes view's and the
 * report's). The readouts (`@aio/survey` `allRows`) ask a synchronous `HeightSampler`; a large
 * polygon asks it for tens of thousands of heights, and the 3D stage answers each with a raycast
 * through every triangle of the terrain (about 16 ms on a real survey's mesh), which held the
 * window for minutes. So the card first records where the readouts sample (`collect`), reads all
 * of those places in one go from a prepared surface's tiles, or from the stage a slice at a time
 * (`sliced`), and answers the readouts from what was read (`answer`). The readouts sample the same
 * places whatever heights they get, so the second pass asks exactly what the first recorded.
 */
import type { MeasurementTool } from '@aio/schema';
import { DEFAULT_ITEMS, PRIMARY_KEY, SECONDARY_KEYS, type HeightSampler } from '@aio/survey';

/** The readout rows worked out from the surface under the measurement. */
export const SURFACE_ROWS: ReadonlySet<string> = new Set([
  'surface-z',
  'dz',
  'terrain-length',
  'terrain-area',
  'crest-z',
  'crest-width',
  'base-width',
  'height-left',
  'height-right',
]);

/**
 * Whether a card of `tool` shows a row read from the surface: its primary row, its secondary line
 * or its readout (the template's `items`, else the tool's default). A pile's card shows none.
 */
export function readsSurface(tool: MeasurementTool, items?: readonly string[]): boolean {
  const shown = [
    PRIMARY_KEY[tool],
    ...SECONDARY_KEYS[tool],
    ...(items && items.length > 0 ? items : DEFAULT_ITEMS[tool]),
  ];
  return shown.some((k) => SURFACE_ROWS.has(k));
}

/** Heights at many places at once; NaN where there is no data. */
export type SampleMany = (es: Float64Array, ns: Float64Array) => Promise<ArrayLike<number>>;

/** Where a computation samples a surface, each place once. */
export interface Asked {
  es: Float64Array;
  ns: Float64Array;
}

const keyOf = (e: number, n: number) => `${String(e)},${String(n)}`;

/** Run `ask` with every height 0 and record the places it samples, each once. */
export function collect(ask: (h: HeightSampler) => void): Asked {
  const seen = new Set<string>();
  const es: number[] = [];
  const ns: number[] = [];
  ask({
    heightAt: (e, n) => {
      const k = keyOf(e, n);
      if (!seen.has(k)) {
        seen.add(k);
        es.push(e);
        ns.push(n);
      }
      return 0;
    },
  });
  return { es: Float64Array.from(es), ns: Float64Array.from(ns) };
}

/** A sampler that answers the places `asked` recorded with the heights read there (null: none). */
export function answer(asked: Asked, zs: ArrayLike<number | null>): HeightSampler {
  const at = new Map<string, number | null>();
  asked.es.forEach((e, k) => {
    const z = zs[k];
    at.set(
      keyOf(e, asked.ns[k] ?? NaN),
      z !== null && z !== undefined && Number.isFinite(z) ? z : null,
    );
  });
  return { heightAt: (e, n) => at.get(keyOf(e, n)) ?? null };
}

/** `collect`, read every place with `sample`, then `answer`. */
export async function presample(
  ask: (h: HeightSampler) => void,
  sample: SampleMany,
): Promise<HeightSampler> {
  const asked = collect(ask);
  const zs = asked.es.length > 0 ? await sample(asked.es, asked.ns) : new Float64Array();
  return answer(asked, zs);
}

/** Read every place with a synchronous sampler at once (a few places: no slicing needed). */
export function sampleNow(h: HeightSampler, asked: Asked): Float64Array {
  return Float64Array.from(asked.es, (e, k) => h.heightAt(e, asked.ns[k] ?? NaN) ?? NaN);
}

const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Many places from a synchronous sampler (the 3D stage's raycasts), a slice of at most about
 * `sliceMs` at a time, handing the main thread back between slices so the window keeps drawing
 * and answering. An abort stops it between samples (rejecting with the signal's reason).
 */
export function sliced(
  h: HeightSampler,
  opts: { sliceMs?: number; signal?: AbortSignal; yieldTo?: () => Promise<void> } = {},
): SampleMany {
  const sliceMs = opts.sliceMs ?? 12;
  const yieldTo = opts.yieldTo ?? nextTask;
  return async (es, ns) => {
    const out = new Float64Array(es.length);
    let start = performance.now();
    for (let k = 0; k < es.length; k++) {
      if (performance.now() - start >= sliceMs) {
        await yieldTo();
        start = performance.now();
      }
      opts.signal?.throwIfAborted();
      out[k] = h.heightAt(es[k] ?? NaN, ns[k] ?? NaN) ?? NaN;
    }
    return out;
  };
}
