/**
 * The deterministic assembler of the engineering model (spec section 5.3, step 4): measurements
 * (the evidence pack), the AI proposal and the person's own values become `aio.procmodel/2`
 * assemblies through a family template, then merge with the previous model by stable id.
 *
 * Precedence for every parameter: user > measured > AI (observed, or inferred when the AI did not
 * see it) > template default (inferred); the winning basis is written to `quality` under the
 * parameter's top-level name. Only a value taken from the evidence is ever `measured`.
 *
 * Scale: a metric evidence pack (a cloud) measures the height. Without one, the person's reference
 * dimension scales the AI's ratios (`reference`); without that, the model is `provisional`, built
 * round an assumed height recorded in `scale.reference` with an "assumed" label and listed as
 * unresolved, never as measured.
 */
import {
  Assembly,
  AssemblyKind,
  type EngineerProposal,
  type EngineerSetup,
  type EvidencePack,
  type EvidenceRef,
  type Material,
  type ModelFamily,
  type ParamQuality,
  type PartOrigin,
  type ProcModel,
  type ProposalComponent,
  type ScaleRecord,
  type ValueBasis,
  type Vec3,
} from '@aio/schema';
import { newProcModel } from '../../procmodel';
import { profileRadiusAt } from '../builders/ctx';
import { DEFAULT_MATERIALS } from '../materials';
import { chimney, deckOpenings, genericShaft } from './chimney';
import { assembleFlare } from './flare';
import { assignIds, azimuthDeg, type IdItem } from './ids';
import { mergeModels, roleOf } from './merge';
import { assembleLattice, assembleMonopole } from './telecom';

/** The person's corrections, keyed by assembly id or by role (`flue`, `light-l1`). */
export interface UserOverrides {
  /** Scalar parameter values, by assembly id or role, then top-level parameter name. */
  params: Record<string, Record<string, number | string | boolean>>;
  /** Component counts by role. */
  counts: Record<string, number>;
  /** Levels by role, in metres above the asset base (`light-l1: [45]` moves that light level). */
  levels: Record<string, number[]>;
  /** Assembly ids or roles to leave out (accepted ones are kept and flagged). */
  removed: string[];
  /** Assemblies the person made; kept as they are. */
  added: Assembly[];
}

export interface AssembleInput {
  modelId: string;
  runId: string;
  family: ModelFamily;
  scope: 'asset' | 'asset-and-surroundings';
  evidence: EvidencePack | null;
  proposal: EngineerProposal | null;
  setup: EngineerSetup;
  user: UserOverrides;
  previous: ProcModel | null;
  now: string;
}

export interface AssembleResult {
  model: ProcModel;
  /** Ids added, replaced or dropped against the previous model. */
  changed: string[];
  /** Ids whose previous object was kept as it was. */
  kept: string[];
  flagged: { id: string; reason: string }[];
  unresolved: string[];
}

/** One parameter's candidates, best first: the person's, measured, the AI's, the default. */
export interface Candidates<T> {
  user?: T;
  measured?: { v: T; q: Omit<ParamQuality, 'basis'> };
  observed?: T;
  inferred: T;
}

export interface FamilyCtx {
  input: AssembleInput;
  /** Asset height above its base, metres (assumed when the scale is provisional). */
  height: number;
  scale: ScaleRecord;
  /** True when the evidence is metric (its positions and sizes may be used as measured). */
  metric: boolean;
  /** The asset base (foot of its axis) and how it is known. */
  base: Vec3;
  baseQuality: ParamQuality;
  origin: PartOrigin;
  /** The value of `param` of assembly `id` by precedence (person values by id, then by role). */
  value<T>(id: string, param: string, candidates: Candidates<T>): { v: T; q: ParamQuality };
  /** Outer radius of the host shaft at world height `y` (0 before `setHost`). */
  radiusAt(y: number): number;
  setHost(host: { base: Vec3; profile: { y: number; r: number }[] }): void;
  /** Evidence an assembly of `kind` rests on: the cloud and mesh layers when measured, the AI's photos. */
  sources(kind: string, o?: { measured?: boolean; id?: string }): EvidenceRef[];
  /** Proposal components of an assembly kind. */
  proposals(kind: AssemblyKind): ProposalComponent[];
  /** A proposal length in metres (ratios times the height). */
  len(c: ProposalComponent | undefined, key: string): number | undefined;
  /** The person's count / levels for a role. */
  userCount(role: string): number | undefined;
  userLevels(role: string): number[] | undefined;
  /** A person's scalar for `id` (or its role), whatever its type. */
  userParam(id: string, param: string): number | string | boolean | undefined;
  /** Stable ids for `items` of `role` (previous ids kept, see `assignIds`). */
  ids(role: string, items: IdItem[]): string[];
  /** Unobserved sides of a surface whose position has `basis`, from the evidence coverage. */
  unobserved(basis: ValueBasis): ('back' | 'top' | 'interior' | 'base')[] | undefined;
  /** Adds a line to the unresolved list. */
  note(text: string): void;
}

export type FamilyAssembler = (ctx: FamilyCtx) => Assembly[];

/** Family templates; `generic` is the chimney's shaft alone. */
export const FAMILIES: Partial<Record<ModelFamily, FamilyAssembler>> = {
  chimney,
  generic: genericShaft,
  flare: assembleFlare,
  'telecom-lattice': assembleLattice,
  'telecom-monopole': assembleMonopole,
};

/** Height a provisional model is built round when nothing gives the scale. */
export const ASSUMED_HEIGHT_M: Record<ModelFamily, number> = {
  chimney: 100,
  flare: 50,
  'telecom-lattice': 40,
  'telecom-monopole': 30,
  generic: 20,
};

const FAMILY_NAMES: Record<ModelFamily, string> = {
  chimney: 'Chimney',
  flare: 'Flare stack',
  'telecom-lattice': 'Lattice tower',
  'telecom-monopole': 'Monopole',
  generic: 'Structure',
};

const KINDS = new Set<string>(AssemblyKind.options);
const MAX_TEXT = 200;

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 3)}...` : s);

/** The asset height and scale record, by source: evidence, reference, the AI's metres, assumed. */
function resolveScale(
  input: AssembleInput,
  notes: string[],
): { height: number; scale: ScaleRecord; metric: boolean } {
  const ev = input.evidence;
  const ref = input.setup.reference;
  const shaft = input.proposal?.components.find((c) => c.kind === 'shaft');
  const taper = ev?.taper?.profile ?? [];
  const baseY = ev?.base?.[1] ?? ev?.axis?.point[1] ?? 0;
  const spanned = taper.length >= 2 ? (taper.at(-1)?.y ?? baseY) - baseY : undefined;
  const measured = ev?.height ?? (spanned !== undefined && spanned > 0 ? spanned : undefined);
  if (ev && measured !== undefined) {
    if (ref?.what === 'height' && Math.abs(ref.valueM - measured) > 0.05 * measured)
      notes.push(
        `The reference height (${ref.valueM.toFixed(1)} m) differs from the measured height (${measured.toFixed(1)} m); the measured one is used.`,
      );
    return { height: measured, scale: { status: 'measured' }, metric: true };
  }
  if (ref?.what === 'height')
    return { height: ref.valueM, scale: { status: 'reference', reference: ref }, metric: false };
  const rBase = shaft?.params.rBase;
  if (
    ref?.what === 'diameter' &&
    shaft?.units === 'ratio' &&
    typeof rBase === 'number' &&
    rBase > 0
  )
    return {
      height: ref.valueM / (2 * rBase),
      scale: { status: 'reference', reference: ref },
      metric: false,
    };
  const aiHeight = shaft?.params.height;
  if (shaft?.units === 'm' && typeof aiHeight === 'number' && aiHeight > 0) {
    notes.push(
      'The scale is the AI estimate of the height, not a measurement: give a reference dimension.',
    );
    return { height: aiHeight, scale: { status: 'provisional' }, metric: false };
  }
  const assumed = ASSUMED_HEIGHT_M[input.family];
  notes.push(
    `The scale is unknown: dimensions are relative to an assumed height of ${String(assumed)} m. Give a reference dimension.`,
  );
  return {
    height: assumed,
    scale: {
      status: 'provisional',
      reference: { what: 'height', valueM: assumed, label: 'assumed height, not measured' },
    },
    metric: false,
  };
}

/** A position for numbering a previous assembly: its centre, base, start or level. */
function positionOf(a: Assembly): { p?: Vec3 | undefined; y?: number | undefined } {
  switch (a.kind) {
    case 'flue':
    case 'hatch':
    case 'louvre':
    case 'antenna':
    case 'antennaMount':
    case 'warningLight':
      return { p: a.params.centre };
    case 'shaft':
    case 'flareTip':
    case 'frame':
    case 'cabinet':
    case 'lattice':
    case 'monopole':
      return { p: a.params.base };
    case 'ladder':
      return { p: a.params.bottom };
    case 'duct':
    case 'pipeRun':
    case 'earthing':
      return { p: a.params.path[0] };
    case 'band':
      return { y: a.params.y0 };
    case 'deck':
    case 'ringPlatform':
    case 'base':
      return { y: a.params.y };
    case 'guardrail':
      return Array.isArray(a.params.path) ? { p: a.params.path[0] } : { y: a.params.path.y };
  }
}

const sameType = <T>(v: unknown, like: T): v is T => typeof v === typeof like;

function makeCtx(
  input: AssembleInput,
  scaled: { height: number; scale: ScaleRecord; metric: boolean },
  notes: string[],
  ignoreUser: ReadonlySet<string>,
): FamilyCtx {
  const ev = scaled.metric ? input.evidence : null;
  const anchor = input.setup.placement === 'anchor' ? input.setup.anchor : undefined;
  const evBase = ev?.base ?? ev?.axis?.point;
  const base: Vec3 = evBase ? [evBase[0], evBase[1], evBase[2]] : (anchor ?? [0, 0, 0]);
  const baseQuality: ParamQuality = evBase
    ? { basis: 'measured', support: ev?.samples.ground ?? 0 }
    : { basis: anchor ? 'user' : 'inferred' };
  const coverage = ev?.slices.length
    ? ev.slices.reduce((s, q) => s + q.coverage, 0) / ev.slices.length
    : undefined;
  let host: { base: Vec3; profile: { y: number; r: number }[] } | null = null;
  const user = input.user;
  const userParam = (id: string, param: string) => {
    if (ignoreUser.has(id)) return undefined;
    return user.params[id]?.[param] ?? user.params[roleOf(id)]?.[param];
  };
  const previous = input.previous?.assemblies ?? [];
  return {
    input,
    height: scaled.height,
    scale: scaled.scale,
    metric: scaled.metric,
    base,
    baseQuality,
    origin: { by: 'engineer', runId: input.runId },
    value<T>(id: string, param: string, c: Candidates<T>) {
      const u = userParam(id, param);
      if (u !== undefined && sameType(u, c.inferred)) return { v: u, q: { basis: 'user' } };
      if (c.user !== undefined) return { v: c.user, q: { basis: 'user' } };
      if (c.measured) return { v: c.measured.v, q: { basis: 'measured', ...c.measured.q } };
      if (c.observed !== undefined) return { v: c.observed, q: { basis: 'observed' } };
      return { v: c.inferred, q: { basis: 'inferred' } };
    },
    radiusAt(y) {
      if (!host) return 0;
      return profileRadiusAt(host.profile, y - host.base[1]);
    },
    setHost(h) {
      host = h;
    },
    sources(kind, o = {}) {
      const refs: EvidenceRef[] = [];
      if (o.measured) {
        for (const c of input.setup.sources.clouds) refs.push({ kind: 'cloud', ref: c.layer });
        for (const m of input.setup.sources.meshes) refs.push({ kind: 'mesh', ref: m.layer });
      }
      for (const c of input.proposal?.components ?? [])
        if (c.kind === kind) for (const id of c.imageIds) refs.push({ kind: 'photo', ref: id });
      if (o.id !== undefined && !ignoreUser.has(o.id)) {
        const own = user.params[o.id] ?? user.params[roleOf(o.id)];
        if (own && Object.keys(own).length) refs.push({ kind: 'user', ref: 'edit' });
      }
      const seen = new Set<string>();
      return refs
        .filter((r) => {
          const k = `${r.kind}:${r.ref}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 64);
    },
    proposals(kind) {
      return (input.proposal?.components ?? []).filter((c) => c.kind === kind);
    },
    len(c, key) {
      const v = c?.params[key];
      if (!c || typeof v !== 'number' || !(v > 0)) return undefined;
      return c.units === 'm' ? v : v * scaled.height;
    },
    userCount: (role) => user.counts[role],
    userLevels: (role) => user.levels[role],
    userParam,
    ids(role, items) {
      const prev = previous.flatMap((a) => {
        const { p, y } = positionOf(a);
        const dx = p ? p[0] - base[0] : 0;
        const dz = p ? p[2] - base[2] : 0;
        const az = Math.hypot(dx, dz) > 1e-6 ? azimuthDeg(dx, dz) : undefined;
        return [{ id: a.id, ...(az === undefined ? {} : { azimuthDeg: az }), y: p ? p[1] : y }];
      });
      return assignIds(role, items, prev);
    },
    unobserved(basis) {
      return coverage !== undefined && coverage < 0.5 && basis === 'inferred'
        ? ['back']
        : undefined;
    },
    note(text) {
      notes.push(text);
    },
  };
}

/** Lays the person's scalar values (by role, then by id) onto `a`; undefined when refused. */
function withUserParams(a: Assembly, user: UserOverrides): Assembly | undefined {
  const own = { ...user.params[roleOf(a.id)], ...user.params[a.id] };
  const params: Record<string, unknown> = { ...a.params };
  const quality: Record<string, ParamQuality> = { ...a.quality };
  let touched = false;
  for (const [k, v] of Object.entries(own)) {
    if (!(k in params) || typeof params[k] !== typeof v) continue;
    if (params[k] === v && quality[k]?.basis === 'user') continue;
    params[k] = v;
    quality[k] = { basis: 'user' };
    touched = true;
  }
  if (!touched) return a;
  const r = Assembly.safeParse({ ...a, params, quality });
  return r.success ? r.data : undefined;
}

/** Runs the family, re-running it without the person's values for the assemblies they break. */
function generate(
  family: FamilyAssembler,
  input: AssembleInput,
  scaled: ReturnType<typeof resolveScale>,
  notes: string[],
  flagged: { id: string; reason: string }[],
): Assembly[] {
  const first = family(makeCtx(input, scaled, notes, new Set()));
  const bad = new Set<string>();
  const out = first.map((a) => {
    const ok = Assembly.safeParse(a).success ? withUserParams(a, input.user) : undefined;
    if (!ok) bad.add(a.id);
    return ok ?? a;
  });
  if (!bad.size) return out;
  const again = new Map(
    family(makeCtx(input, scaled, [], bad)).map((a): [string, Assembly] => [a.id, a]),
  );
  const fixed: Assembly[] = [];
  for (const a of out) {
    if (!bad.has(a.id)) {
      fixed.push(a);
      continue;
    }
    const b = again.get(a.id);
    if (b && Assembly.safeParse(b).success) {
      fixed.push(b);
      flagged.push({
        id: a.id,
        reason: 'A value you set does not fit this component; it was not applied.',
      });
    } else flagged.push({ id: a.id, reason: 'This component could not be generated.' });
  }
  return fixed;
}

const roleHit = (a: Assembly, removed: ReadonlySet<string>) =>
  removed.has(a.id) || removed.has(roleOf(a.id));

/** Drops removed assemblies and their descendants. */
function withoutRemoved(list: Assembly[], removed: ReadonlySet<string>): Assembly[] {
  const gone = new Set(list.filter((a) => roleHit(a, removed)).map((a) => a.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of list)
      if (!gone.has(a.id) && a.parent !== undefined && gone.has(a.parent)) {
        gone.add(a.id);
        grew = true;
      }
  }
  return list.filter((a) => !gone.has(a.id));
}

/**
 * Generated decks open over the flues the merged model will hold: accepted previous flues the
 * new set no longer makes (or makes differently) keep their opening.
 */
function reconcileDecks(next: Assembly[], previous: ProcModel | null): Assembly[] {
  const prev = new Map((previous?.assemblies ?? []).map((a) => [a.id, a]));
  const nextIds = new Set(next.map((a) => a.id));
  const final = [
    ...next.flatMap((a) => {
      const p = prev.get(a.id);
      if (!p || p.status === 'draft') return [a];
      return p.status === 'accepted' ? [p] : [];
    }),
    ...(previous?.assemblies ?? []).filter(
      (p) => !nextIds.has(p.id) && p.status === 'accepted' && p.origin.by === 'engineer',
    ),
  ].filter((a) => a.kind === 'flue');
  // only a deck in a shaft (a chimney's, under its flues) opens over flues; a tower platform's
  // one opening is the tower's own passage
  const shafts = new Set(next.filter((a) => a.kind === 'shaft').map((a) => a.id));
  return next.map((d) => {
    if (d.kind !== 'deck' || d.quality.openings?.basis === 'user') return d;
    if (d.parent === undefined || !shafts.has(d.parent)) return d;
    const openings = deckOpenings(final.filter((f) => f.parent === d.parent));
    return Assembly.safeParse({ ...d, params: { ...d.params, openings } }).data ?? d;
  });
}

/** Referenced ids a model must define (an assembly's own material, a band's paint). */
function materialsFor(assemblies: readonly Assembly[], own: readonly Material[]): Material[] {
  const used = new Set<string>();
  for (const a of assemblies) {
    if (a.material !== undefined) used.add(a.material);
    if (a.kind === 'band') used.add(a.params.material);
  }
  const out = [...own];
  const have = new Set(own.map((m) => m.id));
  for (const d of DEFAULT_MATERIALS) if (used.has(d.id) && !have.has(d.id)) out.push(d);
  return out;
}

/** References an assembly makes to other assemblies (parent, ringed shaft). */
function refsOf(a: Assembly): string[] {
  const refs = a.parent === undefined ? [] : [a.parent];
  if (a.kind === 'band') refs.push(a.params.shaft);
  if (a.kind === 'ringPlatform' && a.params.shaft !== undefined) refs.push(a.params.shaft);
  if (a.kind === 'guardrail' && !Array.isArray(a.params.path) && a.params.path.shaft !== undefined)
    refs.push(a.params.path.shaft);
  return refs;
}

export function assemble(input: AssembleInput): AssembleResult {
  const notes: string[] = [];
  const flagged: { id: string; reason: string }[] = [];
  const scaled = resolveScale(input, notes);
  let family = FAMILIES[input.family];
  if (!family) {
    notes.push(
      `There is no ${FAMILY_NAMES[input.family].toLowerCase()} template yet: only the main shaft was generated.`,
    );
    family = genericShaft;
  }
  const removed = new Set(input.user.removed);
  const generated = generate(family, input, scaled, notes, flagged);
  let next = withoutRemoved(generated, removed);
  for (const a of input.user.added) {
    const at = next.findIndex((x) => x.id === a.id);
    if (at >= 0) next[at] = a;
    else next.push(a);
  }
  next = reconcileDecks(next, input.previous);
  const merged = mergeModels(input.previous, next, { removedRoles: input.user.removed });
  flagged.push(...merged.flagged);

  // a component the person removed stays while kept (accepted) components still rest on it
  const assemblies = [...merged.assemblies];
  const changed = [...merged.changed];
  const previousById = new Map((input.previous?.assemblies ?? []).map((a) => [a.id, a]));
  const generatedById = new Map(generated.map((a) => [a.id, a]));
  for (let guard = 0; guard < 50; guard++) {
    const ids = new Set(assemblies.map((a) => a.id));
    const missing = assemblies.flatMap(refsOf).find((r) => !ids.has(r));
    if (missing === undefined) break;
    const back = previousById.get(missing) ?? generatedById.get(missing);
    if (!back) break;
    assemblies.unshift(back);
    const at = changed.indexOf(missing);
    if (previousById.get(missing) === back) {
      if (at >= 0) changed.splice(at, 1);
    } else if (at < 0) changed.push(missing);
    flagged.push({ id: missing, reason: 'Kept: accepted components rest on it.' });
  }

  const supported = assemblies
    .filter((a) =>
      Object.values(a.quality).some((q) => q.basis === 'measured' || q.basis === 'observed'),
    )
    .map((a) => a.id);
  const missingRoles = (input.proposal?.components ?? []).flatMap((c) =>
    !KINDS.has(c.kind)
      ? [`${c.role}: "${c.kind}" is not a component kind this build can make.`]
      : c.count === 0
        ? [`${c.role} (${c.kind}): none seen.`]
        : [],
  );
  const unresolved = [
    ...(input.proposal?.unresolved ?? []),
    ...notes,
    ...flagged.map((f) => `${f.id}: ${f.reason}`),
  ].map(clip);

  const prev = input.previous;
  const model: ProcModel = {
    ...(prev ??
      newProcModel({ id: input.modelId, name: FAMILY_NAMES[input.family], now: input.now })),
    id: input.modelId,
    updatedAt: input.now,
    family: input.family,
    scope: input.scope,
    materials: materialsFor(assemblies, prev?.materials ?? []),
    assemblies,
    scale: scaled.scale,
    evidence: {
      supported: supported.slice(0, 400),
      missing: missingRoles.map(clip).slice(0, 100),
      unresolved: unresolved.slice(0, 100),
    },
    run: { id: input.runId, detail: input.setup.detail },
  };
  return { model, changed, kept: merged.kept, flagged, unresolved };
}
