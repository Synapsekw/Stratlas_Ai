// Test helpers for the walk fit: the synthetic walk fixtures of @aio/schema and their ground truth
// (the values of tools/fixtures/walk-truth.mjs, repeated here so the tests stay typed). Expected
// positions come from the fixture's own raw stills through the inverse of the truth, never from
// the nominal walk (its last still stops short of the corner).
import { readFileSync } from 'node:fs';
import { readWalkOrientationData, WalkOrientation, WalkRawPath } from '@aio/schema';
import type { WalkPin } from '@aio/schema';

const dir = new URL('../../../schema/src/__fixtures__/walk/', import.meta.url);

export const GROUND_TRUTH = { rotDeg: 37, scale: 0.23, shift: [3, -1, 7] } as const;
export const GROUND_TRUTH_SEGMENT_1 = { rotDeg: 112, scale: 0.31, shift: [-5, 2, 1] } as const;

export function loadRaw(name: 'synthetic' | 'broken'): WalkRawPath {
  return WalkRawPath.parse(
    JSON.parse(readFileSync(new URL(`raw-path.${name}.json`, dir), 'utf8')) as unknown,
  );
}

/** A closed square, with metric raw coordinates and no placement heading. */
export function closedRaw(): WalkRawPath {
  const raw = loadRaw('synthetic');
  return {
    ...raw,
    walking: { startT: 0, endT: 4 },
    stills: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ].map(([x = 0, z = 0], t) => ({
      n: t * 30,
      t,
      pos: [x, 0, z],
      q: [0, 0, 0, 1],
      segment: 0,
      steps: t,
    })),
  };
}

export function loadOrientationRows(): Float64Array[] {
  const header = WalkOrientation.parse(
    JSON.parse(readFileSync(new URL('orientation.synthetic.json', dir), 'utf8')) as unknown,
  );
  const rows = readWalkOrientationData(
    header,
    new Uint8Array(readFileSync(new URL(header.data, dir))),
  );
  if (!rows) throw new Error('orientation fixture refused');
  return rows;
}

interface Truth {
  rotDeg: number;
  scale: number;
  shift: readonly number[];
}

/** Model `[x, z]` of a raw position under `truth` (inverse of `scale * Ry(rot) * p + shift`). */
export function rawToModel(pos: readonly number[], truth: Truth): [number, number] {
  const a = (truth.rotDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = ((pos[0] ?? 0) - (truth.shift[0] ?? 0)) / truth.scale;
  const z = ((pos[2] ?? 0) - (truth.shift[2] ?? 0)) / truth.scale;
  return [c * x - s * z, s * x + c * z];
}

/** The true model `[x, z]` at t: the registered stills around t, inverted and interpolated. */
export function truthXZ(raw: WalkRawPath, t: number): [number, number] {
  const reg = raw.stills.filter((s) => s.pos);
  let i = 0;
  while (i + 1 < reg.length && (reg[i + 1]?.t ?? Infinity) <= t) i++;
  const a = reg[i];
  const b = reg[i + 1] ?? a;
  if (!a?.pos || !b?.pos) throw new Error('no registered still');
  const truth = (seg: number | undefined) => (seg === 1 ? GROUND_TRUTH_SEGMENT_1 : GROUND_TRUTH);
  const pa = rawToModel(a.pos, truth(a.segment));
  const pb = rawToModel(b.pos, truth(b.segment));
  const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  return [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f];
}

/** A '@model' pin at the true position of t, optionally pushed off by `[dx, dz]`. */
export function pinAtTruth(raw: WalkRawPath, t: number, off: [number, number] = [0, 0]): WalkPin {
  const [x, z] = truthXZ(raw, t);
  return { t, surface: '@model', at: [x + off[0], z + off[1]] };
}

export const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));

export const lastT = (raw: WalkRawPath): number => raw.stills[raw.stills.length - 1]?.t ?? 0;

export const noDrawings = { drawing: () => null };
