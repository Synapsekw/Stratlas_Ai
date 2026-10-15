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
  Detail,
  EngineerProposal,
  EngineerSetup,
  EvidencePack,
  MemberGroup,
  ModelFamily,
  ParamQuality,
  ProcModel,
  ProposalComponent,
  Vec3,
} from '@aio/schema';
import { newProcModel } from '../procmodel';
import { ctxFor, profileRadiusAt } from './builders/ctx';
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

// ---------------------------------------------------------------------------------------------
// Evidence packs and proposals with their synthetic truth (the assembler's inputs). Heights are
// above the asset base; a member's `size` is its diameter. None of it describes a real asset.
// ---------------------------------------------------------------------------------------------

/** The synthetic chimney the stack evidence and proposal describe. The last light level is the crown. */
export const STACK_TRUTH = {
  height: 120,
  profile: [
    { y: 0, r: 9 },
    { y: 55, r: 6.5 },
    { y: 120, r: 6.5 },
  ],
  flues: 3,
  fluePitchR: 2.6,
  lightLevels: [40, 80, 120],
  lightsPerLevel: 3,
  bands: [
    [100, 104],
    [108, 112],
  ] as [number, number][],
};
/** Flue azimuths (none at north, so the id order is not the input order) and their radius. */
const STACK_FLUE_AZ = [30, 150, 270];
const STACK_FLUE_R = 0.9;
const STACK_LIGHT_AZ = [0, 120, 240];
const STACK_LIGHT_SIZE = 0.4;

const toward = (b: Vec3, deg: number, r: number, h: number): Vec3 => {
  const t = (deg * Math.PI) / 180;
  return [b[0] + r * Math.sin(t), b[1] + h, b[2] - r * Math.cos(t)];
};

interface PackSpec {
  base: Vec3;
  height: number;
  profile: { y: number; r: number }[];
  coverage: number;
  shape?: 'circle' | 'square';
  members: MemberGroup[];
  colours?: EvidencePack['colours'];
  suggested: ModelFamily;
  fillRatio: number;
  topFeatures: number;
  kept: number;
}

/** A metric evidence pack from a cloud: 25 slices, the taper, the members, no photos. */
function pack(s: PackSpec): EvidencePack {
  const [bx, by, bz] = s.base;
  const rMax = Math.max(...s.profile.map((q) => q.r));
  const partial = s.coverage < 0.5;
  const slices = Array.from({ length: 25 }, (_, i) => {
    const h = (s.height * i) / 24;
    return {
      y: by + h,
      centre: [bx, bz] as [number, number],
      // a deterministic few millimetres of fit noise
      r: profileRadiusAt(s.profile, h) * (1 + 0.002 * Math.sin(i * 1.7)),
      residualM: partial ? 0.06 : 0.03,
      support: partial ? 180 : 400,
      coverage: s.coverage,
      shape: s.shape ?? 'circle',
    };
  });
  return {
    schema: 'aio.evidence/1',
    run: 'run-synthetic',
    crs: null,
    units: 'm',
    crop: { centre: [bx, bz], radiusM: rMax * 4 },
    bounds: { min: [bx - rMax, by, bz - rMax], max: [bx + rMax, by + s.height + 2, bz + rMax] },
    samples: { read: Math.round(s.kept * 2.5), kept: s.kept, ground: Math.round(s.kept / 20) },
    axis: { point: [bx, by, bz], dir: [0, 1, 0], tiltDeg: 0 },
    base: [bx, by, bz],
    height: s.height,
    slices,
    taper: {
      profile: s.profile.map((q) => ({ y: by + q.y, r: q.r * 1.003 })),
      residualM: partial ? 0.05 : 0.025,
    },
    members: s.members,
    familyHints: {
      fillRatio: s.fillRatio,
      slenderness: s.height / (2 * rMax),
      topFeatures: s.topFeatures,
      suggested: s.suggested,
    },
    colours: s.colours ?? [],
    photos: [],
    images: [],
    reconstruction: 'not-needed',
    warnings: [],
  };
}

const item = (centre: Vec3, size: number, azimuthDeg?: number, support = 300) => ({
  centre,
  size,
  support,
  ...(azimuthDeg === undefined ? {} : { azimuthDeg }),
});

/**
 * Evidence of the synthetic chimney, its base at `base` (default the origin). `partial`: a scan
 * from the north only (slice coverage under a half, the lights on the far side unseen; the flues
 * on the crown are all seen).
 */
export function stackEvidence(o: { partial?: boolean; base?: Vec3 } = {}): EvidencePack {
  const b = o.base ?? [0, 0, 0];
  const T = STACK_TRUTH;
  const seen = (az: number) => !o.partial || az <= 90 || az >= 270;
  const lights = T.lightLevels.flatMap((h) =>
    STACK_LIGHT_AZ.filter(seen).map((az) =>
      item(
        toward(b, az, profileRadiusAt(T.profile, h) + STACK_LIGHT_SIZE, h),
        STACK_LIGHT_SIZE,
        az,
        60,
      ),
    ),
  );
  return pack({
    base: b,
    height: T.height,
    profile: T.profile,
    coverage: o.partial ? 0.45 : 0.9,
    members: [
      {
        kind: 'flue',
        items: STACK_FLUE_AZ.map((az) =>
          item(toward(b, az, T.fluePitchR, T.height + 1), 2 * STACK_FLUE_R, az, 500),
        ),
        metrics: { residualM: 0.02, regularity: 0.95 },
      },
      { kind: 'light-candidate', items: lights, metrics: { regularity: o.partial ? 0.4 : 0.9 } },
    ],
    colours: [
      { y0: b[1], y1: b[1] + 100, rgb: [150, 148, 140] },
      { y0: b[1] + 100, y1: b[1] + 104, rgb: [190, 40, 35] },
      { y0: b[1] + 104, y1: b[1] + 108, rgb: [150, 148, 140] },
      { y0: b[1] + 108, y1: b[1] + 112, rgb: [235, 235, 230] },
      { y0: b[1] + 112, y1: b[1] + T.height, rgb: [150, 148, 140] },
    ],
    suggested: 'chimney',
    fillRatio: 0.7,
    topFeatures: T.flues,
    kept: 900_000,
  });
}

const proposed = (
  c: Omit<ProposalComponent, 'imageIds' | 'observed' | 'units'> &
    Partial<Pick<ProposalComponent, 'units' | 'observed'>>,
): ProposalComponent => ({ units: 'ratio', imageIds: ['img-side-1'], observed: true, ...c });

function proposal(
  family: ModelFamily,
  reason: string,
  components: ProposalComponent[],
): EngineerProposal {
  return {
    family: { value: family, reasons: [reason] },
    identity: { sameAsset: true, conflicts: [] },
    components,
    unresolved: [],
    notes: '',
  };
}

/**
 * The AI proposal for the synthetic chimney, lengths as ratios of its height. `flues` the flue
 * count it reports; `levels` the light levels it reports, in metres above the base (default the
 * truth's, the crown included).
 */
export function stackProposal(o: { flues?: number; levels?: number[] } = {}): EngineerProposal {
  const T = STACK_TRUTH;
  const H = T.height;
  const [p0, p1] = [T.profile[0], T.profile[1]];
  return proposal('chimney', 'A tapered concrete shaft with flues standing out of its top.', [
    proposed({
      role: 'shaft',
      kind: 'shaft',
      count: 1,
      params: { rBase: (p0?.r ?? 1) / H, rTop: (p1?.r ?? 1) / H, taperTop: (p1?.y ?? H) / H },
    }),
    proposed({
      role: 'flue',
      kind: 'flue',
      count: o.flues ?? T.flues,
      params: { rOuter: STACK_FLUE_R / H, pitchR: T.fluePitchR / H },
    }),
    proposed({
      role: 'band',
      kind: 'band',
      count: T.bands.length,
      params: { width: 4 / H, colours: 'red,white' },
      levels: T.bands.map(([y0]) => y0 / H),
    }),
    proposed({
      role: 'light',
      kind: 'warningLight',
      count: T.lightsPerLevel,
      params: { fixture: 'twin', size: STACK_LIGHT_SIZE / H },
      levels: (o.levels ?? T.lightLevels).map((y) => y / H),
    }),
  ]);
}

/** A synthetic flare stack: a tapered riser, a tip, a caged ladder, a platform and a gas line. */
export const FLARE_TRUTH = {
  height: 60,
  profile: [
    { y: 0, r: 1.2 },
    { y: 60, r: 0.8 },
  ],
  tipR: 0.6,
  tipHeight: 3,
  pilots: 3,
  platformLevels: [57],
  ladder: true,
  serviceLines: 1,
};

export function flareEvidence(): EvidencePack {
  const T = FLARE_TRUTH;
  return pack({
    base: [0, 0, 0],
    height: T.height,
    profile: T.profile,
    coverage: 0.85,
    members: [
      {
        kind: 'platform',
        items: T.platformLevels.map((h) => item([0, h, 0], 4.8, undefined, 800)),
        metrics: { residualM: 0.03 },
      },
    ],
    suggested: 'flare',
    fillRatio: 0.5,
    topFeatures: 1,
    kept: 400_000,
  });
}

export function flareProposal(): EngineerProposal {
  const T = FLARE_TRUTH;
  const H = T.height;
  const [p0, p1] = [T.profile[0], T.profile.at(-1)];
  return proposal('flare', 'A slender steel stack with a flare tip and pilot burners.', [
    proposed({
      role: 'shaft',
      kind: 'shaft',
      count: 1,
      params: { rBase: (p0?.r ?? 1) / H, rTop: (p1?.r ?? 1) / H },
    }),
    proposed({
      role: 'tip',
      kind: 'flareTip',
      count: 1,
      params: { r: T.tipR / H, height: T.tipHeight / H, windshield: true, pilots: T.pilots },
    }),
    proposed({ role: 'ladder', kind: 'ladder', count: 1, params: { cage: true } }),
    proposed({
      role: 'platform',
      kind: 'ringPlatform',
      count: 1,
      params: { guardrail: true },
      levels: T.platformLevels.map((y) => y / H),
    }),
    proposed({
      role: 'gas-line',
      kind: 'pipeRun',
      count: T.serviceLines,
      params: { diameter: 0.15 / H, azimuthDeg: 270 },
    }),
  ]);
}

/**
 * A synthetic four-legged lattice tower with three antenna sectors, two panels side by side in
 * each (`antennaSpread` apart across the sector, `antennaR` out from the axis).
 */
export const LATTICE_TRUTH = {
  height: 40,
  legs: 4 as const,
  widthBase: 6,
  widthTop: 1.5,
  bays: 8,
  sectors: [0, 120, 240],
  antennasPerSector: 2,
  antennaSpread: 0.8,
  antennaR: 2.1,
  antennaY: 38,
};

export function latticeEvidence(): EvidencePack {
  const T = LATTICE_TRUTH;
  const b: Vec3 = [0, 0, 0];
  const h = T.widthBase / 2;
  const corners: [number, number][] = [
    [h, h],
    [h, -h],
    [-h, -h],
    [-h, h],
  ];
  return pack({
    base: b,
    height: T.height,
    profile: [
      { y: 0, r: T.widthBase / 2 },
      { y: T.height, r: T.widthTop / 2 },
    ],
    coverage: 0.8,
    shape: 'square',
    members: [
      {
        kind: 'leg',
        items: corners.map(([x, z]) => item([x, 0, z], 0.2)),
        metrics: { residualM: 0.02, regularity: 0.97 },
      },
      {
        kind: 'antenna-candidate',
        items: T.sectors.flatMap((az) =>
          [-1, 1].map((side) => {
            const c = toward(b, az, T.antennaR, T.antennaY);
            const across = toward([0, 0, 0], az + 90, (side * T.antennaSpread) / 2, 0);
            return item([c[0] + across[0], c[1], c[2] + across[2]], 1.4, az);
          }),
        ),
        metrics: { regularity: 0.9 },
      },
    ],
    suggested: 'telecom-lattice',
    fillRatio: 0.15,
    topFeatures: T.sectors.length,
    kept: 350_000,
  });
}

export function latticeProposal(): EngineerProposal {
  const T = LATTICE_TRUTH;
  const H = T.height;
  return proposal('telecom-lattice', 'An open steel lattice with sector antennas at the top.', [
    proposed({
      role: 'lattice',
      kind: 'lattice',
      count: 1,
      params: {
        legs: T.legs,
        bays: T.bays,
        widthBase: T.widthBase / H,
        widthTop: T.widthTop / H,
        bracing: 'X',
      },
    }),
    proposed({
      role: 'antenna',
      kind: 'antenna',
      count: T.sectors.length * T.antennasPerSector,
      params: { type: 'panel', sectors: T.sectors.length },
      levels: [T.antennaY / H],
    }),
    proposed({
      role: 'mount',
      kind: 'antennaMount',
      count: T.sectors.length * T.antennasPerSector,
      params: {},
    }),
    proposed({ role: 'cabinet', kind: 'cabinet', count: 1, params: {} }),
  ]);
}

/** A synthetic twelve-sided monopole with one panel antenna near the top. */
export const MONOPOLE_TRUTH = {
  height: 30,
  profile: [
    { y: 0, r: 0.8 },
    { y: 30, r: 0.4 },
  ],
  sides: 12,
  antennas: 1,
  antennaY: 28,
};

export function monopoleEvidence(): EvidencePack {
  const T = MONOPOLE_TRUTH;
  const b: Vec3 = [0, 0, 0];
  return pack({
    base: b,
    height: T.height,
    profile: T.profile,
    coverage: 0.85,
    members: [
      {
        kind: 'antenna-candidate',
        items: [item(toward(b, 0, 1.1, T.antennaY), 1.4, 0)],
        metrics: {},
      },
    ],
    suggested: 'telecom-monopole',
    fillRatio: 0.6,
    topFeatures: T.antennas,
    kept: 250_000,
  });
}

export function monopoleProposal(): EngineerProposal {
  const T = MONOPOLE_TRUTH;
  const H = T.height;
  const [p0, p1] = [T.profile[0], T.profile.at(-1)];
  return proposal('telecom-monopole', 'A single tapered steel pole with an antenna at the top.', [
    proposed({
      role: 'pole',
      kind: 'monopole',
      count: 1,
      params: { rBase: (p0?.r ?? 1) / H, rTop: (p1?.r ?? 1) / H, sides: T.sides },
    }),
    proposed({
      role: 'antenna',
      kind: 'antenna',
      count: T.antennas,
      params: { type: 'panel' },
      levels: [T.antennaY / H],
    }),
  ]);
}

/** A run setup over one cloud layer, the asset only, placed from the source. */
export function setupFor(family: ModelFamily | 'auto', detail: Detail = 'standard'): EngineerSetup {
  return {
    sources: { clouds: [{ layer: 'cloud-1' }], meshes: [], photos: [] },
    family,
    scope: 'asset',
    detail,
    placement: 'from-source',
  };
}
