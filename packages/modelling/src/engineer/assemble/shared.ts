/**
 * Helpers the family templates share (chimney, flare, telecom): proposal values as candidates,
 * one draft assembly, the measured profile of a shaft or pole, component counts by precedence,
 * and the warning lights per level (count rule, level roles and lens placement off a host).
 *
 * Compass azimuths: 0 north (-z), 90 east (+x). Heights of levels are metres above the asset base.
 */
import type {
  Assembly,
  AssemblyKind,
  AssemblyParams,
  MemberGroup,
  ParamQuality,
  ProposalComponent,
  ValueBasis,
  Vec3,
} from '@aio/schema';
import { warningLightSurface } from '../builders/lights';
import type { Candidates, FamilyCtx } from './assemble';
import { azimuthDeg, indexInRole } from './ids';

export type MemberItem = MemberGroup['items'][number];
export type Profile = { y: number; r: number }[];
export type Unobserved = NonNullable<Assembly['unobserved']>;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const mean = (xs: readonly number[]) =>
  xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
/** Horizontal unit vector towards compass bearing `az`. */
export const dirOf = (az: number): Vec3 => {
  const t = (az * Math.PI) / 180;
  return [Math.sin(t), 0, -Math.cos(t)];
};
/** The point `r` out from the axis through `b` towards `az`, at world height `y`. */
export const toward = (b: Vec3, az: number, r: number, y: number): Vec3 => {
  const d = dirOf(az);
  return [b[0] + r * d[0], y, b[2] + r * d[2]];
};
const RANK: Record<ValueBasis, number> = { user: 4, measured: 3, observed: 2, inferred: 1 };
export const weakest = (...bs: ValueBasis[]): ValueBasis =>
  bs.reduce((w, b) => (RANK[b] < RANK[w] ? b : w), 'user');

/** `n` bearings evenly spaced from `start`. */
export function evenFrom(start: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (((start + (360 * i) / n) % 360) + 360) % 360);
}

/** `k` new bearings, each in the middle of the widest gap left between `have` and those before. */
export function gapFill(have: readonly number[], k: number): number[] {
  if (k <= 0) return [];
  if (!have.length) return evenFrom(0, k);
  const all = [...have];
  const added: number[] = [];
  for (let i = 0; i < k; i++) {
    const s = [...all].sort((a, b) => a - b);
    let best = { at: 0, gap: -1 };
    s.forEach((a, j) => {
      const b = j + 1 < s.length ? (s[j + 1] ?? a) : (s[0] ?? a) + 360;
      if (b - a > best.gap + 1e-9) best = { at: a, gap: b - a };
    });
    const mid = (best.at + best.gap / 2) % 360;
    all.push(mid);
    added.push(mid);
  }
  return added;
}

/** A proposal value as candidates: the AI's value is observed only when the AI saw the thing. */
export function ai<T>(
  c: ProposalComponent | undefined,
  v: T | undefined,
  fallback: T,
): Candidates<T> {
  if (v === undefined || !c) return { inferred: fallback };
  return c.observed ? { observed: v, inferred: fallback } : { inferred: v };
}

export const str = (c: ProposalComponent | undefined, key: string) => {
  const v = c?.params[key];
  return typeof v === 'string' ? v : undefined;
};
export const num = (c: ProposalComponent | undefined, key: string) => {
  const v = c?.params[key];
  return typeof v === 'number' ? v : undefined;
};
export const bool = (c: ProposalComponent | undefined, key: string) => {
  const v = c?.params[key];
  return typeof v === 'boolean' ? v : undefined;
};

export interface Meta {
  category: string;
  name: string;
  description: string;
  quality: Record<string, ParamQuality>;
  parent?: string | undefined;
  unobserved?: Unobserved | undefined;
  measured?: boolean;
}

/** One draft assembly made by this run. */
export function make<K extends AssemblyKind>(
  ctx: FamilyCtx,
  kind: K,
  id: string,
  params: AssemblyParams<K>,
  m: Meta,
): Assembly {
  const a = {
    id,
    kind,
    params,
    name: m.name,
    description: m.description,
    category: m.category,
    status: 'draft' as const,
    origin: ctx.origin,
    quality: m.quality,
    sources: ctx.sources(kind, { measured: m.measured ?? false, id }),
    ...(m.parent === undefined ? {} : { parent: m.parent }),
    ...(m.unobserved?.length ? { unobserved: m.unobserved } : {}),
  };
  // the kind and its params are paired by the generic signature; the union cannot see it
  return a as unknown as Assembly;
}

export const measuredBy = (support: number, residualM?: number): Omit<ParamQuality, 'basis'> => ({
  support: Math.max(0, Math.round(support)),
  ...(residualM === undefined ? {} : { residualM }),
});

/** A profile of heights above the base, clipped to `[0, H]`, starting at 0 and ending at H. */
export function toProfile(
  pts: readonly { y: number; r: number }[],
  H: number,
): Profile | undefined {
  const sorted = pts.filter((q) => Number.isFinite(q.y) && q.r > 0).sort((a, b) => a.y - b.y);
  const out: Profile = [];
  for (const q of sorted) {
    const y = clamp(q.y, 0, H);
    const last = out.at(-1);
    if (last && y <= last.y + 1e-6) continue;
    out.push({ y, r: q.r });
  }
  const first = out[0];
  if (!first) return undefined;
  if (first.y > 1e-6) out.unshift({ y: 0, r: first.r });
  const last = out.at(-1);
  if (last && last.y < H - 1e-6) out.push({ y: H, r: last.r });
  if (out.length < 2) return undefined;
  if (out.length <= 64) return out;
  const step = (out.length - 1) / 63;
  return Array.from({ length: 64 }, (_, i) => out[Math.round(i * step)]).filter(
    (q): q is { y: number; r: number } => q !== undefined,
  );
}

/**
 * The outer profile of a shaft or pole `id` by precedence: the measured taper (metric evidence),
 * else the AI's `rBase`, `rTop` (and `taperTop`) ratios or metres, else `fallback`.
 * `measured: false` skips the taper (when it measures something else: a lattice round a riser).
 */
export function profileOf(
  ctx: FamilyCtx,
  id: string,
  c: ProposalComponent | undefined,
  fallback: Profile,
  o: { measured?: boolean } = {},
): { v: Profile; q: ParamQuality } {
  const H = ctx.height;
  const b = ctx.base;
  const ev = ctx.metric && o.measured !== false ? ctx.input.evidence : null;
  const taper = ev?.taper;
  const measuredProfile =
    taper && taper.profile.length >= 2
      ? toProfile(
          taper.profile.map((q) => ({ y: q.y - b[1], r: q.r })),
          H,
        )
      : undefined;
  const slices = ev?.slices ?? [];
  const rB = ctx.len(c, 'rBase');
  const rT = ctx.len(c, 'rTop') ?? rB;
  const tT = ctx.len(c, 'taperTop');
  const aiProfile =
    rB !== undefined && rT !== undefined
      ? [
          { y: 0, r: rB },
          ...(tT !== undefined && tT > 0 && tT < H ? [{ y: tT, r: rT }] : []),
          { y: H, r: rT },
        ]
      : undefined;
  return ctx.value<Profile>(id, 'profile', {
    ...(measuredProfile && taper
      ? {
          measured: {
            v: measuredProfile,
            q: {
              ...measuredBy(
                slices.reduce((s, q) => s + q.support, 0),
                taper.residualM,
              ),
              ...(slices.length
                ? { coverage: clamp(mean(slices.map((q) => q.coverage)), 0, 1) }
                : {}),
            },
          },
        }
      : {}),
    ...ai(c, aiProfile, fallback),
  });
}

/** The member group of `kind` in metric evidence. */
export function group(ctx: FamilyCtx, kind: MemberGroup['kind']): MemberGroup | undefined {
  return ctx.metric ? ctx.input.evidence?.members.find((g) => g.kind === kind) : undefined;
}

/** The bearing of a member from the asset axis (its own azimuth when the evidence gives one). */
export const itemAz = (ctx: FamilyCtx, it: MemberItem): number =>
  it.azimuthDeg ?? azimuthDeg(it.centre[0] - ctx.base[0], it.centre[2] - ctx.base[2]);

/** Strongest first, then by bearing. */
export const bySupport = (ctx: FamilyCtx) => (a: MemberItem, b: MemberItem) =>
  b.support - a.support || itemAz(ctx, a) - itemAz(ctx, b);

export const byIndex = (role: string) => (a: Assembly, b: Assembly) =>
  (indexInRole(role, a.id) ?? 0) - (indexInRole(role, b.id) ?? 0);

/** Mean unobserved coverage of the slices (undefined without metric slices). */
export function sliceCoverage(ctx: FamilyCtx): number | undefined {
  const slices = ctx.metric ? (ctx.input.evidence?.slices ?? []) : [];
  return slices.length ? mean(slices.map((q) => q.coverage)) : undefined;
}

/**
 * A component count: the person's, else the AI's when it saw them, else the evidence's, else the
 * AI's guess, else none. When the AI and the evidence disagree the choice is noted as unresolved.
 * (A partial cloud undercounts and photos miss things, so neither is silently blended.)
 */
export function chooseCount(
  ctx: FamilyCtx,
  o: {
    what: string;
    user: number | undefined;
    proposed: readonly ProposalComponent[];
    evidence: number | undefined;
  },
): { n: number; basis: ValueBasis } {
  const aiN = o.proposed.length ? o.proposed.reduce((s, c) => s + c.count, 0) : undefined;
  const aiSaw = o.proposed.some((c) => c.observed);
  const pick: { n: number; basis: ValueBasis; from: string } =
    o.user !== undefined
      ? { n: o.user, basis: 'user', from: 'your count' }
      : aiN !== undefined && aiSaw
        ? { n: aiN, basis: 'observed', from: 'the AI count' }
        : o.evidence !== undefined
          ? { n: o.evidence, basis: 'measured', from: 'the measured count' }
          : { n: aiN ?? 0, basis: 'inferred', from: 'the AI guess' };
  if (aiN !== undefined && o.evidence !== undefined && aiN !== o.evidence)
    ctx.note(
      `The AI counts ${String(aiN)} ${o.what}, the measurements ${String(o.evidence)}: ${String(pick.n)} used (${pick.from}).`,
    );
  return { n: Math.max(0, pick.n), basis: pick.basis };
}

/** Kinds every family places only when the proposal or the person asks for them. */
export function noteUnplaced(ctx: FamilyCtx, placed: ReadonlySet<string>, template: string): void {
  for (const c of ctx.input.proposal?.components ?? [])
    if (c.count > 0 && !placed.has(c.kind) && /^[a-zA-Z]+$/.test(c.kind))
      ctx.note(`The ${template} template does not place "${c.kind}" components (${c.role}).`);
}

// -- warning lights ------------------------------------------------------------------------------

/**
 * Distance from the asset axis to the host surface towards bearing `az` at world height `y`: the
 * shaft or pole radius, or the lattice face or leg there.
 */
export type HostReach = (az: number, y: number) => number;

const FIXTURES = ['single', 'twin', 'canister', 'beacon'] as const;
const isFixture = (s: string | undefined): s is (typeof FIXTURES)[number] =>
  FIXTURES.some((f) => f === s);

/** Lens centre of a light at world height `y` towards `az`: the surface there plus `size`. */
function lightCentre(
  ctx: FamilyCtx,
  reach: HostReach,
  az: number,
  y: number,
  size: number,
  fixture: AssemblyParams<'warningLight'>['fixture'],
): { centre: Vec3; outward: Vec3 } {
  const outward = dirOf(az);
  let centre = toward(ctx.base, az, reach(az, y) + size, y);
  // the bracket meets the surface a little below the lens: use the reach there
  const sy = warningLightSurface({ fixture, centre, outward, size })[1];
  centre = toward(ctx.base, az, reach(az, sy) + size, y);
  return { centre, outward };
}

/** A human-readable note on a moved light's centre quality (display only; nothing reads it). */
const movedNote = (h: number) => `Level moved from ${h.toFixed(2)} m.`;

/**
 * Roles (`light-l<n>`) of the intermediate light levels. A level near (within `tol`) a level of
 * the previous model keeps that level's role, each previous level compared at the height it was
 * found at (its lights' `levelFoundAt`, which survives a move by the person); previous levels
 * the person moved that carry no found height pair with the levels left over, in height order;
 * new levels are numbered after the highest previous one. So a level found later never
 * renumbers the others, and `user.levels` keeps its target.
 */
function levelRoles(ctx: FamilyCtx, mid: readonly { h: number }[], tol: number): string[] {
  const byRole = new Map<string, { n: number; ys: number[] }>();
  for (const a of ctx.input.previous?.assemblies ?? []) {
    const m = /^light-l([1-9][0-9]*)-[1-9][0-9]*$/.exec(a.id);
    if (!m?.[1] || a.kind !== 'warningLight') continue;
    const role = `light-l${m[1]}`;
    const e = byRole.get(role) ?? { n: Number(m[1]), ys: [] };
    e.ys.push(a.params.levelFoundAt ?? a.params.centre[1] - ctx.base[1]);
    byRole.set(role, e);
  }
  const prev = [...byRole.entries()].map(([role, e]) => ({ role, n: e.n, h: mean(e.ys) }));
  const out: (string | undefined)[] = mid.map(() => undefined);
  const used = new Set<string>();
  const pairs = mid
    .flatMap((l, i) => prev.map((p) => ({ i, p, d: Math.abs(l.h - p.h) })))
    .filter((x) => x.d <= tol)
    .sort((x, y) => x.d - y.d || x.p.n - y.p.n || x.i - y.i);
  for (const { i, p } of pairs)
    if (out[i] === undefined && !used.has(p.role)) {
      out[i] = p.role;
      used.add(p.role);
    }
  const movedPrev = prev
    .filter((p) => !used.has(p.role) && ctx.userLevels(p.role) !== undefined)
    .sort((x, y) => x.h - y.h);
  const left = mid
    .map((l, i) => ({ h: l.h, i }))
    .filter((x) => out[x.i] === undefined)
    .sort((x, y) => x.h - y.h);
  movedPrev.forEach((p, k) => {
    const l = left[k];
    if (l) out[l.i] = p.role;
  });
  let next = prev.reduce((m, p) => Math.max(m, p.n), 0);
  for (const l of left) out[l.i] ??= `light-l${String(++next)}`;
  return out.map((r, i) => r ?? `light-l${String(i + 1)}`);
}

interface Level {
  role: string;
  h: number;
  basis: ValueBasis;
  items: MemberItem[];
}

/**
 * Warning lights per level on host `hostId`: levels from `light-candidate` clusters (measured)
 * and the proposal's levels, the crown within max(1.5, 2% H) of the top, counts by `chooseCount`,
 * bearings from the evidence (gaps filled) or evenly from north, each lens `size` off the host
 * surface (`reach`, default the host shaft radius) at the bracket height.
 */
export function lights(
  ctx: FamilyCtx,
  hostId: string,
  o: { reach?: HostReach; description?: string } = {},
): Assembly[] {
  const reach: HostReach = o.reach ?? ((_az, y) => ctx.radiusAt(y));
  const H = ctx.height;
  const b = ctx.base;
  const lightC = ctx.proposals('warningLight')[0];
  const lg = group(ctx, 'light-candidate');
  const tol = Math.max(1, 0.02 * H);
  // measured levels: candidates clustered by height
  const sorted = [...(lg?.items ?? [])].sort((p, q) => p.centre[1] - q.centre[1]);
  const clusters: MemberItem[][] = [];
  for (const it of sorted) {
    const c = clusters.at(-1);
    const lastY = c?.at(-1)?.centre[1];
    if (c && lastY !== undefined && it.centre[1] - lastY <= tol) c.push(it);
    else clusters.push([it]);
  }
  const levels: { h: number; basis: ValueBasis; items: MemberItem[] }[] = clusters.map((c) => ({
    h: mean(c.map((it) => it.centre[1])) - b[1],
    basis: 'measured',
    items: c,
  }));
  const aiBasis: ValueBasis = lightC?.observed ? 'observed' : 'inferred';
  for (const r of ctx.proposals('warningLight').flatMap((c) => c.levels ?? [])) {
    const h = r * H;
    if (!levels.some((l) => Math.abs(l.h - h) <= 0.04 * H))
      levels.push({ h: Math.min(h, H), basis: aiBasis, items: [] });
  }
  levels.sort((p, q) => p.h - q.h);
  const crownTol = Math.max(1.5, 0.02 * H);
  const last = levels.at(-1);
  const crown = last && last.h >= H - crownTol ? last : undefined;
  let mid = crown ? levels.slice(0, -1) : levels;
  const userAll = ctx.userLevels('light');
  if (userAll) {
    mid = userAll.map((h) => ({
      h,
      basis: 'user',
      items: levels.find((l) => l !== crown && Math.abs(l.h - h) <= 0.04 * H)?.items ?? [],
    }));
  }
  const midRoles = levelRoles(ctx, mid, 0.04 * H);
  const roles: Level[] = [
    ...mid.map((l, i) => ({ ...l, role: midRoles[i] ?? `light-l${String(i + 1)}` })),
    ...(crown ? [{ ...crown, h: H, role: 'light-crown' }] : []),
  ];
  const out: Assembly[] = [];
  for (const level of roles) {
    const moved = ctx.userLevels(level.role)?.[0];
    const h = moved ?? level.h;
    const levelBasis: ValueBasis = moved !== undefined ? 'user' : level.basis;
    const y = b[1] + h;
    const { n } = chooseCount(ctx, {
      what: `lights at ${h.toFixed(1)} m`,
      user: ctx.userCount(level.role) ?? ctx.userCount('light'),
      proposed: lightC ? [lightC] : [],
      evidence: level.basis === 'measured' ? level.items.length : undefined,
    });
    if (n <= 0) continue;
    const seen = [...level.items].sort(bySupport(ctx)).slice(0, n);
    const seenAz = seen.map((it) => itemAz(ctx, it));
    const userEven = ctx.userParam(level.role, 'arrangement') === 'even';
    const even = userEven || (!seen.length && str(lightC, 'arrangement') === 'even');
    const spot = (az: number, it: MemberItem | undefined, basis: ValueBasis) => ({ az, it, basis });
    const azs = userEven
      ? evenFrom(0, n).map((az) => spot(az, undefined, 'user'))
      : [
          ...seen.map((it, i) => spot(seenAz[i] ?? 0, it, 'measured')),
          ...(seen.length ? gapFill(seenAz, n - seen.length) : evenFrom(0, n)).map((az) =>
            spot(az, undefined, 'inferred'),
          ),
        ];
    if (!seen.length && !even)
      ctx.note(
        `The bearings of the lights at ${h.toFixed(1)} m are not known: they are spaced evenly from north as a guess.`,
      );
    const ids = ctx.ids(
      level.role,
      azs.map((a) => ({ azimuthDeg: a.az, y })),
    );
    const made = azs.map((a, i) => {
      const id = ids[i] ?? `${level.role}-${String(i + 1)}`;
      const aiFixture = str(lightC, 'fixture');
      const fixture = ctx.value<(typeof FIXTURES)[number]>(
        id,
        'fixture',
        ai(lightC, isFixture(aiFixture) ? aiFixture : undefined, 'twin'),
      );
      const aiSize = ctx.len(lightC, 'size');
      const size = ctx.value(
        id,
        'size',
        a.it && a.it.size > 0
          ? {
              measured: { v: a.it.size, q: measuredBy(a.it.support) },
              inferred: clamp(0.0035 * H, 0.2, 0.6),
            }
          : ai(lightC, aiSize, clamp(0.0035 * H, 0.2, 0.6)),
      );
      const { centre, outward } = lightCentre(ctx, reach, a.az, y, size.v, fixture.v);
      const posBasis = levelBasis === 'user' ? 'user' : weakest(levelBasis, a.basis);
      const centreQ: ParamQuality =
        moved !== undefined
          ? { basis: 'user', note: movedNote(level.h) }
          : posBasis === 'measured' && a.it
            ? { basis: 'measured', ...measuredBy(a.it.support) }
            : { basis: posBasis };
      const outQ: ParamQuality =
        a.basis === 'measured' && a.it
          ? { basis: 'measured', ...measuredBy(a.it.support) }
          : { basis: a.basis };
      return make(
        ctx,
        'warningLight',
        id,
        { fixture: fixture.v, centre, outward, size: size.v, levelFoundAt: level.h },
        {
          category: 'Lights',
          name: `${level.role === 'light-crown' ? 'Crown light' : `Light ${level.role.slice(6).toUpperCase()}`} ${String(indexInRole(level.role, id) ?? i + 1)}`,
          description:
            lightC?.description ?? o.description ?? 'Aviation warning light on the shaft.',
          parent: hostId,
          quality: { centre: centreQ, outward: outQ, fixture: fixture.q, size: size.q },
          unobserved: ctx.unobserved(centreQ.basis),
          measured: a.basis === 'measured',
        },
      );
    });
    out.push(...made.sort(byIndex(level.role)));
  }
  return out;
}
