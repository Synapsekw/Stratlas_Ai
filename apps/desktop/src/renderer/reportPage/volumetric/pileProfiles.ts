// A pile's elevation profile for the volumetric report (plan 2026-11-20, D7): the app's own line
// and data path, no stand-in. The line is the pile panel's default (`pileAxis` of the outline on
// the latest date). The surveys along it come from the caller, which cuts them with the report
// page's `sampleProfiles` (the function the survey report cuts a line's profiles with): the latest
// as `current`, the compared date as `earlier`. The base is the pile look's own (`pileBase`),
// sampled at the same stations and kept inside the outline.
//
// Pure but for the samplers it is handed: site coordinates in, a JSON safe profile out. A pile
// whose profile cannot be sampled gives null; nothing throws.
import type { VolumetricPileProfile, VolumetricProfileSeries } from '@aio/project/export';
import type { SitePoint, SurveyMeasurement } from '@aio/schema';
import { pileAxis } from '@aio/survey';
import {
  baseSpecOf,
  buildPileBase,
  heightExtent,
  pileBaseHeights,
  type PileBaseInput,
  type PointsAt,
} from '../../survey/pile/pileBase';
import { gridPoints, insideRing, pileGrid } from '../../survey/pile/pileLook';

/** A surface along a line, as the report page's `sampleProfiles` returns it. */
export interface LineProfile {
  kind?: 'current' | 'earlier' | 'design' | 'base';
  date?: string;
  chainage: number[];
  z: (number | null)[];
}

/** A survey date a profile line is of. */
export interface ProfileDate {
  id: string;
  date: string;
}

export interface PileProfileSource {
  /** The pile: its first comparison names its base (none: the Toe surface, as the pile look). */
  m: Pick<SurveyMeasurement, 'items'>;
  /** Its boundary as drawn on the latest date (site coordinates, with its own heights). */
  ring: readonly SitePoint[];
  latest: ProfileDate;
  /** The date the report compares with, or null with one date. */
  compared: ProfileDate | null;
  /** The surveys along the line: the latest as `current`, the compared one as `earlier`. */
  surfaces: (
    line: readonly [readonly [number, number], readonly [number, number]],
  ) => Promise<readonly LineProfile[]>;
  /** The latest survey's ground under drawn points; null when that date has no prepared surface. */
  ground: PointsAt | null;
}

/** Millimetres are enough on a printed chart, and keep the model small. */
const mm = (v: number): number => Math.round(v * 1000) / 1000;
const heights = (zs: readonly (number | null)[]): (number | null)[] =>
  zs.map((v) => (v !== null && Number.isFinite(v) ? mm(v) : null));
const sampled = (p: LineProfile | undefined): p is LineProfile =>
  p?.z.some((v) => v !== null && Number.isFinite(v)) === true;

/** One pile's profile, or null when it cannot be sampled. */
export async function pileProfile(src: PileProfileSource): Promise<VolumetricPileProfile | null> {
  const { ring, ground } = src;
  if (ring.length < 3 || !ground) return null;
  try {
    const axis = pileAxis(ring);
    if (!(axis.lengthM > 0)) return null;
    const a: [number, number] = [axis.a[0], axis.a[1]];
    const b: [number, number] = [axis.b[0], axis.b[1]];
    const lines = await src.surfaces([a, b]);
    const current = lines.find((l) => l.kind === 'current');
    if (!sampled(current)) return null;
    const earlier = src.compared ? lines.find((l) => l.kind === 'earlier') : undefined;
    const chainage = current.chainage.map(mm);

    // the stations the surveys were cut at, and the pile look's own grid over the boundary
    const n = current.chainage.length;
    const grid = pileGrid(ring);
    const gp = gridPoints(grid);
    const es = new Float64Array(n + gp.es.length);
    const ns = new Float64Array(n + gp.ns.length);
    for (let k = 0; k < n; k++) {
      const s = (current.chainage[k] ?? 0) / axis.lengthM;
      es[k] = a[0] + (b[0] - a[0]) * s;
      ns[k] = a[1] + (b[1] - a[1]) * s;
    }
    es.set(gp.es, n);
    ns.set(gp.ns, n);

    // the base as the pile look builds it: on the latest ground, the levels inside read off the grid
    const zs = await ground(gp.es, gp.ns);
    const input: PileBaseInput = {
      spec: baseSpecOf(src.m),
      ring,
      step: grid.step,
      at: ground,
      interior: () => heightExtent(zs),
    };
    const own = (await buildPileBase(input)) !== null;
    const base = await pileBaseHeights(input, es, ns);
    // under the pile only: a base has no meaning past the boundary
    const under = (k: number): number | null => {
      const v = base[k] ?? Number.NaN;
      return Number.isFinite(v) && insideRing(es[k] ?? 0, ns[k] ?? 0, ring) ? v : null;
    };
    const baseZ = Array.from({ length: n }, (_, k) => under(k));
    const level = heightExtent(
      Array.from({ length: gp.es.length }, (_, k) => under(n + k) ?? Number.NaN),
    );

    const series: VolumetricProfileSeries[] = [
      {
        kind: 'current',
        capture: src.latest.id,
        date: src.latest.date,
        chainage,
        z: heights(current.z),
      },
    ];
    if (src.compared && sampled(earlier) && earlier.z.length === n)
      series.push({
        kind: 'earlier',
        capture: src.compared.id,
        date: src.compared.date,
        chainage: [...chainage],
        z: heights(earlier.z),
      });
    if (baseZ.some((v) => v !== null))
      series.push({ kind: 'base', chainage: [...chainage], z: heights(baseZ) });
    return {
      a,
      b,
      lengthM: axis.lengthM,
      series,
      baseLevel: level ? [mm(level[0]), mm(level[1])] : null,
      baseKind: own ? 'own' : 'boundary',
    };
  } catch (e) {
    console.warn('Report: a pile profile could not be sampled and is left out', e);
    return null;
  }
}
