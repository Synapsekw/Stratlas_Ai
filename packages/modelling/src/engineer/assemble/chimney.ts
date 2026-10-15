/**
 * The chimney family template (spec section 5.3): a shaft from the measured taper (else the AI's
 * ratios, else a straight 1:24 radius batter), flues on its crown with a deck under their mouths,
 * paint bands, warning lights per level, and only what the evidence or the proposal shows of
 * ladders, platforms, ducts, frames, pipe runs, cabinets, louvres and earthing, placed by simple
 * rules. Nothing is added because chimneys usually have it.
 *
 * Placement rules: profile heights are measured from the shaft base; flues stand inside the crown
 * bore less `FLUE_CLEARANCE` and clear of each other; deck openings are the flue radius plus 2 cm;
 * a light's `centre` is its lens, standing off the shaft surface at its height by its size.
 * Compass azimuths: 0 north (-z), 90 east (+x).
 */
import type {
  Assembly,
  AssemblyKind,
  EvidencePack,
  ParamQuality,
  ProposalComponent,
  ValueBasis,
  Vec3,
} from '@aio/schema';
import { DEFAULT_MATERIALS } from '../materials';
import type { FamilyAssembler, FamilyCtx } from './assemble';
import { indexInRole } from './ids';
import {
  ai,
  bool,
  bySupport,
  byIndex,
  chooseCount,
  clamp,
  dirOf,
  evenFrom,
  gapFill,
  group,
  itemAz,
  lights,
  make,
  mean,
  measuredBy,
  noteUnplaced,
  num,
  profileOf,
  str,
  toward,
  type Profile,
  type Unobserved,
} from './shared';

export { evenFrom, gapFill } from './shared';

/** Flues keep this far inside the crown bore (metres). */
export const FLUE_CLEARANCE = 0.15;
/** A deck opening is the flue's outer radius plus this. */
export const OPENING_CLEARANCE = 0.02;
/** A deck stops this far inside the bore. */
const DECK_EDGE = 0.1;

/** Deck openings for `flues` (outer radius plus `OPENING_CLEARANCE`), in flue id order. */
export function deckOpenings(
  flues: readonly Assembly[],
): { centre: [number, number]; r: number }[] {
  return flues
    .flatMap((f) =>
      f.kind === 'flue'
        ? [
            {
              n: indexInRole('flue', f.id) ?? 0,
              centre: [f.params.centre[0], f.params.centre[2]] as [number, number],
              r: f.params.rOuter + OPENING_CLEARANCE,
            },
          ]
        : [],
    )
    .sort((a, b) => a.n - b.n)
    .map(({ centre, r }) => ({ centre, r }));
}

/** sRGB 0..255 of a linear material colour. */
function srgb(lin: readonly number[]): number[] {
  return lin
    .slice(0, 3)
    .map((c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}
const dist3 = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/** The paint material nearest an sRGB colour. */
function paintFor(rgb: readonly number[]): string {
  let best = { id: 'paint-red', d: Infinity };
  for (const m of DEFAULT_MATERIALS)
    if (m.id.startsWith('paint-')) {
      const d = dist3(srgb(m.baseColor), rgb);
      if (d < best.d) best = { id: m.id, d };
    }
  return best.id;
}

/** Runs of colour that contrast with the body colour (the one covering most height). */
function contrastRuns(
  colours: EvidencePack['colours'],
  y0: number,
  y1: number,
): { y0: number; y1: number; rgb: number[] }[] {
  if (colours.length < 2) return [];
  const totals: { rgb: number[]; h: number }[] = [];
  for (const c of colours) {
    const t = totals.find((x) => dist3(x.rgb, c.rgb) < 40);
    if (t) t.h += c.y1 - c.y0;
    else totals.push({ rgb: [...c.rgb], h: c.y1 - c.y0 });
  }
  const body = totals.reduce((a, b) => (b.h > a.h ? b : a)).rgb;
  const runs: { y0: number; y1: number; rgb: number[] }[] = [];
  for (const c of [...colours].sort((a, b) => a.y0 - b.y0)) {
    if (dist3(c.rgb, body) <= 60) continue;
    const lo = Math.max(c.y0, y0);
    const hi = Math.min(c.y1, y1);
    if (hi - lo < 0.05) continue;
    const prev = runs.at(-1);
    if (prev && Math.abs(prev.y1 - lo) < 0.01 && dist3(prev.rgb, c.rgb) < 40) prev.y1 = hi;
    else runs.push({ y0: lo, y1: hi, rgb: [...c.rgb] });
  }
  return runs;
}

/** Kinds the chimney template places; other proposed kinds are listed as unresolved. */
const PLACED = new Set<string>([
  'shaft',
  'flue',
  'deck',
  'band',
  'warningLight',
  'guardrail',
  'ladder',
  'ringPlatform',
  'duct',
  'cabinet',
  'louvre',
  'pipeRun',
  'earthing',
  'frame',
]);

function build(ctx: FamilyCtx, shaftOnly: boolean): Assembly[] {
  const H = ctx.height;
  const b = ctx.base;
  const top = b[1] + H;
  const ev = ctx.metric ? ctx.input.evidence : null;
  const out: Assembly[] = [];

  // ---- shaft
  const shaftC = ctx.proposals('shaft')[0];
  const [shaftId = 'shaft-1'] = ctx.ids('shaft', [{ y: b[1] }]);
  const slices = ev?.slices ?? [];
  const defaultTop = 0.05 * H;
  const profile = profileOf(ctx, shaftId, shaftC, [
    { y: 0, r: defaultTop + H / 24 },
    { y: H, r: defaultTop },
  ]);
  ctx.setHost({ base: b, profile: profile.v });
  const rAt = (y: number) => ctx.radiusAt(y);
  const crownR = profile.v.at(-1)?.r ?? defaultTop;
  const minR = Math.min(...profile.v.map((q) => q.r));

  // flue count decides the open top
  const flueC = ctx.proposals('flue')[0];
  const flueGroup = shaftOnly ? undefined : group(ctx, 'flue');
  const userFlues = shaftOnly ? undefined : ctx.userCount('flue');
  const flueChoice = shaftOnly
    ? { n: 0, basis: 'inferred' as ValueBasis, prior: { n: 0, basis: 'inferred' as ValueBasis } }
    : chooseCount(ctx, {
        what: 'flues',
        user: userFlues,
        proposed: ctx.proposals('flue'),
        evidence: flueGroup?.items.length,
      });
  const flueCount = flueChoice.n;
  const openTop = flueCount > 0 || bool(shaftC, 'openTop') === true;
  // derived from the count, never the person's own value: with the person's count it keeps the
  // basis it had without it, or is inferred when their count changed it
  const priorOpen = flueChoice.prior.n > 0 || bool(shaftC, 'openTop') === true;
  const openTopBasis: ValueBasis =
    flueChoice.basis !== 'user'
      ? flueCount > 0
        ? flueChoice.basis
        : 'inferred'
      : priorOpen === openTop && flueChoice.prior.n > 0
        ? flueChoice.prior.basis
        : 'inferred';
  const aiWall = ctx.len(shaftC, 'wall');
  const wall =
    openTop || aiWall !== undefined
      ? ctx.value(shaftId, 'wall', ai(shaftC, aiWall, clamp(0.06 * crownR, 0.1, 0.45 * minR)))
      : undefined;
  const coverage = slices.length ? mean(slices.map((q) => q.coverage)) : undefined;
  const shaftHidden: Unobserved = [
    ...(coverage !== undefined && coverage < 0.5 ? (['back'] as const) : []),
    ...(openTop ? (['interior'] as const) : []),
  ];
  out.push(
    make(
      ctx,
      'shaft',
      shaftId,
      {
        base: b,
        profile: profile.v,
        openTop,
        ...(wall ? { wall: wall.v } : {}),
      },
      {
        category: 'Shaft',
        name: 'Shaft',
        description: shaftC?.description ?? 'Chimney shaft, its outer profile up the axis.',
        quality: {
          base: ctx.baseQuality,
          profile: profile.q,
          openTop: { basis: openTopBasis },
          ...(wall ? { wall: wall.q } : {}),
        },
        unobserved: shaftHidden,
        measured: profile.q.basis === 'measured',
      },
    ),
  );
  if (shaftOnly) return out;
  const wallM = wall?.v ?? 0;
  const boreTop = crownR - wallM;

  // ---- deck level (under the flue mouths)
  const deckY = top - clamp(0.025 * H, 0.5, 4);
  const deckT = clamp(0.0025 * H, 0.15, 0.4);
  const deckR = Math.min(boreTop, rAt(deckY) - wallM, rAt(deckY - deckT) - wallM) - DECK_EDGE;

  // ---- flues
  const flues: Assembly[] = [];
  if (flueCount > 0) {
    const seen = [...(flueGroup?.items ?? [])].sort(bySupport(ctx)).slice(0, flueCount);
    const seenAz = seen.map((it) => itemAz(ctx, it));
    const pitch = seen.length
      ? mean(seen.map((it) => Math.hypot(it.centre[0] - b[0], it.centre[2] - b[2])))
      : Math.min(ctx.len(flueC, 'pitchR') ?? 0.55 * crownR, boreTop - FLUE_CLEARANCE - 0.1);
    const newAz = seen.length ? gapFill(seenAz, flueCount - seen.length) : evenFrom(0, flueCount);
    const proud = ctx.len(flueC, 'proud') ?? clamp(0.01 * H, 0.3, 2);
    const mouthY = seen.length ? mean(seen.map((it) => it.centre[1])) : top + proud;
    const footY = deckY - deckT - clamp(0.005 * H, 0.3, 1);
    const all = [
      ...seen.map((it, i) => ({ az: seenAz[i] ?? 0, it })),
      ...newAz.map((az) => ({ az, it: undefined })),
    ].map((f) => ({
      ...f,
      centre: f.it
        ? ([f.it.centre[0], f.it.centre[1], f.it.centre[2]] as Vec3)
        : toward(b, f.az, pitch, mouthY),
    }));
    const ids = ctx.ids(
      'flue',
      all.map((f) => ({ azimuthDeg: f.az, y: f.centre[1] })),
    );
    const residualM = flueGroup?.metrics.residualM;
    all.forEach((f, i) => {
      const id = ids[i] ?? `flue-${String(i + 1)}`;
      const plan = (c: Vec3) => Math.hypot(c[0] - b[0], c[2] - b[2]);
      const nearest = Math.min(
        Infinity,
        ...all
          .filter((_, j) => j !== i)
          .map((g) => Math.hypot(g.centre[0] - f.centre[0], g.centre[2] - f.centre[2])),
      );
      const room = Math.min(boreTop - FLUE_CLEARANCE - plan(f.centre), nearest / 2 - 0.05);
      const rO = ctx.value(
        id,
        'rOuter',
        f.it && f.it.size > 0
          ? {
              measured: { v: f.it.size / 2, q: measuredBy(f.it.support, residualM) },
              inferred: 0.18 * crownR,
            }
          : ai(flueC, ctx.len(flueC, 'rOuter'), 0.18 * crownR),
      );
      if (rO.q.basis !== 'measured' && rO.q.basis !== 'user' && rO.v > room) {
        rO.v = Math.max(0.05, room);
        rO.q = { basis: 'inferred', note: 'Narrowed to fit inside the crown.' };
      }
      let rI = ctx.value(id, 'rInner', ai(flueC, ctx.len(flueC, 'rInner'), 0.88 * rO.v));
      if (rI.v >= rO.v && rI.q.basis !== 'user') rI = { v: 0.88 * rO.v, q: { basis: 'inferred' } };
      const height = ctx.value(id, 'height', { inferred: Math.max(0.5, f.centre[1] - footY) });
      const centreQ: ParamQuality = f.it
        ? { basis: 'measured', ...measuredBy(f.it.support, residualM) }
        : { basis: 'inferred' };
      flues.push(
        make(
          ctx,
          'flue',
          id,
          { centre: f.centre, rOuter: rO.v, rInner: rI.v, height: height.v },
          {
            category: 'Flues',
            name: `Flue ${String(indexInRole('flue', id) ?? i + 1)}`,
            description:
              flueC?.description ?? 'Flue liner standing out of the crown, open at its mouth.',
            parent: shaftId,
            quality: { centre: centreQ, rOuter: rO.q, rInner: rI.q, height: height.q },
            unobserved: ctx.unobserved(centreQ.basis),
            measured: !!f.it,
          },
        ),
      );
    });
    flues.sort(byIndex('flue'));
    out.push(...flues);

    const [deckId = 'deck-1'] = ctx.ids('deck', [{ y: deckY }]);
    const outline =
      Math.abs(b[0]) < 1e-9 && Math.abs(b[2]) < 1e-9
        ? { r: deckR }
        : Array.from({ length: 64 }, (_, k): [number, number] => {
            const t = (2 * Math.PI * k) / 64;
            return [b[0] + deckR * Math.cos(t), b[2] + deckR * Math.sin(t)];
          });
    out.push(
      make(
        ctx,
        'deck',
        deckId,
        { y: deckY, outline, thickness: deckT, openings: deckOpenings(flues) },
        {
          category: 'Deck',
          name: 'Deck',
          description: 'Deck inside the windshield under the flue mouths, open round each flue.',
          parent: shaftId,
          quality: {
            y: { basis: 'inferred' },
            outline: { basis: 'inferred' },
            thickness: { basis: 'inferred' },
            openings: { basis: 'inferred' },
          },
        },
      ),
    );
    const railC = ctx.proposals('guardrail')[0];
    if (railC && railC.count > 0) {
      const [railId = 'guardrail-1'] = ctx.ids('guardrail', [{ y: deckY }]);
      const h = ctx.value(railId, 'height', ai(railC, ctx.len(railC, 'height'), 1.1));
      out.push(
        make(
          ctx,
          'guardrail',
          railId,
          {
            path: { y: deckY, r: Math.max(0.2, deckR - 0.15), shaft: shaftId },
            height: h.v,
            posts: 1.5,
            rails: 2,
          },
          {
            category: 'Access',
            name: 'Deck guardrail',
            description: railC.description ?? 'Guardrail round the deck.',
            parent: deckId,
            quality: {
              path: { basis: 'inferred' },
              height: h.q,
              posts: { basis: 'inferred' },
              rails: { basis: 'inferred' },
            },
          },
        ),
      );
    }
  }

  // ---- bands
  const bandC = ctx.proposals('band')[0];
  const userBands = ctx.userLevels('band');
  const bandCount = ctx.userCount('band');
  const runs = ev ? contrastRuns(ev.colours, b[1], top) : [];
  const colourList = (str(bandC, 'colours') ?? str(bandC, 'colour') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const paintOf = (i: number): { v: string; basis: ValueBasis } => {
    const c = colourList.length ? colourList[i % colourList.length] : undefined;
    const id = c === undefined ? undefined : `paint-${c}`;
    return id !== undefined && DEFAULT_MATERIALS.some((m) => m.id === id)
      ? { v: id, basis: bandC?.observed ? 'observed' : 'inferred' }
      : { v: i % 2 ? 'paint-white' : 'paint-red', basis: 'inferred' };
  };
  const width = ctx.len(bandC, 'width') ?? clamp(0.03 * H, 0.5, 6);
  const bands: { y0: number; y1: number; q: ParamQuality; material: string; mq: ValueBasis }[] =
    userBands
      ? userBands.map((h, i) => {
          const p = paintOf(i);
          return {
            y0: b[1] + h,
            y1: Math.min(top, b[1] + h + width),
            q: { basis: 'user' },
            material: p.v,
            mq: p.basis,
          };
        })
      : runs.length
        ? runs.map((r) => ({
            y0: r.y0,
            y1: r.y1,
            q: { basis: 'measured' },
            material: paintFor(r.rgb),
            mq: 'measured',
          }))
        : (bandC?.levels ?? []).map((l, i) => {
            const p = paintOf(i);
            return {
              y0: b[1] + l * H,
              y1: Math.min(top, b[1] + l * H + width),
              q: { basis: bandC?.observed ? 'observed' : 'inferred' },
              material: p.v,
              mq: p.basis,
            };
          });
  const keptBands = bands
    .filter((x) => x.y1 - x.y0 > 0.01 && x.y0 >= b[1] - 1e-9)
    .slice(0, bandCount ?? bands.length);
  const bandIds = ctx.ids(
    'band',
    keptBands.map((x) => ({ y: x.y0 })),
  );
  keptBands
    .map((x, i) => ({ x, id: bandIds[i] ?? `band-${String(i + 1)}` }))
    .sort((p, q) => (indexInRole('band', p.id) ?? 0) - (indexInRole('band', q.id) ?? 0))
    .forEach(({ x, id }) => {
      out.push(
        make(
          ctx,
          'band',
          id,
          { shaft: shaftId, y0: x.y0, y1: x.y1, material: x.material },
          {
            category: 'Bands',
            name: `Band ${String(indexInRole('band', id) ?? 1)}`,
            description: 'Paint band round the shaft.',
            parent: shaftId,
            quality: { y0: x.q, y1: x.q, material: { basis: x.mq } },
            measured: x.q.basis === 'measured',
          },
        ),
      );
    });

  // ---- warning lights
  out.push(...lights(ctx, shaftId));

  // ---- what the proposal shows, placed by rule
  out.push(...extras(ctx, shaftId, profile.v, wallM));

  noteUnplaced(ctx, PLACED, 'chimney');
  return out;
}

/** Ladders, platforms, ducts, frames, pipe runs, cabinets, louvres and earthing the AI saw. */
function extras(ctx: FamilyCtx, shaftId: string, profile: Profile, wall: number): Assembly[] {
  const H = ctx.height;
  const b = ctx.base;
  const top = b[1] + H;
  const rAt = (y: number) => ctx.radiusAt(y);
  const out: Assembly[] = [];
  const inferred: ParamQuality = { basis: 'inferred' };
  const want = (kind: AssemblyKind, role: string) => {
    const cs = ctx.proposals(kind);
    const n = ctx.userCount(role) ?? cs.reduce((s, c) => s + c.count, 0);
    return { c: cs[0], n: Math.max(0, n) };
  };
  const bearings = (c: ProposalComponent | undefined, n: number, dflt: number) => {
    const first = num(c, 'azimuthDeg');
    const start = first !== undefined ? ((first % 360) + 360) % 360 : dflt;
    return evenFrom(start, n);
  };
  // how far a straight line from foot to crown would cut inside a bulging profile
  const r0 = profile[0]?.r ?? 1;
  const rH = profile.at(-1)?.r ?? r0;
  const bulge = Math.max(0, ...profile.map((q) => q.r - (r0 + ((rH - r0) * q.y) / H)));
  /** A path up the shaft surface at `az`, `off` out, from `yTop` down to the foot, then out. */
  const downTheShaft = (az: number, off: number, yTop: number, out: number): Vec3[] => {
    const inner = profile
      .map((q) => b[1] + q.y)
      .filter((y) => y > b[1] + 0.5 && y < yTop - 0.5)
      .sort((p, q) => q - p);
    const foot = b[1] + Math.max(0.05, off);
    return [
      toward(b, az, rAt(yTop) + off, yTop),
      ...inner.map((y) => toward(b, az, rAt(y) + off, y)),
      toward(b, az, rAt(foot) + off, foot),
      toward(b, az, rAt(foot) + off + out, foot),
    ];
  };

  // ladders on the north face (or where the AI saw them), foot to crown
  {
    const { c, n } = want('ladder', 'ladder');
    const azs = bearings(c, n, 0);
    const ids = ctx.ids(
      'ladder',
      azs.map((az) => ({ azimuthDeg: az, y: b[1] })),
    );
    azs.forEach((az, i) => {
      const id = ids[i] ?? `ladder-${String(i + 1)}`;
      const off = 0.3 + bulge;
      const width = ctx.value(id, 'width', ai(c, ctx.len(c, 'width'), 0.5));
      const cage = ctx.value(id, 'cage', ai(c, bool(c, 'cage'), false));
      out.push(
        make(
          ctx,
          'ladder',
          id,
          {
            bottom: toward(b, az, rAt(b[1]) + off, b[1]),
            top: toward(b, az, rAt(top) + off, top),
            width: width.v,
            rungSpacing: 0.3,
            cage: cage.v,
          },
          {
            category: 'Access',
            name: `Ladder ${String(indexInRole('ladder', id) ?? i + 1)}`,
            description: c?.description ?? 'Access ladder from the foot to the crown.',
            parent: shaftId,
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

  // ring platforms at the proposed levels, with a guardrail when the AI saw one
  {
    const { c, n } = want('ringPlatform', 'platform');
    const user = ctx.userLevels('platform');
    const aiLevels = ctx.proposals('ringPlatform').flatMap((p) => p.levels ?? []);
    const hs: { h: number; basis: ValueBasis }[] = user
      ? user.map((h) => ({ h, basis: 'user' }))
      : aiLevels.length
        ? aiLevels.map((r) => ({ h: r * H, basis: c?.observed ? 'observed' : 'inferred' }))
        : Array.from({ length: n }, (_, k) => ({ h: ((k + 1) * H) / (n + 1), basis: 'inferred' }));
    const levels = hs.filter((l) => l.h > 0.5 && l.h < H).slice(0, user ? undefined : n);
    const ids = ctx.ids(
      'platform',
      levels.map((l) => ({ y: b[1] + l.h })),
    );
    const railed = bool(c, 'guardrail') === true;
    const railIds = ctx.ids(
      'platform-rail',
      levels.map((l) => ({ y: b[1] + l.h })),
    );
    levels.forEach((l, i) => {
      const id = ids[i] ?? `platform-${String(i + 1)}`;
      const y = b[1] + l.h;
      const thickness = 0.1;
      const rIn = Math.max(rAt(y), rAt(y - thickness)) + 0.05;
      const width = ctx.value(id, 'rOuter', ai(c, ctx.len(c, 'width'), clamp(0.01 * H, 0.8, 1.5)));
      const rOut = rIn + width.v;
      out.push(
        make(
          ctx,
          'ringPlatform',
          id,
          { y, rInner: rIn, rOuter: rOut, thickness, shaft: shaftId },
          {
            category: 'Access',
            name: `Platform ${String(indexInRole('platform', id) ?? i + 1)}`,
            description: c?.description ?? 'Ring platform round the shaft.',
            parent: shaftId,
            quality: {
              y: { basis: l.basis },
              rInner: inferred,
              rOuter: width.q,
              thickness: inferred,
            },
          },
        ),
      );
      if (railed) {
        const railId = railIds[i] ?? `platform-rail-${String(i + 1)}`;
        out.push(
          make(
            ctx,
            'guardrail',
            railId,
            { path: { y, r: rOut - 0.1, shaft: shaftId }, height: 1.1, posts: 1.5, rails: 2 },
            {
              category: 'Access',
              name: `Platform guardrail ${String(indexInRole('platform-rail', railId) ?? i + 1)}`,
              description: 'Guardrail round the platform edge.',
              parent: id,
              quality: {
                path: inferred,
                height: inferred,
                posts: inferred,
                rails: inferred,
              },
            },
          ),
        );
      }
    });
  }

  // ducts from the entry height radially outward (east unless the AI saw a bearing)
  const ductC = want('duct', 'duct');
  const ductAz = bearings(ductC.c, ductC.n, 90);
  const ductInfo: { az: number; y: number; w: number; h: number }[] = [];
  {
    const { c } = ductC;
    const ids = ctx.ids(
      'duct',
      ductAz.map((az) => ({ azimuthDeg: az })),
    );
    const region = ctx.input.setup.region;
    ductAz.forEach((az, i) => {
      const id = ids[i] ?? `duct-${String(i + 1)}`;
      const entry = num(c, 'entryRatio');
      const y = b[1] + (entry !== undefined && entry > 0 && entry < 1 ? entry : 0.04) * H;
      const rS = rAt(y);
      const w = clamp(ctx.len(c, 'width') ?? 0.15 * rS, 0.3, 3);
      const h = clamp(ctx.len(c, 'height') ?? 0.75 * w, 0.3, 3);
      const reach =
        ctx.input.scope === 'asset-and-surroundings'
          ? region && 'radiusM' in region && region.radiusM > rS + 5
            ? region.radiusM
            : rS * 4
          : rS + Math.max(5, rS);
      ductInfo.push({ az, y, w, h });
      out.push(
        make(
          ctx,
          'duct',
          id,
          {
            path: [toward(b, az, reach, y), toward(b, az, rS - Math.min(0.1, wall || 0.1), y)],
            section: { rect: [w, h] },
          },
          {
            category: 'Lines',
            name: `Duct ${String(indexInRole('duct', id) ?? i + 1)}`,
            description: c?.description ?? 'Flue gas duct entering the shaft.',
            parent: shaftId,
            quality: {
              path: inferred,
              section: { basis: ctx.len(c, 'width') && c?.observed ? 'observed' : 'inferred' },
            },
          },
        ),
      );
    });
  }

  // frames under the ducts
  {
    const { c, n } = want('frame', 'frame');
    const azs = Array.from({ length: n }, (_, i) => ductInfo[i]?.az ?? bearings(c, n, 90)[i] ?? 90);
    const ids = ctx.ids(
      'frame',
      azs.map((az) => ({ azimuthDeg: az })),
    );
    azs.forEach((az, i) => {
      const id = ids[i] ?? `frame-${String(i + 1)}`;
      const d = ductInfo[i];
      const height = Math.max(1, d ? d.y - d.h / 2 - b[1] : 2.5);
      const span = Math.max(1, d ? d.w + 1 : 3);
      out.push(
        make(
          ctx,
          'frame',
          id,
          {
            kind: 'portal',
            base: toward(b, az, rAt(b[1]) + 4, b[1]),
            span,
            height,
            yawDeg: -az,
            bays: 1,
            braced: bool(c, 'braced') ?? false,
            member: 0.2,
          },
          {
            category: 'Structure',
            name: `Frame ${String(indexInRole('frame', id) ?? i + 1)}`,
            description: c?.description ?? 'Support frame.',
            quality: { base: inferred, span: inferred, height: inferred },
          },
        ),
      );
    });
  }

  // pipe runs and earthing up the shaft surface
  for (const [kind, role, dflt] of [
    ['pipeRun', 'pipe', 270],
    ['earthing', 'earthing', 45],
  ] as const) {
    const { c, n } = want(kind, role);
    const azs = bearings(c, n, dflt);
    const ids = ctx.ids(
      role,
      azs.map((az) => ({ azimuthDeg: az })),
    );
    azs.forEach((az, i) => {
      const id = ids[i] ?? `${role}-${String(i + 1)}`;
      const name = `${kind === 'pipeRun' ? 'Pipe' : 'Earthing'} ${String(indexInRole(role, id) ?? i + 1)}`;
      if (kind === 'pipeRun') {
        const d = ctx.value(id, 'diameter', ai(c, ctx.len(c, 'diameter'), 0.2));
        const topRatio = num(c, 'topRatio');
        const yTop =
          b[1] + (topRatio !== undefined && topRatio > 0 && topRatio <= 1 ? topRatio : 0.9) * H;
        out.push(
          make(
            ctx,
            'pipeRun',
            id,
            { path: downTheShaft(az, 0.5 + d.v / 2, yTop, 3).reverse(), diameter: d.v },
            {
              category: 'Lines',
              name,
              description: c?.description ?? 'Pipe run up the shaft.',
              parent: shaftId,
              quality: { path: inferred, diameter: d.q },
            },
          ),
        );
      } else {
        out.push(
          make(
            ctx,
            'earthing',
            id,
            { path: downTheShaft(az, 0.05, top - 0.3, 1.5), diameter: 0.03 },
            {
              category: 'Earthing',
              name,
              description: c?.description ?? 'Down conductor from the crown to the ground.',
              parent: shaftId,
              quality: { path: inferred, diameter: inferred },
            },
          ),
        );
      }
    });
  }

  // louvres low on the shaft, cabinets at the foot on the duct side
  {
    const { c, n } = want('louvre', 'louvre');
    const azs = bearings(c, n, 180);
    const ids = ctx.ids(
      'louvre',
      azs.map((az) => ({ azimuthDeg: az })),
    );
    azs.forEach((az, i) => {
      const id = ids[i] ?? `louvre-${String(i + 1)}`;
      const y = b[1] + clamp(0.03 * H, 1.5, 5);
      out.push(
        make(
          ctx,
          'louvre',
          id,
          {
            centre: toward(b, az, rAt(y) + 0.02, y),
            normal: dirOf(az),
            size: [1.2, 0.9],
            blades: 6,
          },
          {
            category: 'Openings',
            name: `Louvre ${String(indexInRole('louvre', id) ?? i + 1)}`,
            description: c?.description ?? 'Louvred vent in the shaft wall.',
            parent: shaftId,
            quality: { centre: inferred, normal: inferred, size: inferred, blades: inferred },
          },
        ),
      );
    });
  }
  {
    const { c, n } = want('cabinet', 'cabinet');
    const start = ductAz[0] ?? num(c, 'azimuthDeg') ?? 90;
    const azs = evenFrom(start + 25, n);
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
          { base: toward(b, az, rAt(b[1]) + 3, b[1]), size: [1.2, 2, 0.8], yawDeg: -az },
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

export const chimney: FamilyAssembler = (ctx) => build(ctx, false);
/** The shaft alone (the `generic` family). */
export const genericShaft: FamilyAssembler = (ctx) => build(ctx, true);
