/**
 * Editing the components of an engineering model (spec section 4, review): which values of a
 * component a person may change, how a change becomes the assembler's `UserOverrides` (so a rebuild
 * regenerates through `mergeModels` and keeps ids and accepted components), and the pure model
 * edits for adding, removing and re-accepting a component.
 */
import { Assembly, type AssemblyKind, type ProcModel, type ValueBasis } from '@aio/schema';
import { t, type MessageKey } from '@aio/ui';
import type { UserOverrides } from './engineer/assemble/assemble';

export interface AssemblyField {
  key: string;
  label: string;
  value: number | string | boolean;
  unit?: 'm' | 'deg';
  basis: ValueBasis;
  min?: number;
  max?: number;
  /** For a choice between named values. */
  options?: { value: string; label: string }[];
  /** A whole number (a count). */
  integer?: boolean;
  /** Display a derived value without offering a scalar edit that cannot update its geometry. */
  readOnly?: boolean;
}

interface Meta {
  unit?: 'm' | 'deg';
  min?: number;
  max?: number;
  integer?: boolean;
  options?: string[];
}

const LEN: Meta = { unit: 'm', min: 0.001, max: 1000 };
const DEG: Meta = { unit: 'deg', min: -360, max: 360 };

/** The scalar parameters a person can edit, by top-level name. Others (paths, profiles) are measured. */
const META: Record<string, Meta> = {
  rOuter: LEN,
  rInner: LEN,
  r: LEN,
  height: LEN,
  wall: LEN,
  thickness: LEN,
  y: { unit: 'm', min: -500, max: 1500 },
  y0: { unit: 'm', min: -500, max: 1500 },
  y1: { unit: 'm', min: -500, max: 1500 },
  arcDeg: { unit: 'deg', min: 10, max: 360 },
  width: LEN,
  rungSpacing: LEN,
  diameter: LEN,
  bendRadius: LEN,
  span: LEN,
  yawDeg: DEG,
  member: LEN,
  widthBase: LEN,
  widthTop: LEN,
  legSection: LEN,
  braceSection: LEN,
  azimuthDeg: { unit: 'deg', min: 0, max: 360 },
  tiltDeg: { unit: 'deg', min: -90, max: 90 },
  size: LEN, // the scalar `size` of a warning light; antennas carry a triple and are not listed
  posts: LEN,
  pilots: { min: 0, max: 8, integer: true },
  blades: { min: 3, max: 40, integer: true },
  bays: { min: 1, max: 20, integer: true },
  legs: { min: 3, max: 4, integer: true },
  sides: { min: 0, max: 18, integer: true },
  rails: { min: 1, max: 3, integer: true },
  openTop: {},
  rim: {},
  flange: {},
  windshield: {},
  cage: {},
  open: {},
  braced: {},
  flanges: {},
  kind: {},
  fixture: {},
  material: {},
};

const OPTIONS: Partial<Record<AssemblyKind, Record<string, string[]>>> = {
  antenna: { kind: ['panel', 'dish', 'rru', 'omni'] },
  antennaMount: { kind: ['pipe', 'sector-frame', 'standoff'] },
  warningLight: { fixture: ['single', 'twin', 'canister', 'beacon'] },
  frame: { kind: ['portal', 'rack'] },
};

const key = (k: string) => k as MessageKey;

/** The readable name of a kind (`ringPlatform` is "Ring platform"). */
export function kindLabel(kind: AssemblyKind): string {
  return t(key(`review.kind.${kind}`));
}

/** The editable values of a component, each with the basis it is known on. */
export function assemblyFields(a: Assembly): AssemblyField[] {
  const out: AssemblyField[] = [];
  const params = a.params as Record<string, unknown>;
  for (const [k, v] of Object.entries(params)) {
    if (
      a.kind === 'ladder' &&
      a.params.style === 'step-bolts' &&
      (k === 'rungSpacing' || k === 'cage')
    )
      continue;
    if (a.kind === 'guardrail' && a.params.pickets && k === 'rails') continue;
    const meta = META[k];
    if (meta === undefined) continue;
    if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') continue;
    const clampKind = a.kind === 'antennaMount' && a.params.kind === 'clamp' && k === 'kind';
    const fittedHeight =
      a.kind === 'deck' && (a.params.roofPanels ?? a.params.elevations) && k === 'y';
    const options = clampKind ? ['clamp'] : OPTIONS[a.kind]?.[k];
    out.push({
      key: k,
      label: t(key(`review.field.${fittedHeight ? 'projectY' : k}`)),
      value: v,
      ...(clampKind || fittedHeight ? { readOnly: true } : {}),
      ...(meta.unit ? { unit: meta.unit } : {}),
      ...(meta.min !== undefined ? { min: meta.min } : {}),
      ...(meta.max !== undefined ? { max: meta.max } : {}),
      ...(meta.integer ? { integer: true } : {}),
      ...(options
        ? { options: options.map((o) => ({ value: o, label: t(key(`review.option.${o}`)) })) }
        : {}),
      basis: a.quality[k]?.basis ?? 'inferred',
    });
  }
  return out;
}

/**
 * The overrides a rebuild takes after `key` of component `id` is set to `value`: every value the
 * person already entered (a `user` basis in the model) is kept, plus this one. Components the
 * person added by hand are carried so a regeneration does not drop them.
 */
export function applyAssemblyField(
  m: ProcModel,
  id: string,
  field: string,
  value: number | string | boolean,
): UserOverrides {
  const base = userOverrides(m);
  return { ...base, params: { ...base.params, [id]: { ...base.params[id], [field]: value } } };
}

/** Every value the person entered so far, and the components they made by hand. */
function userOverrides(m: ProcModel): UserOverrides {
  const params: UserOverrides['params'] = {};
  for (const a of m.assemblies) {
    const own = a.params as Record<string, unknown>;
    for (const [k, q] of Object.entries(a.quality)) {
      const v = own[k];
      if (
        q.basis === 'user' &&
        (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
      )
        (params[a.id] ??= {})[k] = v;
    }
  }
  return {
    params,
    counts: {},
    levels: {},
    removed: [],
    added: m.assemblies.filter((a) => a.origin.by === 'manual'),
  };
}

/** The same overrides with component `id` left out of the rebuilt model. */
export function removeAssemblyOverrides(m: ProcModel, id: string): UserOverrides {
  const base = userOverrides(m);
  const params = Object.fromEntries(Object.entries(base.params).filter(([k]) => k !== id));
  return { ...base, params, removed: [id], added: base.added.filter((a) => a.id !== id) };
}

/** The role names the assembler gives ids from, where they are shorter than the kind. */
const ROLE: Partial<Record<AssemblyKind, string>> = {
  ringPlatform: 'platform',
  pipeRun: 'pipe',
  flareTip: 'tip',
  antennaMount: 'mount',
  warningLight: 'light',
  monopole: 'pole',
  base: 'plinth',
};

/** The role a new component's id starts from (`ringPlatform` is `platform`, as the assembler has it). */
export function roleOfKind(kind: AssemblyKind): string {
  return ROLE[kind] ?? kind.replace(/([A-Z])/g, '-$1').toLowerCase();
}

/** The next free id for a new component of `kind` (`flue-4` when flue-1 to flue-3 exist). */
export function nextAssemblyId(m: ProcModel, kind: AssemblyKind): string {
  const role = roleOfKind(kind);
  const taken = new Set(m.assemblies.map((a) => a.id));
  let n = 1;
  while (taken.has(`${role}-${String(n)}`)) n++;
  return `${role}-${String(n)}`;
}

type Vec3 = [number, number, number];

/** The base of the model's main structure, where a new component starts. */
function primaryBase(m: ProcModel): Vec3 {
  for (const a of m.assemblies) {
    if (a.kind === 'shaft' || a.kind === 'lattice' || a.kind === 'monopole')
      return [...a.params.base];
  }
  return [0, 0, 0];
}

/** Sensible starting values for a new component of `kind`, placed at the model's base. */
function defaultParams(kind: AssemblyKind, at: Vec3, m: ProcModel): Assembly['params'] {
  const [x, y, z] = at;
  const shaft = m.assemblies.find((a) => a.kind === 'shaft');
  const top = shaft?.kind === 'shaft' ? (shaft.params.profile.at(-1)?.y ?? y + 10) : y + 10;
  const table: Record<AssemblyKind, unknown> = {
    shaft: {
      base: at,
      profile: [
        { y, r: 1 },
        { y: y + 10, r: 1 },
      ],
      openTop: false,
    },
    band: { shaft: shaft?.id ?? 'shaft-1', y0: y + 1, y1: y + 2, material: '' },
    flue: { centre: [x, top, z], rOuter: 0.5, rInner: 0.4, height: 3 },
    flareTip: { base: [x, top, z], r: 0.5, height: 2 },
    deck: { y: top, outline: { r: 2 }, thickness: 0.2, openings: [] },
    ringPlatform: { y: y + 5, rInner: 1.2, rOuter: 2, thickness: 0.1 },
    guardrail: { path: { y: y + 5, r: 2 }, height: 1.1, posts: 1.5, rails: 2 },
    ladder: { bottom: [x + 1.2, y, z], top: [x + 1.2, y + 5, z], width: 0.5, rungSpacing: 0.3 },
    hatch: { centre: [x, y + 5, z], size: [0.8, 0.6] },
    louvre: { centre: [x, y + 2, z + 1.2], normal: [0, 0, 1], size: [1, 0.8], blades: 6 },
    duct: {
      path: [
        [x + 5, y + 2, z],
        [x + 1.5, y + 2, z],
      ],
      section: { round: 0.8 },
    },
    pipeRun: {
      path: [
        [x + 5, y + 1, z],
        [x + 1.5, y + 1, z],
      ],
      diameter: 0.2,
    },
    frame: {
      kind: 'portal',
      base: [x + 4, y, z],
      span: 3,
      height: 2.5,
      yawDeg: 0,
      bays: 2,
      braced: true,
      member: 0.15,
    },
    base: { outline: { r: 1.6 }, y: y - 1, height: 1 },
    cabinet: { base: [x + 4, y, z], size: [1.2, 2, 0.8], yawDeg: 0 },
    lattice: {
      base: at,
      legs: 4,
      widthBase: 4,
      widthTop: 1.5,
      height: 20,
      bays: Array.from({ length: 4 }, () => ({ height: 5, bracing: 'X' })),
      legSection: 0.15,
      braceSection: 0.08,
    },
    monopole: {
      base: at,
      profile: [
        { y, r: 0.5 },
        { y: y + 20, r: 0.3 },
      ],
      sides: 12,
    },
    antenna: {
      kind: 'panel',
      centre: [x, y + 10, z - 1],
      azimuthDeg: 0,
      tiltDeg: 0,
      size: [0.3, 1.4, 0.15],
    },
    antennaMount: {
      kind: 'pipe',
      centre: [x, y + 10, z - 0.9],
      azimuthDeg: 0,
      size: [0.1, 2, 0.1],
    },
    warningLight: { fixture: 'single', centre: [x, top, z], outward: [0, 1, 0], size: 0.3 },
    earthing: {
      path: [
        [x + 3, y + 0.05, z],
        [x + 1.5, y + 0.05, z],
      ],
      diameter: 0.03,
    },
  };
  return table[kind] as Assembly['params'];
}

/**
 * A new component of `kind` as a draft the person made by hand, with the next free id for its role.
 * Every value is entered by them; the model is not changed.
 */
export function newAssembly(m: ProcModel, kind: AssemblyKind): Assembly {
  const id = nextAssemblyId(m, kind);
  const label = kindLabel(kind);
  const a = {
    id,
    kind,
    params: defaultParams(kind, primaryBase(m), m),
    name: `${label} ${id.slice(id.lastIndexOf('-') + 1)}`,
    description: '',
    category: label,
    status: 'draft' as const,
    origin: { by: 'manual' as const },
    quality: {},
    sources: [{ kind: 'user' as const, ref: 'added by hand' }],
  };
  const quality = Object.fromEntries(
    Object.keys(a.params).map((k) => [k, { basis: 'user' as const }]),
  );
  return Assembly.parse({ ...a, quality });
}

/** The model with `a` appended (a draft), stamped. */
export function addAssembly(m: ProcModel, a: Assembly, now: string): ProcModel {
  return { ...m, updatedAt: now, assemblies: [...m.assemblies, a] };
}

/** The model without component `id` (its children, if any, keep their `parent` text), stamped. */
export function removeAssembly(m: ProcModel, id: string, now: string): ProcModel {
  return { ...m, updatedAt: now, assemblies: m.assemblies.filter((a) => a.id !== id) };
}
