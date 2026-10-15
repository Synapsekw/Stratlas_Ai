/**
 * The telecom tower family templates (spec section 5.3): a lattice tower (`telecom-lattice`) or a
 * monopole (`telecom-monopole`), never a shaft, with its antennas, their mounts, warning lights,
 * and only what the evidence or the proposal shows of ladders, platforms and cabinets.
 *
 * Lattice: legs from the `leg` members (3 or 4; the base width from their spacing, the top width
 * scaled by the lowest and highest slices), bays from the proposal's `bays` count or evenly 4 to
 * 6 m, bracing from the proposal or `X`. Monopole: the measured profile (else the AI's ratios),
 * `sides` from the proposal (default 0, round).
 *
 * Antennas: each one its own assembly on its own mount (a standoff whose arms reach back to the
 * host surface: the lattice face or leg, or the pole, at the antenna's height). They are grouped
 * into sectors by the bearing they face (`antenna-candidate` members clustered by azimuth, else
 * the proposal's count spread over its `sectors`); sector `s1` is the first clockwise from north,
 * and a sector keeps its number on regeneration. Antennas are numbered within their sector
 * clockwise from north by bearing, then by height: `antenna-s<k>-<n>`, mount `mount-s<k>-<n>`.
 *
 * Compass azimuths: 0 north (-z), 90 east (+x).
 */
import type {
  Assembly,
  AssemblyParams,
  ParamQuality,
  ProposalComponent,
  ValueBasis,
  Vec3,
} from '@aio/schema';
import { latticeLegAt } from '../builders/steel';
import type { FamilyAssembler, FamilyCtx } from './assemble';
import { angleBetween, azimuthDeg, indexInRole } from './ids';
import {
  ai,
  bool,
  bySupport,
  chooseCount,
  clamp,
  dirOf,
  evenFrom,
  gapFill,
  group,
  lights,
  make,
  mean,
  measuredBy,
  noteUnplaced,
  num,
  profileOf,
  sliceCoverage,
  str,
  toward,
  type HostReach,
  type MemberItem,
} from './shared';

/** Bearings further apart than this start a new antenna sector. */
export const SECTOR_GAP_DEG = 30;
/** Clear gap between an antenna's back and its mount pipe's axis, less the pipe radius (overlap). */
const PIPE_D = 0.076;
/** How far a mount's arms reach into the host surface, so no gap shows. */
const MOUNT_EMBED = 0.05;
/** An inferred antenna stands this far off the host surface (to the pipe axis). */
const STANDOFF = 0.6;
/** A platform moved off the antennas keeps this clear of them (metres). */
const CLEAR = 0.05;

const ANTENNA_KINDS = ['panel', 'dish', 'rru', 'omni'] as const;
type AntennaKind = (typeof ANTENNA_KINDS)[number];
const isAntennaKind = (s: string | undefined): s is AntennaKind =>
  ANTENNA_KINDS.some((k) => k === s);
const MOUNT_KINDS = ['pipe', 'standoff'] as const;
type MountKind = (typeof MOUNT_KINDS)[number];
const isMountKind = (s: string | undefined): s is MountKind => MOUNT_KINDS.some((k) => k === s);
const BRACINGS = ['X', 'K', 'Z'] as const;
type Bracing = (typeof BRACINGS)[number];
const isBracing = (s: string | undefined): s is Bracing => BRACINGS.some((k) => k === s);

/** Width, height and depth of an antenna of `kind` whose longest side is `l`. */
function antennaSize(kind: AntennaKind, l: number): [number, number, number] {
  switch (kind) {
    case 'panel':
      return [0.22 * l, l, 0.11 * l];
    case 'dish':
      return [l, l, 0.5 * l];
    case 'rru':
      return [0.67 * l, l, 0.33 * l];
    case 'omni':
      return [Math.max(0.03, 0.05 * l), l, Math.max(0.03, 0.05 * l)];
  }
}
const DEFAULT_LENGTH: Record<AntennaKind, number> = { panel: 1.4, dish: 0.6, rru: 0.45, omni: 1.5 };

/** Mean of compass bearings (on the circle), 0 to 360. */
export function meanBearing(azs: readonly number[]): number {
  const s = azs.reduce((a, z) => a + Math.sin((z * Math.PI) / 180), 0);
  const c = azs.reduce((a, z) => a + Math.cos((z * Math.PI) / 180), 0);
  return azimuthDeg(s, -c);
}

/**
 * Groups of indices of `azs` whose neighbouring bearings (round the circle) are within `gap`
 * degrees, in order of their mean bearing from north; a single group when no gap is wider.
 */
export function clusterBearings(azs: readonly number[], gap = SECTOR_GAP_DEG): number[][] {
  if (!azs.length) return [];
  const order = azs.map((a, i) => ({ a: ((a % 360) + 360) % 360, i })).sort((p, q) => p.a - q.a);
  const gaps = order.map((p, k) => {
    const next = order[(k + 1) % order.length] ?? p;
    return (((next.a - p.a) % 360) + 360) % 360;
  });
  let widest = 0;
  gaps.forEach((g, k) => {
    if (g > (gaps[widest] ?? 0)) widest = k;
  });
  if ((gaps[widest] ?? 0) <= gap) return [order.map((p) => p.i)];
  const out: number[][] = [];
  for (let k = 1; k <= order.length; k++) {
    const at = (widest + k) % order.length;
    const p = order[at];
    if (!p) continue;
    const last = out.at(-1);
    const before = (widest + k - 1) % order.length;
    if (last && (gaps[before] ?? 360) <= gap) last.push(p.i);
    else out.push([p.i]);
  }
  const mid = (g: number[]) => meanBearing(g.map((i) => azs[i] ?? 0));
  return out.sort((p, q) => mid(p) - mid(q));
}

/**
 * Distance from `axis` (plan x, z) towards bearing `az` to the convex outline `legs` (their plan
 * positions), or 0 when the ray misses (the axis outside the outline).
 */
export function outlineReach(legs: readonly Vec3[], axis: Vec3, az: number): number {
  const d = dirOf(az);
  let best = Infinity;
  for (let i = 0; i < legs.length; i++) {
    const p = legs[i];
    const q = legs[(i + 1) % legs.length];
    if (!p || !q) continue;
    const ex = q[0] - p[0];
    const ez = q[2] - p[2];
    const den = d[0] * -ez - d[2] * -ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = p[0] - axis[0];
    const wz = p[2] - axis[2];
    const t = (wx * -ez - wz * -ex) / den;
    const s = (d[0] * wz - d[2] * wx) / den;
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  return Number.isFinite(best) ? best : 0;
}

/** How far a lattice's surface (leg face plus half a leg section) is from its axis. */
export function latticeReach(p: AssemblyParams<'lattice'>): HostReach {
  return (az, y) => outlineReach(latticeLegAt(p, y), p.base, az) + p.legSection / 2;
}

/**
 * A lattice assembly `id` round the asset axis by precedence: legs, widths and leg section from
 * the `leg` members and slices (measured), else the proposal `c` (`legs`, `widthBase`,
 * `widthTop`, `bays`, `bracing`, `legSection`, `braceSection`), else defaults.
 */
export function latticeOf(
  ctx: FamilyCtx,
  id: string,
  c: ProposalComponent | undefined,
  o: { name: string; category: string; description: string; parent?: string },
): Assembly & { kind: 'lattice' } {
  const H = ctx.height;
  const b = ctx.base;
  const legGroup = group(ctx, 'leg');
  const legItems = legGroup?.items ?? [];
  const lowY = Math.min(...legItems.map((it) => it.centre[1]));
  const lowLegs = legItems.filter((it) => it.centre[1] <= lowY + 1);
  const legSupport = legItems.reduce((s, it) => s + it.support, 0);
  const residualM = legGroup?.metrics.residualM;
  const nSeen = lowLegs.length === 3 || lowLegs.length === 4 ? lowLegs.length : undefined;
  const aiLegs = num(c, 'legs');
  const legs = ctx.value<number>(id, 'legs', {
    ...(nSeen !== undefined
      ? { measured: { v: nSeen, q: measuredBy(legSupport, residualM) } }
      : {}),
    ...ai(c, aiLegs === 3 || aiLegs === 4 ? aiLegs : undefined, 4),
  });
  const n: 3 | 4 = legs.v === 3 ? 3 : 4;
  const R = nSeen
    ? mean(lowLegs.map((it) => Math.hypot(it.centre[0] - b[0], it.centre[2] - b[2])))
    : 0;
  const seenWidth = R > 0 ? R * (n === 4 ? Math.SQRT2 : Math.sqrt(3)) : undefined;
  const widthBase = ctx.value(id, 'widthBase', {
    ...(seenWidth !== undefined
      ? { measured: { v: seenWidth, q: measuredBy(legSupport, residualM) } }
      : {}),
    ...ai(c, ctx.len(c, 'widthBase'), clamp(H / 7, 1.5, 12)),
  });
  const slices = [...(ctx.metric ? (ctx.input.evidence?.slices ?? []) : [])].sort(
    (p, q) => p.y - q.y,
  );
  const s0 = slices[0];
  const s1 = slices.at(-1);
  const scaled =
    widthBase.q.basis === 'measured' && s0 && s1 && s1 !== s0 && s0.r > 0
      ? (widthBase.v * s1.r) / s0.r
      : undefined;
  const widthTop = ctx.value(id, 'widthTop', {
    ...(scaled !== undefined && s0 && s1
      ? {
          measured: {
            v: scaled,
            q: measuredBy(s0.support + s1.support, Math.max(s0.residualM, s1.residualM)),
          },
        }
      : {}),
    ...ai(c, ctx.len(c, 'widthTop'), Math.max(0.6, widthBase.v / 4)),
  });
  const legSize = mean(legItems.filter((it) => it.size > 0).map((it) => it.size));
  const legSection = ctx.value(id, 'legSection', {
    ...(legSize > 0 ? { measured: { v: legSize, q: measuredBy(legSupport, residualM) } } : {}),
    ...ai(c, ctx.len(c, 'legSection'), clamp(0.03 * widthBase.v, 0.08, 0.4)),
  });
  const braceAi = ctx.len(c, 'braceSection');
  const braceSection = ctx.value(
    id,
    'braceSection',
    ai(c, braceAi !== undefined ? Math.min(braceAi, legSection.v) : undefined, 0.5 * legSection.v),
  );
  const aiBays = num(c, 'bays');
  const userBays = ctx.userParam(id, 'bays');
  const nBays = clamp(
    Math.round(
      typeof userBays === 'number' && userBays >= 1
        ? userBays
        : aiBays !== undefined && aiBays >= 1
          ? aiBays
          : Math.max(1, Math.round(H / 5)),
    ),
    1,
    80,
  );
  const baysBasis: ValueBasis =
    typeof userBays === 'number' && userBays >= 1
      ? 'user'
      : aiBays !== undefined && aiBays >= 1
        ? c?.observed
          ? 'observed'
          : 'inferred'
        : 'inferred';
  const userBracing = ctx.userParam(id, 'bracing');
  const aiBracing = str(c, 'bracing');
  const ub = typeof userBracing === 'string' ? userBracing : undefined;
  const bracing: Bracing = isBracing(ub) ? ub : isBracing(aiBracing) ? aiBracing : 'X';
  const bays = Array.from({ length: nBays }, () => ({ height: H / nBays, bracing }));
  const heightQ: ParamQuality =
    ctx.scale.status === 'measured' ? { basis: 'measured' } : { basis: 'inferred' };
  const coverage = sliceCoverage(ctx);
  const a = make(
    ctx,
    'lattice',
    id,
    {
      base: b,
      legs: n,
      widthBase: widthBase.v,
      widthTop: widthTop.v,
      height: H,
      bays,
      legSection: legSection.v,
      braceSection: Math.min(braceSection.v, legSection.v),
    },
    {
      category: o.category,
      name: o.name,
      description: c?.description ?? o.description,
      parent: o.parent,
      quality: {
        base: ctx.baseQuality,
        legs: legs.q,
        widthBase: widthBase.q,
        widthTop: widthTop.q,
        height: heightQ,
        bays: { basis: baysBasis },
        legSection: legSection.q,
        braceSection: braceSection.q,
      },
      unobserved: coverage !== undefined && coverage < 0.5 ? ['back'] : undefined,
      measured: legs.q.basis === 'measured' || widthBase.q.basis === 'measured',
    },
  );
  // `make` pairs the kind with its params; the narrowing is by construction
  return a as Assembly & { kind: 'lattice' };
}

/**
 * Roles (`antenna-s<k>`) of the sectors facing `facings`. A sector facing within a tolerance of a
 * previous sector (the mean bearing its antennas faced) keeps that sector's number; new sectors
 * are numbered after the highest previous one, clockwise from north.
 */
function sectorRoles(ctx: FamilyCtx, facings: readonly number[]): string[] {
  const byK = new Map<number, number[]>();
  for (const a of ctx.input.previous?.assemblies ?? []) {
    const m = /^antenna-s([1-9][0-9]*)-[1-9][0-9]*$/.exec(a.id);
    if (!m?.[1] || a.kind !== 'antenna') continue;
    const k = Number(m[1]);
    byK.set(k, [...(byK.get(k) ?? []), a.params.azimuthDeg]);
  }
  const prev = [...byK.entries()].map(([k, azs]) => ({ k, az: meanBearing(azs) }));
  const tol = Math.min(SECTOR_GAP_DEG * 1.5, 180 / Math.max(1, facings.length, prev.length));
  const out: (number | undefined)[] = facings.map(() => undefined);
  const used = new Set<number>();
  const pairs = facings
    .flatMap((f, i) => prev.map((p) => ({ i, p, d: angleBetween(f, p.az) })))
    .filter((x) => x.d <= tol)
    .sort((x, y) => x.d - y.d || x.p.k - y.p.k || x.i - y.i);
  for (const { i, p } of pairs)
    if (out[i] === undefined && !used.has(p.k)) {
      out[i] = p.k;
      used.add(p.k);
    }
  let next = prev.reduce((m, p) => Math.max(m, p.k), 0);
  facings
    .map((f, i) => ({ f, i }))
    .sort((x, y) => x.f - y.f)
    .forEach(({ i }) => {
      out[i] ??= ++next;
    });
  return out.map((k, i) => `antenna-s${String(k ?? i + 1)}`);
}

interface Spot {
  facing: number;
  /** Measured centre, when the evidence saw the antenna. */
  it?: MemberItem | undefined;
  basis: ValueBasis;
}

/**
 * Antennas and their mounts on host `hostId` whose surface is `reach` from the axis. Counts by
 * `chooseCount` over the `antenna` proposals and the `antenna-candidate` members.
 */
function antennas(ctx: FamilyCtx, hostId: string, reach: HostReach): Assembly[] {
  const H = ctx.height;
  const b = ctx.base;
  const top = b[1] + H;
  const props = ctx.proposals('antenna');
  const c = props[0];
  const mountC = ctx.proposals('antennaMount')[0];
  const ag = group(ctx, 'antenna-candidate');
  const { n } = chooseCount(ctx, {
    what: 'antennas',
    user: ctx.userCount('antenna'),
    proposed: props,
    evidence: ag?.items.length,
  });
  if (n <= 0) return [];
  const facingOf = (it: MemberItem) =>
    it.azimuthDeg ?? azimuthDeg(it.centre[0] - b[0], it.centre[2] - b[2]);
  const seen = [...(ag?.items ?? [])].sort(bySupport(ctx)).slice(0, n);
  // sectors: clusters of the bearings seen, else the proposal's spread evenly from its bearing
  let sectors: Spot[][];
  let facingsOf: number[];
  if (seen.length) {
    sectors = clusterBearings(seen.map(facingOf)).map((idx) =>
      idx.flatMap((i) => {
        const it = seen[i];
        return it ? [{ facing: facingOf(it), it, basis: 'measured' }] : [];
      }),
    );
    facingsOf = sectors.map((s) => meanBearing(s.map((x) => x.facing)));
  } else {
    const k = clamp(Math.round(num(c, 'sectors') ?? Math.min(n, 3)), 1, n);
    const start = num(c, 'azimuthDeg') ?? 0;
    facingsOf = evenFrom(((start % 360) + 360) % 360, k);
    sectors = facingsOf.map(() => []);
    ctx.note(
      'The bearings of the antennas are not known: their sectors are spaced evenly from north as a guess.',
    );
  }
  // antennas beyond the evidence go to the sectors holding the fewest
  for (let extra = n - seen.length; extra > 0; extra--) {
    let k = 0;
    sectors.forEach((s, i) => {
      if (s.length < (sectors[k]?.length ?? 0)) k = i;
    });
    sectors[k]?.push({ facing: facingsOf[k] ?? 0, basis: 'inferred' });
  }
  const roles = sectorRoles(ctx, facingsOf);
  const aiKind = str(c, 'type') ?? str(c, 'kind');
  const aiTilt = num(c, 'tiltDeg');
  const aiMount = str(mountC, 'type') ?? str(mountC, 'kind');
  const userLevel = ctx.userLevels('antenna')?.[0];
  const aiLevel = c?.levels?.[0];
  const out: Assembly[] = [];
  sectors.forEach((sector, si) => {
    const role = roles[si] ?? `antenna-s${String(si + 1)}`;
    const sFacing = facingsOf[si] ?? 0;
    const seenYs = sector.flatMap((s) => (s.it ? [s.it.centre[1]] : []));
    const level =
      userLevel !== undefined
        ? { y: b[1] + userLevel, basis: 'user' as ValueBasis }
        : seenYs.length
          ? { y: mean(seenYs), basis: 'measured' as ValueBasis }
          : aiLevel !== undefined
            ? {
                y: b[1] + Math.min(aiLevel * H, H - 0.5),
                basis: (c?.observed ? 'observed' : 'inferred') as ValueBasis,
              }
            : { y: top - clamp(0.05 * H, 1, 3), basis: 'inferred' as ValueBasis };
    // inferred ones stand side by side, clockwise of those seen
    const inferredCount = sector.filter((s) => !s.it).length;
    const kindGuess: AntennaKind = isAntennaKind(aiKind) ? aiKind : 'panel';
    const width = antennaSize(kindGuess, ctx.len(c, 'size') ?? DEFAULT_LENGTH[kindGuess])[0];
    const pitch = width + 0.3;
    const seenOffsets = sector.flatMap((s) => {
      if (!s.it) return [];
      const r = dirOf(sFacing + 90);
      return [(s.it.centre[0] - b[0]) * r[0] + (s.it.centre[2] - b[2]) * r[2]];
    });
    const startOff = seenOffsets.length
      ? Math.max(...seenOffsets) + pitch
      : (-(inferredCount - 1) * pitch) / 2;
    let slot = 0;
    const placed = sector.map((s) => {
      const facing = s.it ? facingOf(s.it) : sFacing;
      if (s.it) return { s, facing, centre: [...s.it.centre] as Vec3, offset: 0 };
      const offset = startOff + pitch * slot++;
      return { s, facing, centre: undefined, offset };
    });
    const ids = ctx.ids(
      role,
      placed.map((p) => {
        const cpos =
          p.centre ??
          (() => {
            const f = dirOf(p.facing);
            const r = dirOf(p.facing + 90);
            const d = reach(p.facing, level.y) + STANDOFF;
            return [
              b[0] + d * f[0] + p.offset * r[0],
              level.y,
              b[2] + d * f[2] + p.offset * r[2],
            ] as Vec3;
          })();
        return { azimuthDeg: azimuthDeg(cpos[0] - b[0], cpos[2] - b[2]), y: cpos[1] };
      }),
    );
    const made = placed.map((p, i) => {
      const id = ids[i] ?? `${role}-${String(i + 1)}`;
      const kind = ctx.value<AntennaKind>(
        id,
        'kind',
        ai(c, isAntennaKind(aiKind) ? aiKind : undefined, 'panel'),
      );
      const l = ctx.value(
        id,
        'size',
        p.s.it && p.s.it.size > 0
          ? {
              measured: { v: p.s.it.size, q: measuredBy(p.s.it.support) },
              inferred: DEFAULT_LENGTH[kind.v],
            }
          : ai(c, ctx.len(c, 'size'), DEFAULT_LENGTH[kind.v]),
      );
      const size = antennaSize(kind.v, l.v);
      const tilt = ctx.value(
        id,
        'tiltDeg',
        ai(c, aiTilt !== undefined ? clamp(aiTilt, -30, 30) : undefined, 0),
      );
      const facing = ctx.value(
        id,
        'azimuthDeg',
        p.s.it
          ? { measured: { v: p.facing, q: measuredBy(p.s.it.support) }, inferred: p.facing }
          : { inferred: p.facing },
      );
      const f = dirOf(facing.v);
      const rgt = dirOf(facing.v + 90);
      const pipeR = PIPE_D / 2;
      // the antenna's back overlaps its mount pipe by a centimetre
      const back = size[2] / 2 + pipeR - 0.01;
      let centre: Vec3;
      if (p.centre) centre = p.centre;
      else {
        const d = reach(facing.v, level.y) + STANDOFF + back;
        centre = [
          b[0] + d * f[0] + p.offset * rgt[0],
          level.y,
          b[2] + d * f[2] + p.offset * rgt[2],
        ];
      }
      const centreQ: ParamQuality = p.s.it
        ? { basis: 'measured', ...measuredBy(p.s.it.support) }
        : { basis: level.basis === 'user' ? 'user' : 'inferred' };
      const pipe: Vec3 = [centre[0] - back * f[0], centre[1], centre[2] - back * f[2]];
      // arms from the pipe back to the host surface at this height (a little into it)
      const along = (pipe[0] - b[0]) * f[0] + (pipe[2] - b[2]) * f[2];
      const arm = Math.max(0.1, along - reach(facing.v, pipe[1]) + MOUNT_EMBED);
      const mountId = id.replace(/^antenna-/, 'mount-');
      const mountKind = ctx.value<MountKind>(
        mountId,
        'kind',
        ai(mountC, isMountKind(aiMount) ? aiMount : undefined, 'standoff'),
      );
      const mount = make(
        ctx,
        'antennaMount',
        mountId,
        {
          kind: mountKind.v,
          centre: pipe,
          azimuthDeg: facing.v,
          size: [PIPE_D, size[1] + 0.4, arm],
        },
        {
          category: 'Antenna mounts',
          name: `Mount ${role.slice(8).toUpperCase()}-${String(indexInRole(role, id) ?? i + 1)}`,
          description:
            mountC?.description ?? 'Standoff mount: a pipe on arms back to the structure.',
          parent: hostId,
          quality: {
            kind: mountKind.q,
            centre: { basis: centreQ.basis === 'measured' ? 'inferred' : centreQ.basis },
            azimuthDeg: { basis: facing.q.basis },
            size: { basis: 'inferred' },
          },
        },
      );
      const antenna = make(
        ctx,
        'antenna',
        id,
        { kind: kind.v, centre, azimuthDeg: facing.v, tiltDeg: tilt.v, size },
        {
          category: 'Antennas',
          name: `Antenna ${role.slice(8).toUpperCase()}-${String(indexInRole(role, id) ?? i + 1)}`,
          description: c?.description ?? 'Antenna on its mount.',
          parent: mountId,
          quality: {
            kind: kind.q,
            centre: centreQ,
            azimuthDeg: facing.q,
            tiltDeg: tilt.q,
            size: l.q,
          },
          unobserved: ctx.unobserved(centreQ.basis),
          measured: !!p.s.it,
        },
      );
      return { id, mount, antenna };
    });
    made
      .sort((x, y) => (indexInRole(role, x.id) ?? 0) - (indexInRole(role, y.id) ?? 0))
      .forEach((m) => out.push(m.mount, m.antenna));
  });
  // sector by sector in number order (the sort is stable within a sector)
  const sectorOf = (a: Assembly) => Number(/-s([1-9][0-9]*)-/.exec(a.id)?.[1] ?? 0);
  return out.sort((p, q) => sectorOf(p) - sectorOf(q));
}

/** Ladders, platforms and cabinets the proposal shows, placed by rule round the host. */
function towerExtras(
  ctx: FamilyCtx,
  hostId: string,
  reach: HostReach,
  around: (y: number) => number,
  busy: readonly number[],
  /** World height ranges the antennas and their mounts take up. */
  spans: readonly (readonly [number, number])[],
): Assembly[] {
  const H = ctx.height;
  const b = ctx.base;
  const top = b[1] + H;
  const out: Assembly[] = [];
  const inferred: ParamQuality = { basis: 'inferred' };
  const want = (kind: 'ladder' | 'ringPlatform' | 'cabinet', role: string) => {
    const cs = ctx.proposals(kind);
    const n = ctx.userCount(role) ?? cs.reduce((s, c) => s + c.count, 0);
    return { c: cs[0], n: Math.max(0, n) };
  };
  // a bearing clear of the antennas (the middle of the widest gap) unless the AI saw one
  const free = busy.length ? (gapFill(busy, 1)[0] ?? 180) : 180;
  const bearings = (c: ProposalComponent | undefined, n: number) => {
    const first = num(c, 'azimuthDeg');
    return evenFrom(first !== undefined ? ((first % 360) + 360) % 360 : free, n);
  };

  {
    const { c, n } = want('ladder', 'ladder');
    const azs = bearings(c, n);
    const ids = ctx.ids(
      'ladder',
      azs.map((az) => ({ azimuthDeg: az, y: b[1] })),
    );
    azs.forEach((az, i) => {
      const id = ids[i] ?? `ladder-${String(i + 1)}`;
      const width = ctx.value(id, 'width', ai(c, ctx.len(c, 'width'), 0.5));
      const cage = ctx.value(id, 'cage', ai(c, bool(c, 'cage'), false));
      out.push(
        make(
          ctx,
          'ladder',
          id,
          {
            bottom: toward(b, az, reach(az, b[1]) + 0.3, b[1]),
            top: toward(b, az, reach(az, top) + 0.3, top),
            width: width.v,
            rungSpacing: 0.3,
            cage: cage.v,
          },
          {
            category: 'Access',
            name: `Ladder ${String(indexInRole('ladder', id) ?? i + 1)}`,
            description: c?.description ?? 'Climbing ladder from the foot to the top.',
            parent: hostId,
            quality: {
              bottom: inferred,
              top: inferred,
              width: width.q,
              rungSpacing: inferred,
              cage: cage.q,
            },
          },
        ),
      );
    });
  }

  // platforms: a plate round the structure with a hole it passes through, and a rail when seen
  {
    const { c, n } = want('ringPlatform', 'platform');
    const user = ctx.userLevels('platform');
    const aiLevels = ctx.proposals('ringPlatform').flatMap((p) => p.levels ?? []);
    const hs: { h: number; basis: ValueBasis }[] = user
      ? user.map((h) => ({ h, basis: 'user' }))
      : aiLevels.length
        ? aiLevels.map((r) => ({ h: r * H, basis: c?.observed ? 'observed' : 'inferred' }))
        : Array.from({ length: n }, (_, k) => ({ h: ((k + 1) * H) / (n + 1), basis: 'inferred' }));
    // a deck inside the antennas' height would cut them: it moves just below the lowest it meets
    const thickness = 0.1;
    const clearOf = (h: number): number => {
      let y = b[1] + h;
      for (let guard = 0; guard < 40; guard++) {
        const hits = spans.filter(([lo, hi]) => y > lo - CLEAR && y - thickness < hi + CLEAR);
        if (!hits.length) break;
        y = Math.min(...hits.map(([lo]) => lo)) - CLEAR;
      }
      return y - b[1];
    };
    const levels = hs
      .filter((l) => l.h > 0.5 && l.h < H)
      .slice(0, user ? undefined : n)
      .map((l): { h: number; basis: ValueBasis; note?: string } => {
        // the person's own level is kept as they set it
        const h = l.basis === 'user' ? l.h : clearOf(l.h);
        if (Math.abs(h - l.h) < 1e-9) return l;
        const note = `Moved from ${l.h.toFixed(2)} m to clear the antennas.`;
        ctx.note(
          `A platform at ${l.h.toFixed(1)} m would cut the antennas: moved below the antennas, to ${h.toFixed(1)} m.`,
        );
        return { h, basis: 'inferred', note };
      })
      .filter((l) => l.h > 0.5);
    const ids = ctx.ids(
      'platform',
      levels.map((l) => ({ y: b[1] + l.h })),
    );
    const railIds = ctx.ids(
      'platform-rail',
      levels.map((l) => ({ y: b[1] + l.h })),
    );
    const railed = bool(c, 'guardrail') === true;
    levels.forEach((l, i) => {
      const id = ids[i] ?? `platform-${String(i + 1)}`;
      const y = b[1] + l.h;
      const hole = Math.max(around(y), around(y - thickness)) + 0.05;
      const width = ctx.value(id, 'outline', ai(c, ctx.len(c, 'width'), 1.2));
      const rOut = hole + width.v;
      const ring = (r: number, k: number): [number, number] => {
        const t = (2 * Math.PI * k) / 48;
        return [b[0] + r * Math.cos(t), b[2] + r * Math.sin(t)];
      };
      out.push(
        make(
          ctx,
          'deck',
          id,
          {
            y,
            outline: Array.from({ length: 48 }, (_, k) => ring(rOut, k)),
            thickness,
            openings: [{ centre: [b[0], b[2]], r: hole }],
          },
          {
            category: 'Access',
            name: `Platform ${String(indexInRole('platform', id) ?? i + 1)}`,
            description: c?.description ?? 'Platform round the structure.',
            parent: hostId,
            quality: {
              y: l.note === undefined ? { basis: l.basis } : { basis: l.basis, note: l.note },
              outline: width.q,
              thickness: inferred,
              openings: inferred,
            },
          },
        ),
      );
      if (railed) {
        const railId = railIds[i] ?? `platform-rail-${String(i + 1)}`;
        const rr = rOut - 0.1;
        const loop = Array.from({ length: 25 }, (_, k): Vec3 => {
          const [x, z] = ring(rr, 2 * (k % 24));
          return [x, y, z];
        });
        out.push(
          make(
            ctx,
            'guardrail',
            railId,
            { path: loop, height: 1.1, posts: 1.5, rails: 2 },
            {
              category: 'Access',
              name: `Platform guardrail ${String(indexInRole('platform-rail', railId) ?? i + 1)}`,
              description: 'Guardrail round the platform edge.',
              parent: id,
              quality: { path: inferred, height: inferred, posts: inferred, rails: inferred },
            },
          ),
        );
      }
    });
  }

  {
    const { c, n } = want('cabinet', 'cabinet');
    const azs = bearings(c, n);
    const ids = ctx.ids(
      'cabinet',
      azs.map((az) => ({ azimuthDeg: az })),
    );
    azs.forEach((az, i) => {
      const id = ids[i] ?? `cabinet-${String(i + 1)}`;
      out.push(
        make(
          ctx,
          'cabinet',
          id,
          { base: toward(b, az, around(b[1]) + 2.5, b[1]), size: [1.2, 2, 0.8], yawDeg: -az },
          {
            category: 'Equipment',
            name: `Cabinet ${String(indexInRole('cabinet', id) ?? i + 1)}`,
            description: c?.description ?? 'Equipment cabinet at the foot.',
            quality: { base: inferred, size: inferred, yawDeg: inferred },
          },
        ),
      );
    });
  }
  return out;
}

const PLACED = new Set<string>([
  'antenna',
  'antennaMount',
  'warningLight',
  'ladder',
  'ringPlatform',
  'cabinet',
]);

/** Bearings the antennas face (to keep ladders and cabinets clear of them). */
const facingsIn = (list: readonly Assembly[]) =>
  list.flatMap((a) => (a.kind === 'antenna' ? [a.params.azimuthDeg] : []));
/** Height ranges of the antennas and mounts in `list`. */
const spansIn = (list: readonly Assembly[]) =>
  list.flatMap((a): (readonly [number, number])[] =>
    a.kind === 'antenna' || a.kind === 'antennaMount'
      ? [[a.params.centre[1] - a.params.size[1] / 2, a.params.centre[1] + a.params.size[1] / 2]]
      : [],
  );

export const assembleLattice: FamilyAssembler = (ctx) => {
  const b = ctx.base;
  const c = ctx.proposals('lattice')[0];
  const [id = 'lattice-1'] = ctx.ids('lattice', [{ y: b[1] }]);
  const lattice = latticeOf(ctx, id, c, {
    name: 'Lattice tower',
    category: 'Structure',
    description: 'Lattice tower: legs, horizontals and bracing, bay by bay.',
  });
  const reach = latticeReach(lattice.params);
  const p = lattice.params;
  const around = (y: number) =>
    Math.max(...latticeLegAt(p, y).map((q) => Math.hypot(q[0] - p.base[0], q[2] - p.base[2]))) +
    p.legSection / 2;
  const ants = antennas(ctx, id, reach);
  const out: Assembly[] = [lattice, ...ants];
  out.push(...lights(ctx, id, { reach, description: 'Aviation warning light on the tower.' }));
  out.push(...towerExtras(ctx, id, reach, around, facingsIn(ants), spansIn(ants)));
  noteUnplaced(ctx, new Set([...PLACED, 'lattice']), 'lattice tower');
  return out;
};

export const assembleMonopole: FamilyAssembler = (ctx) => {
  const H = ctx.height;
  const b = ctx.base;
  const c = ctx.proposals('monopole')[0] ?? ctx.proposals('shaft')[0];
  const [id = 'pole-1'] = ctx.ids('pole', [{ y: b[1] }]);
  const profile = profileOf(ctx, id, c, [
    { y: 0, r: clamp(H / 40, 0.3, 1.2) },
    { y: H, r: clamp(H / 80, 0.15, 0.6) },
  ]);
  ctx.setHost({ base: b, profile: profile.v });
  const aiSides = num(c, 'sides');
  const sidesOk = (s: number | undefined) =>
    s !== undefined && (s === 0 || (Number.isInteger(s) && s >= 8 && s <= 18));
  const sides = ctx.value<number>(id, 'sides', ai(c, sidesOk(aiSides) ? aiSides : undefined, 0));
  const coverage = sliceCoverage(ctx);
  const pole = make(
    ctx,
    'monopole',
    id,
    { base: b, profile: profile.v, sides: sidesOk(sides.v) ? sides.v : 0 },
    {
      category: 'Structure',
      name: 'Monopole',
      description: c?.description ?? 'Monopole: one tapered steel pole.',
      quality: { base: ctx.baseQuality, profile: profile.q, sides: sides.q },
      unobserved: coverage !== undefined && coverage < 0.5 ? ['back'] : undefined,
      measured: profile.q.basis === 'measured',
    },
  );
  const reach: HostReach = (_az, y) => ctx.radiusAt(y);
  const ants = antennas(ctx, id, reach);
  const out: Assembly[] = [pole, ...ants];
  out.push(...lights(ctx, id, { reach, description: 'Aviation warning light on the pole.' }));
  out.push(...towerExtras(ctx, id, reach, (y) => ctx.radiusAt(y), facingsIn(ants), spansIn(ants)));
  noteUnplaced(ctx, new Set([...PLACED, 'monopole', 'shaft']), 'monopole');
  return out;
};
