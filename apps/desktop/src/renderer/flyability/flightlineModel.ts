import type { Layer, Vec3 } from '@aio/schema';
import { assetUrl, autoDateColour } from '@aio/workspace';

/*
 * A flight line of a confined-space drone flight (data-conventions section 40): the drone's
 * path from the flight's `aio.flight/1` pose file, drawn as a line in the 3D view. The pose
 * file's `pos` is in the scene frame already (the Python job wrote it through `to_scene`), so
 * the polyline is the positions as they are.
 */

export type FlightlineLayer = Extract<Layer, { kind: 'flightline' }>;

/** Samples closer than this to the last one kept are merged, metres. */
const MERGE_M = 0.05;

/** The polyline of a flight's samples, scene metres, `x y z` per point, near-duplicates merged. */
export function flightlinePoints(samples: readonly { t: number; pos: Vec3 }[]): Float32Array {
  const out: number[] = [];
  for (const s of samples) {
    const [x, y, z] = s.pos;
    if (![x, y, z].every(Number.isFinite)) continue;
    const n = out.length;
    if (n >= 3) {
      const d = Math.hypot(x - (out[n - 3] ?? 0), y - (out[n - 2] ?? 0), z - (out[n - 1] ?? 0));
      if (d < MERGE_M) continue;
    }
    out.push(x, y, z);
  }
  return Float32Array.from(out);
}

/** The line's colour: the one set on the layer, else the survey-date palette by flight order. */
export function flightlineColour(layer: Pick<FlightlineLayer, 'color'>, order: number): string {
  return layer.color ?? `var(--date-${String(autoDateColour(order))})`;
}

const cache = new Map<string, { src: string; points: Float32Array }>();

/** Fetch and build a flight line's polyline (once per layer and file); null when unreadable. */
export async function loadFlightline(
  projectId: string,
  layer: FlightlineLayer,
): Promise<Float32Array | null> {
  const src = JSON.stringify(layer.src);
  const known = cache.get(layer.id);
  if (known?.src === src) return known.points;
  try {
    const res = await fetch(assetUrl(projectId, layer.src));
    if (!res.ok) return null;
    const json = (await res.json()) as { samples?: { t: number; pos: Vec3 }[] };
    if (!Array.isArray(json.samples)) return null;
    const points = flightlinePoints(json.samples);
    cache.set(layer.id, { src, points });
    return points;
  } catch {
    return null;
  }
}

/** Forget what was loaded (tests; a project switch). */
export function clearFlightlines(): void {
  cache.clear();
}
