import type { Capture, ChangeKind, Layer } from '@aio/schema';

/**
 * Date pairs and the change set files of a pair (data-conventions section 14): one file per pair
 * and producer, `<from>-<to>-<producer>.json`, the same names the pipeline writer gives
 * (`change_set_id` in `python/src/aio_pipelines/change/changeset.py`).
 */

/** The in-app producers and the item kind each writes. */
export const IN_APP_PRODUCERS = {
  issue: 'issues',
  detection: 'detections',
  vector: 'vectors',
} as const satisfies Partial<Record<ChangeKind, string>>;

export type InAppKind = keyof typeof IN_APP_PRODUCERS;

export const IN_APP_KINDS = Object.keys(IN_APP_PRODUCERS) as InAppKind[];

/** `c1-c2-raster` for `change.raster`: readable, file-name safe, stable per pair. */
export function changeSetId(from: string, to: string, producer: string): string {
  const short = producer.split('.').at(-1) ?? producer;
  const safe = `${from}-${to}-${short}`
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 120);
  if (!safe) throw new Error('A change set needs a name made of letters and digits.');
  return safe;
}

/**
 * What the comparisons need of the project's capture index (`@aio/workspace` `captureIndex`):
 * the captures oldest first, the capture of each dated layer and each layer's slot.
 */
export interface DateIndex {
  captures: readonly Capture[];
  of: Readonly<Record<string, string>>;
  slot: Readonly<Record<string, string>>;
}

/** The two captures in date order (earlier first); null when either is unknown or they are one. */
export function orderPair(
  index: Pick<DateIndex, 'captures'>,
  a: string,
  b: string,
): { from: string; to: string } | null {
  const ia = index.captures.findIndex((c) => c.id === a);
  const ib = index.captures.findIndex((c) => c.id === b);
  if (ia < 0 || ib < 0 || ia === ib) return null;
  return ia < ib ? { from: a, to: b } : { from: b, to: a };
}

/** Layers of one date (explicit `capture` first, then the naming rules). */
export function layersOf(
  index: Pick<DateIndex, 'of'>,
  layers: readonly Layer[],
  capture: string,
): Layer[] {
  return layers.filter((l) => index.of[l.id] === capture);
}

/**
 * Pairs of counterpart layers of one kind on the two dates (same slot; else the only layer of
 * that kind on each date).
 */
export function counterpartPairs<K extends Layer['kind']>(
  index: Pick<DateIndex, 'of' | 'slot'>,
  layers: readonly Layer[],
  kind: K,
  from: string,
  to: string,
): [Extract<Layer, { kind: K }>, Extract<Layer, { kind: K }>][] {
  const ofKind = (c: string) =>
    layers.filter((l): l is Extract<Layer, { kind: K }> => l.kind === kind && index.of[l.id] === c);
  const a = ofKind(from);
  const b = ofKind(to);
  const out: [Extract<Layer, { kind: K }>, Extract<Layer, { kind: K }>][] = [];
  const used = new Set<string>();
  for (const la of a) {
    const lb = b.find((x) => !used.has(x.id) && index.slot[x.id] === index.slot[la.id]);
    if (lb) {
      used.add(lb.id);
      out.push([la, lb]);
    }
  }
  if (out.length === 0 && a.length === 1 && b.length === 1 && a[0] && b[0]) out.push([a[0], b[0]]);
  return out;
}
