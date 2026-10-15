/**
 * The flare stack family template (spec section 5.3): a riser (`shaft`, from the measured slices,
 * usually cylindrical), its support, a `flareTip` on top, ring platforms, ladders, service lines
 * and warning lights. Never flues, decks or paint bands: those are chimney parts.
 *
 * Support: `self` (the riser stands alone, the default), or `derrick` / `guyed`, a lattice round
 * the riser, when the proposal's shaft says so (`support`) or the evidence shows `leg` members.
 * With a lattice the slices measure the lattice, so the riser takes the AI's radii (or a default)
 * instead. Guy wires are no component kind, so a guyed support notes them as unresolved.
 *
 * Platforms come from the `platform` members (rings at measured heights, outer radius half the
 * member size) or the proposal's levels; ladders, service lines (`pipeRun`, up the riser from the
 * ground to the tip, `riser radius + 0.4 m` off its axis) only when proposed or set by the person.
 * The tip is the one part the template always makes: when nothing shows it, it is inferred and
 * noted. Compass azimuths: 0 north (-z), 90 east (+x).
 */
import type { Assembly, ParamQuality, ValueBasis, Vec3 } from '@aio/schema';
import type { FamilyAssembler, FamilyCtx } from './assemble';
import { indexInRole } from './ids';
import {
  ai,
  bool,
  chooseCount,
  clamp,
  evenFrom,
  group,
  lights,
  make,
  measuredBy,
  noteUnplaced,
  num,
  profileOf,
  sliceCoverage,
  str,
  toward,
} from './shared';
import { latticeOf } from './telecom';

/** A service line's axis stands this far outside the riser surface. */
export const SERVICE_LINE_OFFSET = 0.4;

const SUPPORTS = ['self', 'derrick', 'guyed'] as const;
type Support = (typeof SUPPORTS)[number];
const isSupport = (s: string | undefined): s is Support => SUPPORTS.some((k) => k === s);

const PLACED = new Set<string>([
  'shaft',
  'flareTip',
  'lattice',
  'ringPlatform',
  'guardrail',
  'ladder',
  'pipeRun',
  'warningLight',
]);

function platforms(ctx: FamilyCtx, shaftId: string): Assembly[] {
  const H = ctx.height;
  const b = ctx.base;
  const rAt = (y: number) => ctx.radiusAt(y);
  const inferred: ParamQuality = { basis: 'inferred' };
  const props = ctx.proposals('ringPlatform');
  const c = props[0];
  const pg = group(ctx, 'platform');
  const seen = [...(pg?.items ?? [])]
    .filter((it) => it.centre[1] - b[1] > 0.5 && it.centre[1] - b[1] < H)
    .sort((p, q) => p.centre[1] - q.centre[1]);
  const { n } = chooseCount(ctx, {
    what: 'platforms',
    user: ctx.userCount('platform'),
    proposed: props,
    evidence: pg ? seen.length : undefined,
  });
  const user = ctx.userLevels('platform');
  const aiBasis: ValueBasis = c?.observed ? 'observed' : 'inferred';
  interface Found {
    h: number;
    basis: ValueBasis;
    size?: number;
    support?: number;
  }
  const found: Found[] = seen.map((it): Found => ({
    h: it.centre[1] - b[1],
    basis: 'measured',
    size: it.size,
    support: it.support,
  }));
  for (const r of props.flatMap((p) => p.levels ?? []))
    if (!found.some((l) => Math.abs(l.h - r * H) <= 0.04 * H))
      found.push({ h: r * H, basis: aiBasis });
  found.sort((p, q) => p.h - q.h);
  for (let k = found.length; k < n; k++)
    found.push({ h: ((k + 1) * H) / (n + 1), basis: 'inferred' });
  const levels = (user ? user.map((h): Found => ({ h, basis: 'user' })) : found.slice(0, n)).filter(
    (l) => l.h > 0.5 && l.h < H,
  );
  const ids = ctx.ids(
    'platform',
    levels.map((l) => ({ y: b[1] + l.h })),
  );
  const railIds = ctx.ids(
    'platform-rail',
    levels.map((l) => ({ y: b[1] + l.h })),
  );
  const railed = bool(c, 'guardrail') === true;
  const residualM = pg?.metrics.residualM;
  const aiWidth = ctx.len(c, 'width');
  const out: Assembly[] = [];
  levels.forEach((l, i) => {
    const id = ids[i] ?? `platform-${String(i + 1)}`;
    const y = b[1] + l.h;
    const thickness = 0.1;
    const rIn = Math.max(rAt(y), rAt(y - thickness)) + 0.05;
    const m = found.find((f) => f.basis === 'measured' && Math.abs(f.h - l.h) < 1e-9);
    const seenR = m?.size !== undefined ? m.size / 2 : undefined;
    const rOuter = ctx.value(id, 'rOuter', {
      ...(seenR !== undefined && seenR > rIn + 0.2
        ? { measured: { v: seenR, q: measuredBy(m?.support ?? 0, residualM) } }
        : {}),
      ...ai(c, aiWidth === undefined ? undefined : rIn + aiWidth, rIn + clamp(0.02 * H, 0.8, 1.5)),
    });
    const rOut = Math.max(rOuter.v, rIn + 0.2);
    const yQ: ParamQuality =
      l.basis === 'measured' && m
        ? { basis: 'measured', ...measuredBy(m.support ?? 0, residualM) }
        : { basis: l.basis };
    out.push(
      make(
        ctx,
        'ringPlatform',
        id,
        { y, rInner: rIn, rOuter: rOut, thickness, shaft: shaftId },
        {
          category: 'Access',
          name: `Platform ${String(indexInRole('platform', id) ?? i + 1)}`,
          description: c?.description ?? 'Ring platform round the riser.',
          parent: shaftId,
          quality: { y: yQ, rInner: inferred, rOuter: rOuter.q, thickness: inferred },
          measured: l.basis === 'measured',
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
            quality: { path: inferred, height: inferred, posts: inferred, rails: inferred },
          },
        ),
      );
    }
  });
  return out;
}

export const assembleFlare: FamilyAssembler = (ctx) => {
  const H = ctx.height;
  const b = ctx.base;
  const top = b[1] + H;
  const out: Assembly[] = [];
  const inferred: ParamQuality = { basis: 'inferred' };
  const shaftC = ctx.proposals('shaft')[0];
  const [shaftId = 'shaft-1'] = ctx.ids('shaft', [{ y: b[1] }]);

  // ---- support: self-supported unless the proposal or the evidence shows a lattice
  const legs = group(ctx, 'leg')?.items.length ?? 0;
  const latticeC = ctx.proposals('lattice')[0];
  const userSupport = ctx.userParam(shaftId, 'support');
  const aiSupport = str(shaftC, 'support');
  const support: Support =
    typeof userSupport === 'string' && isSupport(userSupport)
      ? userSupport
      : isSupport(aiSupport)
        ? aiSupport
        : legs >= 3 || (latticeC && latticeC.count > 0)
          ? 'derrick'
          : 'self';
  const lattice = support !== 'self';

  // ---- riser
  const riserR = clamp(0.012 * H, 0.3, 1);
  const profile = profileOf(
    ctx,
    shaftId,
    shaftC,
    [
      { y: 0, r: riserR },
      { y: H, r: riserR },
    ],
    { measured: !lattice },
  );
  ctx.setHost({ base: b, profile: profile.v });
  const rAt = (y: number) => ctx.radiusAt(y);
  const coverage = sliceCoverage(ctx);
  out.push(
    make(
      ctx,
      'shaft',
      shaftId,
      { base: b, profile: profile.v, openTop: false },
      {
        category: 'Riser',
        name: 'Riser',
        description: shaftC?.description ?? 'Flare riser carrying the gas up to the tip.',
        quality: { base: ctx.baseQuality, profile: profile.q, openTop: inferred },
        unobserved: !lattice && coverage !== undefined && coverage < 0.5 ? ['back'] : undefined,
        measured: profile.q.basis === 'measured',
      },
    ),
  );
  if (lattice) {
    const [supportId = 'support-1'] = ctx.ids('support', [{ y: b[1] }]);
    out.push(
      latticeOf(ctx, supportId, latticeC, {
        name: support === 'guyed' ? 'Guyed mast' : 'Derrick',
        category: 'Structure',
        description:
          support === 'guyed'
            ? 'Guyed lattice mast carrying the riser.'
            : 'Derrick: a lattice structure round the riser.',
        parent: shaftId,
      }),
    );
    if (support === 'guyed')
      ctx.note('The guy wires of the guyed mast are not modelled: there is no component for them.');
  }

  // ---- tip (the template needs one: inferred and noted when nothing shows it)
  const tipC = ctx.proposals('flareTip')[0];
  const [tipId = 'tip-1'] = ctx.ids('tip', [{ y: top }]);
  if (!tipC || tipC.count === 0)
    ctx.note('No flare tip was seen: one is drawn on top of the riser as a guess.');
  const crownR = profile.v.at(-1)?.r ?? riserR;
  const tr = ctx.value(tipId, 'r', ai(tipC, ctx.len(tipC, 'r'), 0.75 * crownR));
  const th = ctx.value(tipId, 'height', ai(tipC, ctx.len(tipC, 'height'), clamp(0.05 * H, 1, 6)));
  const windshield = ctx.value(tipId, 'windshield', ai(tipC, bool(tipC, 'windshield'), false));
  const aiPilots = num(tipC, 'pilots');
  const pilots = ctx.value(
    tipId,
    'pilots',
    ai(tipC, aiPilots !== undefined ? clamp(Math.round(aiPilots), 0, 8) : undefined, 0),
  );
  out.push(
    make(
      ctx,
      'flareTip',
      tipId,
      {
        base: [b[0], top, b[2]] as Vec3,
        r: tr.v,
        height: th.v,
        windshield: windshield.v,
        pilots: pilots.v,
      },
      {
        category: 'Flare tip',
        name: 'Flare tip',
        description: tipC?.description ?? 'Flare tip with its lining on top of the riser.',
        parent: shaftId,
        quality: {
          base: inferred,
          r: tr.q,
          height: th.q,
          windshield: windshield.q,
          pilots: pilots.q,
        },
      },
    ),
  );

  // ---- platforms, ladders, service lines, lights
  out.push(...platforms(ctx, shaftId));
  {
    const cs = ctx.proposals('ladder');
    const c = cs[0];
    const n = Math.max(0, ctx.userCount('ladder') ?? cs.reduce((s, x) => s + x.count, 0));
    const first = num(c, 'azimuthDeg');
    const azs = evenFrom(first !== undefined ? ((first % 360) + 360) % 360 : 0, n);
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
            bottom: toward(b, az, rAt(b[1]) + 0.3, b[1]),
            top: toward(b, az, rAt(top) + 0.3, top),
            width: width.v,
            rungSpacing: 0.3,
            cage: cage.v,
          },
          {
            category: 'Access',
            name: `Ladder ${String(indexInRole('ladder', id) ?? i + 1)}`,
            description: c?.description ?? 'Access ladder up the riser.',
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
  {
    const cs = ctx.proposals('pipeRun');
    const c = cs[0];
    const n = Math.max(0, ctx.userCount('pipe') ?? cs.reduce((s, x) => s + x.count, 0));
    const first = num(c, 'azimuthDeg');
    const azs = evenFrom(first !== undefined ? ((first % 360) + 360) % 360 : 270, n);
    const ids = ctx.ids(
      'pipe',
      azs.map((az) => ({ azimuthDeg: az })),
    );
    const inner = profile.v.map((q) => b[1] + q.y).filter((y) => y > b[1] + 1 && y < top - 0.5);
    azs.forEach((az, i) => {
      const id = ids[i] ?? `pipe-${String(i + 1)}`;
      const d = ctx.value(id, 'diameter', ai(c, ctx.len(c, 'diameter'), 0.15));
      const foot = b[1] + 0.5;
      const off = (y: number) => rAt(y) + SERVICE_LINE_OFFSET;
      out.push(
        make(
          ctx,
          'pipeRun',
          id,
          {
            path: [
              toward(b, az, off(foot) + 3, foot),
              toward(b, az, off(foot), foot),
              ...inner.map((y) => toward(b, az, off(y), y)),
              toward(b, az, off(top), top),
            ],
            diameter: d.v,
          },
          {
            category: 'Lines',
            name: `Service line ${String(indexInRole('pipe', id) ?? i + 1)}`,
            description: c?.description ?? 'Service line up the riser to the tip.',
            parent: shaftId,
            quality: { path: inferred, diameter: d.q },
          },
        ),
      );
    });
  }
  out.push(...lights(ctx, shaftId, { description: 'Aviation warning light on the flare.' }));
  noteUnplaced(ctx, PLACED, 'flare');
  return out;
};
