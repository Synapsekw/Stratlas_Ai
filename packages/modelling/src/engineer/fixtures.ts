/**
 * Whole-model fixtures of the engineering model (synthetic values only, no real asset): a chimney
 * with four flues, a deck, bands and lights at two levels; a flare stack; a lattice tower; a
 * monopole. Between them they use every assembly kind. Shared by the mesher, validator and
 * assembler tests.
 */
import type {
  Assembly,
  AssemblyKind,
  AssemblyParams,
  ParamQuality,
  ProcModel,
  Vec3,
} from '@aio/schema';
import { newProcModel } from '../procmodel';
import { ctxFor } from './builders/ctx';
import { MeshSink, SEGMENTS, type Opening } from './geom';
import { buildAssembly } from './meshAssemblies';
import { DEFAULT_MATERIALS } from './materials';

type Meta = Partial<
  Pick<Assembly, 'parent' | 'tag' | 'type' | 'material' | 'status' | 'unobserved' | 'description'>
> & { quality?: Record<string, ParamQuality> };

/** One assembly with readable metadata; draft unless `meta.status` says otherwise. */
export function component<K extends AssemblyKind>(
  kind: K,
  id: string,
  category: string,
  params: AssemblyParams<K>,
  meta: Meta = {},
): Assembly {
  const {
    quality = {},
    status = 'draft',
    description = `${category} component ${id}`,
    ...rest
  } = meta;
  const a = {
    id,
    kind,
    params,
    name: id.replace(/-/g, ' '),
    description,
    category,
    status,
    origin: { by: 'manual' },
    quality,
    sources: [],
    ...rest,
  };
  return a as unknown as Assembly;
}

/** A procmodel/2 with the default materials and `assemblies`. */
export function engineeringModel(id: string, name: string, assemblies: Assembly[]): ProcModel {
  return {
    ...newProcModel({ id, name, now: '2026-10-15T00:00:00.000Z' }),
    materials: [...DEFAULT_MATERIALS],
    assemblies,
  };
}

const measured = (residualM: number, coverage: number): ParamQuality => ({
  basis: 'measured',
  residualM,
  support: 400,
  coverage,
});
const inferred: ParamQuality = { basis: 'inferred' };
const observed: ParamQuality = { basis: 'observed' };

/** Outer radius of the chimney shaft at height `y` (linear between profile points). */
const STACK_PROFILE = [
  { y: 0, r: 9 },
  { y: 55, r: 6.5 },
  { y: 120, r: 6.5 },
];
function stackRadiusAt(y: number): number {
  return y >= 55 ? 6.5 : 9 - (2.5 * y) / 55;
}

/**
 * A 120 m chimney, open at the top, `base` its foot: four flues on a 2.6 m circle standing 1 m
 * proud of the windshield, a deck under their mouths, two paint bands, a ring platform with a
 * guardrail, an open hatch on the deck, a louvre and a duct at the foot, and three warning lights
 * at 40 m and at 80 m.
 */
export function stackModel(o: { base?: Vec3 } = {}): ProcModel {
  const [bx, by, bz] = o.base ?? [0, 0, 0];
  const at = (x: number, y: number, z: number): Vec3 => [bx + x, by + y, bz + z];
  const flues = [1, 2, 3, 4].map((i) => {
    const t = (Math.PI / 2) * (i - 1); // north first, then clockwise
    return component(
      'flue',
      `flue-${String(i)}`,
      'Flues',
      {
        centre: at(2.6 * Math.sin(t), 121, -2.6 * Math.cos(t)),
        rOuter: 0.9,
        rInner: 0.8,
        height: 6,
        ...(i === 1 ? { rim: true } : {}),
      },
      {
        parent: 'shaft-1',
        quality: { centre: observed, rOuter: inferred, rInner: inferred, height: inferred },
      },
    );
  });
  const flueHoles = flues.map((f) => {
    const c = f.kind === 'flue' ? f.params.centre : at(0, 0, 0);
    return { centre: [c[0], c[2]] as [number, number], r: 0.92 };
  });
  const lights = [40, 80].flatMap((y, level) =>
    [0, 120, 240].map((azimuth, k) => {
      const t = (azimuth * Math.PI) / 180;
      const out: Vec3 = [Math.sin(t), 0, -Math.cos(t)];
      const size = 0.4;
      const r = stackRadiusAt(y) + size;
      return component(
        'warningLight',
        `light-l${String(level + 1)}-${String(k + 1)}`,
        'Lights',
        { fixture: 'twin', centre: at(r * out[0], y, r * out[2]), outward: out, size },
        { parent: 'shaft-1', quality: { centre: observed, fixture: inferred } },
      );
    }),
  );
  return engineeringModel('stack-test', 'Synthetic chimney', [
    component(
      'shaft',
      'shaft-1',
      'Shaft',
      {
        base: at(0, 0, 0),
        profile: STACK_PROFILE,
        wall: 0.5,
        openTop: true,
        joints: { spacing: 4 },
      },
      {
        tag: 'STK-1',
        type: 'chimney',
        status: 'accepted',
        unobserved: ['interior'],
        quality: {
          base: measured(0.02, 0.9),
          profile: measured(0.035, 0.75),
          wall: inferred,
          openTop: observed,
        },
      },
    ),
    component(
      'band',
      'band-1',
      'Bands',
      { shaft: 'shaft-1', y0: by + 100, y1: by + 104, material: 'paint-red' },
      { parent: 'shaft-1' },
    ),
    component(
      'band',
      'band-2',
      'Bands',
      { shaft: 'shaft-1', y0: by + 108, y1: by + 112, material: 'paint-white' },
      { parent: 'shaft-1' },
    ),
    ...flues,
    component(
      'deck',
      'deck-1',
      'Deck',
      { y: by + 117, outline: { r: 5.9 }, thickness: 0.3, openings: flueHoles },
      { parent: 'shaft-1', unobserved: ['top'] },
    ),
    component(
      'hatch',
      'hatch-1',
      'Access',
      { centre: at(-3.5, 117, 3), size: [0.8, 0.6], open: true },
      { parent: 'deck-1' },
    ),
    component(
      'ringPlatform',
      'platform-1',
      'Access',
      { y: by + 90, rInner: 6.6, rOuter: 7.8, thickness: 0.1, shaft: 'shaft-1' },
      { parent: 'shaft-1' },
    ),
    component(
      'guardrail',
      'guardrail-1',
      'Access',
      { path: { y: by + 90, r: 7.7, shaft: 'shaft-1' }, height: 1.1, posts: 1.5, rails: 2 },
      { parent: 'platform-1' },
    ),
    component(
      'louvre',
      'louvre-1',
      'Openings',
      { centre: at(0, 3, 9.2), normal: [0, 0, 1], size: [1.2, 0.9], blades: 6 },
      { parent: 'shaft-1' },
    ),
    component(
      'duct',
      'duct-1',
      'Lines',
      {
        path: [at(24, 4, 0), at(14, 4, 0), at(9.5, 4, 0)],
        section: { rect: [1.6, 1.2] },
        transition: { at: 1, to: { round: 1.4 } },
        flanges: true,
      },
      { parent: 'shaft-1' },
    ),
    ...lights,
  ]);
}

/**
 * A 60 m flare stack: a solid tapered steel shaft, the tip with a windshield and three pilots, a
 * caged ladder, a platform with a guardrail under the tip, a gas line up the side and a light.
 */
export function flareModel(): ProcModel {
  return engineeringModel('flare-test', 'Synthetic flare', [
    component(
      'shaft',
      'shaft-1',
      'Shaft',
      {
        base: [0, 0, 0],
        profile: [
          { y: 0, r: 1.2 },
          { y: 60, r: 0.8 },
        ],
        openTop: false,
      },
      { material: 'steel-galv', quality: { profile: measured(0.01, 0.8) } },
    ),
    component(
      'flareTip',
      'tip-1',
      'Flare tip',
      { base: [0, 60, 0], r: 0.6, height: 3, windshield: true, pilots: 3 },
      { parent: 'shaft-1' },
    ),
    component(
      'ladder',
      'ladder-1',
      'Access',
      { bottom: [1.5, 0, 0], top: [1.5, 57, 0], width: 0.5, rungSpacing: 0.3, cage: true },
      { parent: 'shaft-1' },
    ),
    component(
      'ringPlatform',
      'platform-1',
      'Access',
      { y: 57, rInner: 0.95, rOuter: 2.4, thickness: 0.1, shaft: 'shaft-1' },
      { parent: 'shaft-1' },
    ),
    component(
      'guardrail',
      'guardrail-1',
      'Access',
      { path: { y: 57, r: 2.3, shaft: 'shaft-1' }, height: 1.1, posts: 1.5, rails: 2 },
      { parent: 'platform-1' },
    ),
    component(
      'pipeRun',
      'pipe-1',
      'Lines',
      {
        path: [
          [-6, 0.5, 0],
          [-1.5, 0.5, 0],
          [-1.5, 56, 0],
        ],
        diameter: 0.2,
        bendRadius: 0.6,
        flanges: [1],
      },
      { parent: 'shaft-1' },
    ),
    component(
      'warningLight',
      'light-crown-1',
      'Lights',
      { fixture: 'beacon', centre: [0, 64.2, 1.8], outward: [0, 0, 1], size: 0.3 },
      { parent: 'tip-1' },
    ),
  ]);
}

/** A 40 m four-legged lattice tower with three panel antennas on sector frames, earthing and a cabinet. */
export function latticeModel(): ProcModel {
  const sectors = [0, 120, 240];
  const toward = (deg: number, r: number, y: number): Vec3 => {
    const t = (deg * Math.PI) / 180;
    return [r * Math.sin(t), y, -r * Math.cos(t)];
  };
  return engineeringModel('lattice-test', 'Synthetic lattice tower', [
    component(
      'lattice',
      'lattice-1',
      'Structure',
      {
        base: [0, 0, 0],
        legs: 4,
        widthBase: 6,
        widthTop: 1.5,
        height: 40,
        bays: [
          ...Array.from({ length: 4 }, () => ({ height: 5, bracing: 'X' as const })),
          ...Array.from({ length: 2 }, () => ({ height: 5, bracing: 'K' as const })),
          ...Array.from({ length: 2 }, () => ({ height: 5, bracing: 'Z' as const })),
        ],
        legSection: 0.2,
        braceSection: 0.1,
      },
      { quality: { height: measured(0.05, 0.6), bays: inferred } },
    ),
    ...sectors.flatMap((deg, k) => [
      component(
        'antennaMount',
        `mount-s${String(k + 1)}`,
        'Antenna mounts',
        {
          kind: 'sector-frame',
          centre: toward(deg, 1.6, 38),
          azimuthDeg: deg,
          size: [1.6, 2.4, 0.5],
        },
        { parent: 'lattice-1' },
      ),
      component(
        'antenna',
        `antenna-s${String(k + 1)}`,
        'Antennas',
        {
          kind: 'panel',
          centre: toward(deg, 2.1, 38),
          azimuthDeg: deg,
          tiltDeg: 2,
          size: [0.3, 1.4, 0.15],
        },
        { parent: `mount-s${String(k + 1)}` },
      ),
    ]),
    component(
      'antenna',
      'dish-1',
      'Antennas',
      {
        kind: 'dish',
        centre: toward(60, 1.5, 30),
        azimuthDeg: 60,
        tiltDeg: 0,
        size: [0.6, 0.6, 0.3],
      },
      { parent: 'lattice-1' },
    ),
    component(
      'earthing',
      'earthing-1',
      'Earthing',
      {
        path: [
          [4.5, 0.05, 4.5],
          [3.3, 0.05, 3.3],
          [3.3, 3, 3.3],
        ],
        diameter: 0.03,
      },
      { parent: 'lattice-1' },
    ),
    component('cabinet', 'cabinet-1', 'Equipment', {
      base: [7, 0, 0],
      size: [1.2, 2, 0.8],
      yawDeg: 90,
    }),
    component(
      'warningLight',
      'light-crown-1',
      'Lights',
      { fixture: 'single', centre: [0, 40.45, 0], outward: [0, 1, 0], size: 0.3 },
      { parent: 'lattice-1' },
    ),
  ]);
}

/** A 30 m twelve-sided monopole on a plinth, with a pipe-mounted antenna, a portal frame and an RRU. */
export function monopoleModel(): ProcModel {
  return engineeringModel('monopole-test', 'Synthetic monopole', [
    component('base', 'plinth-1', 'Foundation', { outline: { r: 1.6 }, y: -1, height: 1 }),
    component(
      'monopole',
      'pole-1',
      'Structure',
      {
        base: [0, 0, 0],
        profile: [
          { y: 0, r: 0.8 },
          { y: 30, r: 0.4 },
        ],
        sides: 12,
      },
      { parent: 'plinth-1', quality: { profile: measured(0.02, 0.85), sides: observed } },
    ),
    component(
      'antennaMount',
      'mount-1',
      'Antenna mounts',
      { kind: 'pipe', centre: [0, 28, -0.9], azimuthDeg: 0, size: [0.1, 3, 0.1] },
      { parent: 'pole-1' },
    ),
    component(
      'antenna',
      'antenna-1',
      'Antennas',
      { kind: 'panel', centre: [0, 28, -1.1], azimuthDeg: 0, tiltDeg: 0, size: [0.3, 1.4, 0.15] },
      { parent: 'mount-1' },
    ),
    component(
      'antenna',
      'rru-1',
      'Antennas',
      { kind: 'rru', centre: [0.5, 26, -0.7], azimuthDeg: 0, tiltDeg: 0, size: [0.3, 0.45, 0.15] },
      { parent: 'pole-1' },
    ),
    component(
      'antenna',
      'omni-1',
      'Antennas',
      { kind: 'omni', centre: [0, 31, 0], azimuthDeg: 0, tiltDeg: 0, size: [0.08, 1.5, 0.08] },
      { parent: 'pole-1' },
    ),
    component(
      'antennaMount',
      'standoff-1',
      'Antenna mounts',
      { kind: 'standoff', centre: [0.9, 24, 0], azimuthDeg: 90, size: [0.6, 0.1, 0.1] },
      { parent: 'pole-1' },
    ),
    component('frame', 'frame-1', 'Structure', {
      kind: 'portal',
      base: [4, 0, 0],
      span: 3,
      height: 2.5,
      yawDeg: 0,
      bays: 2,
      braced: true,
      member: 0.15,
    }),
    component('cabinet', 'cabinet-1', 'Equipment', {
      base: [4, 0, 2],
      size: [1.2, 2, 0.8],
      yawDeg: 0,
    }),
  ]);
}

/** Every fixture model, by name. */
export const FIXTURE_MODELS = {
  stack: stackModel,
  flare: flareModel,
  lattice: latticeModel,
  monopole: monopoleModel,
} as const;

/** Declared openings of each assembly of `model` (model frame), by assembly id; none left out. */
export function openingsOf(
  model: ProcModel,
  detail: keyof typeof SEGMENTS = 'standard',
): Record<string, Opening[]> {
  const ctx = ctxFor(model);
  const out: Record<string, Opening[]> = {};
  for (const a of model.assemblies) {
    const sink = new MeshSink(SEGMENTS[detail]);
    buildAssembly(sink, a, ctx);
    const openings = sink.out().flatMap((p) => p.openings ?? []);
    if (openings.length) out[a.id] = openings;
  }
  return out;
}
