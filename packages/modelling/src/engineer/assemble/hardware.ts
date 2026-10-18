import type { Assembly, ComponentObservation, ParamQuality, Vec3 } from '@aio/schema';
import { add, sub, scale, len } from '../geom';
import { facing } from '../builders/telecom';
import type { FamilyCtx } from './assemble';
import { make } from './shared';

const inferred: ParamQuality = { basis: 'inferred' };
/** Appearance inference from broad neutral shaft bands; never a surveyed paint specification. */
export function lightNeutralShaft(ctx: FamilyCtx): boolean {
  const lo = ctx.base[1] + ctx.height * 0.2,
    hi = ctx.base[1] + ctx.height * 0.7;
  let covered = 0,
    bright = 0,
    neutral = 0;
  for (const b of ctx.input.evidence?.colours ?? []) {
    const h = Math.max(0, Math.min(hi, b.y1) - Math.max(lo, b.y0));
    covered += h;
    bright += (h * (b.rgb[0] + b.rgb[1] + b.rgb[2])) / 3;
    neutral += h * (Math.max(...b.rgb) - Math.min(...b.rgb));
  }
  return covered > ctx.height * 0.3 && bright / covered > 135 && neutral / covered < 24;
}
/** Interpolate a measured pipe's lean; never change its measured centreline. */
export function pointAt(o: ComponentObservation, y: number): Vec3 {
  for (let i = 1; i < (o.path?.length ?? 0); i++) {
    const a = o.path?.[i - 1],
      b = o.path?.[i];
    if (
      !a ||
      !b ||
      y < Math.min(a[1], b[1]) ||
      y > Math.max(a[1], b[1]) ||
      Math.abs(b[1] - a[1]) < 1e-8
    )
      continue;
    return add(a, scale(sub(b, a), (y - a[1]) / (b[1] - a[1])));
  }
  return [o.centre[0], y, o.centre[2]];
}

/** Measured attachment endpoints, inferred construction. Every removable run retains an ID. */
export function equipmentHardware(ctx: FamilyCtx, records: ComponentObservation[]): Assembly[] {
  const result: Assembly[] = [];
  for (const o of records) {
    const first = o.path?.[0],
      last = o.path?.at(-1);
    if (
      o.kind === 'fence' &&
      o.path &&
      o.path.length >= 4 &&
      first &&
      last &&
      len(sub(first, last)) < 1e-6
    ) {
      const outline = o.path.slice(0, -1).map((p) => [p[0], p[2]] as [number, number]);
      const slab = make(
        ctx,
        'deck',
        `${o.id}-surface`,
        { y: ctx.base[1] + 0.025, outline, thickness: 0.025, openings: [] },
        {
          parent: o.id,
          name: 'Compound surface',
          category: 'Compound',
          description:
            'Inferred thin surface within the measured enclosure. This does not represent a surveyed foundation or buried structure.',
          quality: { y: inferred, outline: o.quality.centre, thickness: inferred },
        },
      );
      slab.sources = o.sources;
      result.push(slab);
    }
    if (o.kind === 'cabinet') {
      const top = o.centre[1] - o.size[1] / 2,
        gap = top - ctx.base[1];
      if (gap < 0.02 || gap > 0.3) continue;
      const { front, right } = facing(o.azimuthDeg);
      const outline = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([x = 0, z = 0]) => {
        const p = add(
          o.centre,
          add(scale(right, x * (o.size[0] / 2 + 0.06)), scale(front, z * (o.size[2] / 2 + 0.06))),
        );
        return [p[0], p[2]] as [number, number];
      });
      const pad = make(
        ctx,
        'deck',
        `${o.id}-pad`,
        { y: top, outline, thickness: gap, openings: [] },
        {
          parent: o.id,
          name: `${o.name ?? o.id} pad`,
          category: 'Compound',
          description:
            'Inferred exposed pad under the measured cabinet footprint; construction and thickness require review.',
          quality: { y: inferred, outline: inferred, thickness: inferred },
        },
      );
      pad.sources = o.sources;
      result.push(pad);
    }
    if (o.kind === 'climbing-steps' && o.path) {
      const steps = o.path;
      const side = facing(o.azimuthDeg).right;
      const stride = Math.max(4, Math.ceil((o.path.length - 1) / 63));
      const path = steps
        .filter((_, i) => i % stride === 0 || i === steps.length - 1)
        .map((p) => add(p, scale(side, 0.035)));
      const wire = make(
        ctx,
        'pipeRun',
        `${o.id}-safety-line`,
        { path, diameter: 0.006, bendRadius: 0 },
        {
          parent: o.id,
          name: 'Climbing safety line',
          category: 'Access',
          description:
            'Inferred safety line following the measured climbing route. Anchors and wire construction require review.',
          quality: { path: inferred, diameter: inferred, bendRadius: inferred },
        },
      );
      wire.material = 'steel-galv';
      wire.sources = o.sources;
      result.push(wire);
    }
  }
  const decks = records
    .filter((o) => o.kind === 'platform')
    .sort((a, b) => a.centre[1] - b.centre[1]);
  for (const o of records.filter((o) => o.kind === 'panel' || o.kind === 'rru')) {
    const pipe = records.find((p) => p.id === o.parent && p.kind === 'mounting-pipe');
    if (!pipe) continue;
    const { front, up, right } = facing(o.azimuthDeg, o.tiltDeg);
    const back = sub(o.centre, scale(front, o.size[2] / 2));
    const attachmentQuality = {
      ...inferred,
      note: 'Clamp attachment positions are inferred from device and pipe geometry; not directly observed.',
    };
    for (const [i, dy] of [-0.32 * o.size[1], 0.32 * o.size[1]].entries()) {
      const anchor = add(back, scale(up, dy)),
        centre = pointAt(pipe, anchor[1]);
      if (Math.hypot(anchor[0] - centre[0], anchor[2] - centre[2]) < 0.02) continue;
      const a = make(
        ctx,
        'antennaMount',
        `${o.id}-bracket-${i + 1}`,
        {
          kind: 'clamp',
          centre,
          anchor,
          pipeDiameter: pipe.size[0],
          azimuthDeg: o.azimuthDeg,
          tiltDeg: o.tiltDeg,
          size: [
            Math.min(0.18, o.size[0] * 0.65),
            Math.min(0.14, o.size[1] * 0.2),
            len(sub(anchor, centre)),
          ],
        },
        {
          parent: o.id,
          name: `${o.name ?? o.id} clamp ${i + 1}`,
          category: 'Mounts',
          description:
            'Inferred plates, paired support arms and U-bolts between measured pipe and tilted device back. Hardware dimensions require review.',
          quality: {
            centre: attachmentQuality,
            anchor: attachmentQuality,
            size: inferred,
            kind: inferred,
            pipeDiameter: pipe.quality.width,
            tiltDeg: o.quality.tiltDeg,
          },
        },
      );
      a.sources = o.sources;
      result.push(a);
    }
    const count = o.kind === 'panel' ? 4 : 2;
    const foot = sub(back, scale(up, o.size[1] / 2));
    const deck = decks.filter((d) => d.centre[1] < foot[1] + 0.1).at(-1);
    for (let k = 0; k < count; k++) {
      const offset = (k - (count - 1) / 2) * 0.024;
      const start = add(foot, scale(right, offset));
      const behind = scale(front, -(pipe.size[0] / 2 + 0.035));
      const terminal = add(add(pointAt(pipe, foot[1] + 0.12), behind), scale(right, offset));
      const path: Vec3[] = Array.from({ length: 17 }, (_, j) => {
        const t = j / 16;
        const p = add(start, scale(sub(terminal, start), t));
        return add(p, [0, -(0.25 + 0.012 * k) * Math.sin(Math.PI * t), 0]);
      });
      if (deck && terminal[1] - deck.centre[1] > 0.25) {
        const at = add(
          add(pointAt(pipe, deck.centre[1] + 0.09 + k * 0.014), behind),
          scale(right, offset),
        );
        // Offset the vertical service route behind the pipe surface.
        for (let j = 1; j <= 4; j++) path.push(add(terminal, scale(sub(at, terminal), j / 4)));
      }
      const id = k === 0 ? `${o.id}-service-loop` : `${o.id}-feeder-${k + 1}`;
      const cable = make(
        ctx,
        'pipeRun',
        id,
        { path, diameter: 0.014, bendRadius: 0 },
        {
          parent: o.id,
          name: `${o.name ?? o.id} cable ${k + 1}`,
          category: 'Cabling',
          description:
            'Inferred service cable and drip loop between measured device, pipe and platform. Cable count, ports and electrical connectivity are not measured.',
          quality: { path: inferred, diameter: inferred, bendRadius: inferred },
        },
      );
      cable.material = 'cable';
      cable.sources = o.sources;
      result.push(cable);
    }
  }
  // Cable looms around the measured platform perimeter; separate from its steel grating.
  for (const deck of decks) {
    if (!deck.path || deck.path.length < 3) continue;
    const cx = deck.centre[0],
      cz = deck.centre[2];
    let inside = false;
    let outer = Infinity;
    for (let i = 0; i < deck.path.length; i++) {
      const a = deck.path[i],
        b = deck.path[(i + 1) % deck.path.length];
      if (!a || !b) continue;
      if (a[2] > cz !== b[2] > cz && cx < ((b[0] - a[0]) * (cz - a[2])) / (b[2] - a[2]) + a[0])
        inside = !inside;
      const dx = b[0] - a[0],
        dz = b[2] - a[2],
        d2 = dx * dx + dz * dz;
      if (d2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cz - a[2]) * dz) / d2));
      outer = Math.min(outer, Math.hypot(cx - a[0] - t * dx, cz - a[2] - t * dz));
    }
    if (!inside || !Number.isFinite(outer)) continue;
    const inner = ctx.radiusAt(deck.centre[1]);
    if (outer < inner + 0.15) continue;
    for (let k = 0; k < 4; k++) {
      const radius = outer - 0.08 - 0.025 * k;
      if (radius < inner + 0.04) continue;
      const path: Vec3[] = Array.from({ length: 49 }, (_, i) => {
        const t = (i / 48) * Math.PI * 2;
        return [
          cx + radius * Math.cos(t),
          deck.centre[1] + 0.04 + 0.008 * k,
          cz + radius * Math.sin(t),
        ];
      });
      const a = make(
        ctx,
        'pipeRun',
        `${deck.id}-loom-${k + 1}`,
        { path, diameter: 0.018, bendRadius: 0 },
        {
          parent: deck.id,
          name: `${deck.name ?? deck.id} cable loom ${k + 1}`,
          category: 'Cabling',
          description:
            'Inferred cable loom supported by the measured platform. Exact routing and connectivity require review.',
          quality: { path: inferred, diameter: inferred, bendRadius: inferred },
        },
      );
      a.material = 'cable';
      a.sources = deck.sources;
      result.push(a);
    }
  }
  return result;
}
