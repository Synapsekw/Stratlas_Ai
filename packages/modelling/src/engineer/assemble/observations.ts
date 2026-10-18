/** Assemble complete per-object measurements without averaging a sector or inventing missing copies. */
import type { Assembly, ComponentObservation, ParamQuality, Vec3 } from '@aio/schema';
import type { FamilyCtx } from './assemble';
import { make, weakest } from './shared';
import { equipmentHardware, pointAt, lightNeutralShaft } from './hardware';
import { facing } from '../builders/telecom';

const inferred: ParamQuality = { basis: 'inferred' };
export function measuredEquipment(ctx: FamilyCtx, host: string): Assembly[] | undefined {
  const records = ctx.metric
    ? ctx.input.evidence?.observations?.filter(
        (o) =>
          ctx.input.scope === 'asset-and-surroundings' ||
          !['canopy', 'fence', 'cabinet', 'slab'].includes(o.kind),
      )
    : undefined;
  if (!records?.length) return undefined;
  const supported = new Set([
    'panel',
    'rru',
    'equipment-box',
    'mounting-pipe',
    'platform',
    'cabinet',
    'cable',
    'slab',
    'canopy',
    'fence',
    'climbing-steps',
    'light',
  ]);
  const ids = new Set(records.filter((o) => supported.has(o.kind)).map((o) => o.id));
  const result: Assembly[] = [];
  const associations = new Map<
    string,
    NonNullable<typeof ctx.input.proposal>['components'][number]
  >();
  for (const c of ctx.input.proposal?.components ?? []) {
    const id = c.params.observationId;
    if (typeof id !== 'string') continue;
    if (!ids.has(id) || c.count !== 1 || associations.has(id)) {
      ctx.note(`AI component association ${id} could not be applied; review the inventory.`);
      continue;
    }
    associations.set(id, c);
  }
  const photoIds = new Set(
    // Pipeline crop views are generated from the cloud; crops of original photos remain 'photo'.
    ctx.input.evidence?.images.filter((i) => i.kind === 'photo').map((i) => i.id),
  );
  const classifiedKind = (o: ComponentObservation) => {
    const c = associations.get(o.id);
    return o.kind === 'equipment-box' &&
      c?.kind === 'antenna' &&
      c.observed &&
      (c.params.kind === 'panel' || c.params.kind === 'rru') &&
      c.imageIds.some((id) => photoIds.has(id))
      ? c.params.kind
      : o.kind;
  };
  const emit = (o: ComponentObservation, a: Assembly) => {
    a.sources = o.sources;
    // Retain the detector's class; antenna params.kind/quality.kind record any photo refinement.
    if (o.kind === 'equipment-box') a.type = 'equipment-box';
    if (o.kind === 'mounting-pipe' && lightNeutralShaft(ctx)) {
      a.material = 'mast-painted';
      a.description += ' Light coating inferred from source appearance; finish requires review.';
    }
    a.tag = o.name ?? o.id;
    if (o.kind === 'fence') a.material = 'paint-black';
    if (o.notes?.length) a.description = [a.description, ...o.notes].join(' ').slice(0, 300);
    const associated = associations.get(o.id);
    if (associated) {
      if (associated.description)
        a.description = `${a.description} AI review: ${associated.description}`.slice(0, 300);
      if (
        (associated.kind !== a.kind &&
          !(o.kind === 'mounting-pipe' && associated.kind === 'antennaMount')) ||
        (associated.params.kind !== undefined && associated.params.kind !== classifiedKind(o))
      )
        ctx.note(
          `${o.id}: AI classification differs from the source record; measured geometry was retained.`,
        );
      a.sources = [
        ...a.sources,
        ...associated.imageIds
          .filter((id) => photoIds.has(id))
          .map((ref) => ({ kind: 'photo' as const, ref })),
      ].slice(0, 64);
    }
    result.push(a);
  };
  for (const o of records) {
    const [w, h, d] = o.size;
    const sizeQuality: ParamQuality = {
      basis: weakest(o.quality.width.basis, o.quality.height.basis, o.quality.depth.basis),
      note: `Width ${o.quality.width.basis}; height ${o.quality.height.basis}; depth ${o.quality.depth.basis}. ${o.quality.depth.note ?? ''}`
        .trim()
        .slice(0, 200),
    };
    const kind = classifiedKind(o);
    if (
      kind === 'equipment-box' &&
      records.some((p) => p.id === o.parent && p.kind === 'mounting-pipe')
    )
      ctx.note(`${o.id}: equipment type unresolved; brackets and cable routes were not inferred.`);
    const meta = {
      name: o.name ?? o.kind,
      category: 'Equipment',
      description: `Source-associated ${o.kind}; dimensions and pose retained individually.`,
      parent: o.parent && ids.has(o.parent) ? o.parent : host,
      unobserved:
        ['panel', 'rru', 'equipment-box'].includes(o.kind) && o.quality.depth.basis === 'inferred'
          ? ['back' as const]
          : undefined,
      quality: {
        centre: o.quality.centre,
        size: sizeQuality,
        azimuthDeg: o.quality.azimuthDeg,
        tiltDeg: o.quality.tiltDeg,
      },
    };
    switch (kind) {
      case 'light':
        emit(
          o,
          make(
            ctx,
            'warningLight',
            o.id,
            { fixture: 'canister', centre: o.centre, outward: [0, 1, 0], size: Math.max(w, h, d) },
            {
              ...meta,
              category: 'Lights',
              description: 'Source-positioned red cap fixture with inferred beacon housing.',
              quality: {
                centre: o.quality.centre,
                size: inferred,
                outward: inferred,
                fixture: inferred,
              },
            },
          ),
        );
        break;
      case 'climbing-steps': {
        const bottom = o.path?.[0],
          top = o.path?.at(-1);
        if (!bottom || !top) break;
        const az = (o.azimuthDeg * Math.PI) / 180;
        emit(
          o,
          make(
            ctx,
            'ladder',
            o.id,
            {
              bottom,
              top,
              width: w,
              rungSpacing: 0.3,
              style: 'step-bolts',
              steps: o.path,
              outward: [Math.sin(az), 0, -Math.cos(az)],
            },
            {
              ...meta,
              category: 'Access',
              quality: {
                steps: o.quality.centre,
                width: o.quality.width,
                outward: o.quality.azimuthDeg,
                style: inferred,
                rungSpacing: inferred,
              },
            },
          ),
        );
        break;
      }
      case 'fence':
        if (o.path)
          emit(
            o,
            make(
              ctx,
              'guardrail',
              o.id,
              {
                path: o.path,
                height: h,
                posts: 1.6,
                rails: 2,
                pickets: { spacing: 0.14, diameter: 0.018 },
              },
              {
                ...meta,
                category: 'Compound',
                quality: {
                  path: o.quality.centre,
                  height: o.quality.height,
                  posts: inferred,
                  rails: inferred,
                  pickets: inferred,
                },
              },
            ),
          );
        break;
      case 'canopy': {
        if (!o.path || o.path.length < 3) break;
        emit(
          o,
          make(
            ctx,
            'deck',
            o.id,
            {
              y: o.centre[1],
              outline: o.path.map((p) => [p[0], p[2]]),
              elevations: o.path.map((p) => p[1]),
              thickness: o.surfaces ? 0.012 : h,
              ...(o.surfaces
                ? { roofPanels: o.surfaces, corrugation: { pitch: 0.16, depth: 0.016 } }
                : {}),
              openings: [],
            },
            {
              ...meta,
              category: 'Compound',
              quality: {
                outline: o.quality.centre,
                elevations: o.quality.centre,
                y: o.quality.centre,
                thickness: inferred,
                ...(o.surfaces ? { roofPanels: o.quality.centre, corrugation: inferred } : {}),
              },
            },
          ),
        );
        for (const [i, p] of o.path.entries()) {
          if (p[1] <= ctx.base[1]) continue;
          const post = make(
            ctx,
            'pipeRun',
            `${o.id}-support-${i + 1}`,
            { path: [[p[0], ctx.base[1], p[2]], p], diameter: 0.06 },
            {
              ...meta,
              parent: o.id,
              name: `${o.name ?? o.id} support ${i + 1}`,
              category: 'Compound',
              description:
                'Inferred roof support; corner endpoints follow the observed roof. Confirm against photographs.',
              quality: { path: inferred, diameter: inferred },
            },
          );
          post.sources = o.sources;
          post.material = 'paint-white';
          result.push(post);
        }
        break;
      }
      case 'panel':
      case 'rru':
        emit(
          o,
          make(
            ctx,
            'antenna',
            o.id,
            {
              kind,
              centre: o.centre,
              size: o.size,
              azimuthDeg: o.azimuthDeg,
              tiltDeg: o.tiltDeg,
            },
            {
              ...meta,
              quality: {
                ...meta.quality,
                ...(kind !== o.kind ? { kind: { basis: 'observed' as const } } : {}),
              },
            },
          ),
        );
        break;
      case 'mounting-pipe':
      case 'cable': {
        const path: Vec3[] = o.path ?? [
          [o.centre[0], o.centre[1] - h / 2, o.centre[2]],
          [o.centre[0], o.centre[1] + h / 2, o.centre[2]],
        ];
        emit(
          o,
          make(
            ctx,
            'pipeRun',
            o.id,
            { path, diameter: w },
            {
              ...meta,
              category: o.kind === 'cable' ? 'Cabling' : 'Mounts',
              quality: { path: o.quality.centre, diameter: o.quality.width },
            },
          ),
        );
        break;
      }
      case 'equipment-box':
      case 'cabinet': {
        const unknown = o.kind === 'equipment-box';
        const up = facing(o.azimuthDeg, o.tiltDeg).up;
        const boxBase: Vec3 = unknown
          ? [
              o.centre[0] - (up[0] * h) / 2,
              o.centre[1] - (up[1] * h) / 2,
              o.centre[2] - (up[2] * h) / 2,
            ]
          : [o.centre[0], o.centre[1] - h / 2, o.centre[2]];
        emit(
          o,
          make(
            ctx,
            'cabinet',
            o.id,
            {
              base: boxBase,
              size: [w, h, d],
              yawDeg: unknown ? 180 - o.azimuthDeg : -o.azimuthDeg,
              ...(unknown ? { tiltDeg: o.tiltDeg } : {}),
            },
            {
              ...meta,
              quality: {
                size: sizeQuality,
                base: unknown
                  ? {
                      basis: weakest(
                        o.quality.centre.basis,
                        o.quality.height.basis,
                        o.quality.azimuthDeg.basis,
                        o.quality.tiltDeg.basis,
                      ),
                      note: 'Bottom centre derived from the individual centre, height, bearing and tilt.',
                    }
                  : o.quality.centre,
                yawDeg: o.quality.azimuthDeg,
                ...(unknown ? { tiltDeg: o.quality.tiltDeg } : {}),
              },
            },
          ),
        );
        break;
      }
      case 'platform':
      case 'slab': {
        if (!o.path || o.path.length < 3) {
          ctx.note(`${o.name ?? o.id}: no supported platform outline.`);
          break;
        }
        const platform = o.kind === 'platform';
        emit(
          o,
          make(
            ctx,
            'deck',
            o.id,
            {
              y: o.centre[1],
              outline: o.path.map((p) => [p[0], p[2]]),
              thickness: platform ? 0.04 : h,
              openings: platform
                ? [{ centre: [ctx.base[0], ctx.base[2]], r: ctx.radiusAt(o.centre[1]) + 0.04 }]
                : [],
              grating: platform,
            },
            {
              ...meta,
              category: 'Platforms',
              quality: {
                y: o.quality.centre,
                outline: o.quality.width,
                thickness: platform ? inferred : o.quality.height,
                grating: inferred,
              },
            },
          ),
        );
        break;
      }
      default:
        ctx.note(`${o.name ?? o.id}: ${o.kind} is measured but has no automatic builder yet.`);
    }
  }
  // Photo refinement can select the existing inferred hardware rules, but those rules still
  // require an explicit measured parent pipe. Unknown enclosures keep their source parent only.
  result.push(
    ...equipmentHardware(
      ctx,
      records.map((o) => ({ ...o, kind: classifiedKind(o) })),
    ),
  );
  const decks = records
    .filter((o) => o.kind === 'platform')
    .sort((a, b) => a.centre[1] - b.centre[1]);
  for (const pipe of records.filter((o) => o.kind === 'mounting-pipe')) {
    let index = 0;
    for (const deck of decks) {
      const y = deck.centre[1];
      if (Math.abs(y - pipe.centre[1]) > pipe.size[1] / 2 + 0.15) continue;
      index++;
      const mount = pointAt(pipe, y),
        axis = ctx.input.evidence?.axis?.dir ?? [0, 1, 0];
      const dy = y - ctx.base[1],
        cx = ctx.base[0] + (axis[0] * dy) / axis[1],
        cz = ctx.base[2] + (axis[2] * dy) / axis[1];
      const length = Math.hypot(mount[0] - cx, mount[2] - cz),
        r = ctx.radiusAt(y);
      if (length < r + 0.05) continue;
      const inner: Vec3 = [
        cx + ((mount[0] - cx) * r) / length,
        y,
        cz + ((mount[2] - cz) * r) / length,
      ];
      const support = make(
        ctx,
        'pipeRun',
        `${pipe.id}-support-${index}`,
        { path: [inner, mount], diameter: 0.065 },
        {
          parent: pipe.id,
          name: `${pipe.name ?? pipe.id} support ${index}`,
          category: 'Mounts',
          description:
            'Inferred radial support at the measured platform level, between the mast and observed pipe.',
          quality: { path: inferred, diameter: inferred },
        },
      );
      support.sources = [...pipe.sources, ...deck.sources].slice(0, 64);
      result.push(support);
      const path: Vec3[] = Array.from({ length: 17 }, (_, i) => {
        const a = 0.3 + ((2 * Math.PI - 0.6) * i) / 16;
        return [
          mount[0] + (pipe.size[0] / 2 + 0.012) * Math.cos(a),
          y,
          mount[2] + (pipe.size[0] / 2 + 0.012) * Math.sin(a),
        ];
      });
      const collar = make(
        ctx,
        'pipeRun',
        `${pipe.id}-collar-${index}`,
        { path, diameter: 0.028 },
        {
          parent: pipe.id,
          name: `${pipe.name ?? pipe.id} collar ${index}`,
          category: 'Mounts',
          description: 'Inferred mounting collar at a measured platform level.',
          quality: { path: inferred, diameter: inferred },
        },
      );
      collar.sources = pipe.sources;
      result.push(collar);
    }
  }
  return result;
}
