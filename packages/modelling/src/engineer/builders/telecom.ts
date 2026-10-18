/**
 * Builders of telecom equipment: monopoles, antennas and the mounts that carry them. Each antenna
 * and each mount is its own assembly, so every one is its own component (identifiable by its
 * assembly id) however many share a tower.
 *
 * Directions: `azimuthDeg` is a compass bearing (0 north = -Z, 90 east = +X); a positive
 * `tiltDeg` turns the antenna's face down (mechanical downtilt).
 *
 * Default materials (ids `DEFAULT_MATERIALS` carries): monopole and mounts `steel-galv`, panel,
 * dish and omni radomes `paint-white`, rru `cabinet-grey`. The assembly `material` overrides them.
 */
import { add, cross, dot, norm, scale, sub, type MeshSink, type V3 } from '../geom';
import { orientedBox } from './access';
import type { AssemblyOf, BuildCtx, BuilderTable } from './ctx';

/** Sine and cosine of `deg` degrees, exactly 0 at the quarter turns (no -0 or 6e-17 noise). */
function sinCos(deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  const snap = (x: number) => (Math.abs(x) < 1e-12 ? 0 : x);
  return [snap(Math.sin(t)), snap(Math.cos(t))];
}

/** Facing frame of an antenna: `front` out of its face, `up` along its height, `right` across. */
export function facing(azimuthDeg: number, tiltDeg = 0): { front: V3; up: V3; right: V3 } {
  const [sa, ca] = sinCos(azimuthDeg);
  const [st, ct] = sinCos(tiltDeg);
  const front: V3 = [sa * ct, -st, -ca * ct];
  const up: V3 = [sa * st, ct, -ca * st];
  return { front, up, right: norm(cross(front, up)) };
}

/**
 * A closed six-faced solid from a front and a back quad (each listed in the same order round
 * the face): flat faces with their own outward normals.
 */
function hexahedron(sink: MeshSink, m: string, front: V3[], back: V3[]): void {
  const p = sink.prim(m);
  const all = [...front, ...back];
  const c = scale(all.reduce(add, [0, 0, 0]), 1 / all.length);
  const faceOf = (pts: V3[]) => {
    const mid = scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
    let n = norm(cross(sub(at(pts, 1), at(pts, 0)), sub(at(pts, 2), at(pts, 0))));
    if (dot(n, sub(mid, c)) < 0) n = scale(n, -1);
    sink.fan(p, pts, n);
  };
  faceOf(front);
  faceOf(back);
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    faceOf([at(front, k), at(front, j), at(back, j), at(back, k)]);
  }
}

function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`geometry: index ${String(i)} is out of range`);
  return v;
}

/** Corners of a `w` x `h` rectangle round `c` in the plane of `right`, `up`. */
function rect(c: V3, right: V3, up: V3, w: number, h: number): V3[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([i = 0, j = 0]) => add(c, add(scale(right, (i * w) / 2), scale(up, (j * h) / 2))));
}

/** Monopole: a capped `frustumShell` along +Y from `base`; `sides` 0 is round. */
export function buildMonopole(sink: MeshSink, a: AssemblyOf<'monopole'>, ctx: BuildCtx): void {
  const p = a.params;
  sink.frustumShell(ctx.material(a.material, 'steel-galv'), {
    base: p.base,
    axis: p.axis ?? [0, 1, 0],
    profile: p.profile,
    capBottom: true,
    capTop: true,
    ...(p.sides === 0 ? {} : { sides: p.sides }),
  });
}

/** Share of a panel's width its rounded back keeps, so the face is the largest flat side. */
const PANEL_BACK = 0.8;
/** A dish's back radius as a share of its rim radius, and its rim tube as a share of the size. */
const DISH_BACK = 0.3;
const DISH_RIM = 0.02;

/** Bevelled radome with round corners. Dimensions describe the outer envelope, not a scale ratio. */
function radome(
  sink: MeshSink,
  material: string,
  c: V3,
  right: V3,
  up: V3,
  front: V3,
  w: number,
  h: number,
  d: number,
) {
  const bevel = Math.min(0.02, w / 12, h / 12, d / 6);
  const ring = (width: number, height: number, depth: number) => {
    const r = Math.min(0.035, width / 6, height / 6);
    const pts: V3[] = [];
    for (const [sx, sy, angle] of [
      [1, 1, 0],
      [-1, 1, 90],
      [-1, -1, 180],
      [1, -1, 270],
    ]) {
      for (let k = 0; k < 5; k++) {
        const t = (((angle ?? 0) + k * 22.5) * Math.PI) / 180;
        const x = (sx ?? 1) * (width / 2 - r) + r * Math.cos(t);
        const y = (sy ?? 1) * (height / 2 - r) + r * Math.sin(t);
        pts.push(add(c, add(scale(right, x), add(scale(up, y), scale(front, depth)))));
      }
    }
    return pts;
  };
  const rings = [
    ring(w * PANEL_BACK, h - bevel, -d / 2),
    ring(w, h, d / 2 - bevel),
    ring(w - bevel, h - bevel, d / 2),
  ];
  const prim = sink.prim(material);
  sink.fan(prim, at(rings, 0), scale(front, -1));
  sink.fan(prim, at(rings, 2), front);
  for (let j = 0; j < 2; j++) {
    const a = at(rings, j),
      b = at(rings, j + 1);
    for (let k = 0; k < a.length; k++) {
      const points = [at(a, k), at(a, (k + 1) % a.length), at(b, (k + 1) % a.length), at(b, k)];
      let n = norm(cross(sub(at(points, 1), at(points, 0)), sub(at(points, 2), at(points, 0))));
      if (dot(n, sub(scale(points.reduce(add, [0, 0, 0]), 0.25), c)) < 0) n = scale(n, -1);
      sink.fan(prim, points, n);
    }
  }
}

/**
 * Antenna round `centre`, `size` = width, height, depth. Panel: a radome with a full face and a
 * narrower back. Dish: a shallow cone opening towards `front` (closed by a flat radome) with a
 * rim ring, diameter `size[0]`, depth `size[2]`. Rru: a box. Omni: a vertical round bar of
 * diameter `size[0]` and length `size[1]`.
 */
export function buildAntenna(sink: MeshSink, a: AssemblyOf<'antenna'>, ctx: BuildCtx): void {
  const p = a.params;
  const [w, h, d] = p.size;
  const { front, up, right } = facing(p.azimuthDeg, p.tiltDeg);
  const c = p.centre;
  switch (p.kind) {
    case 'panel':
    case 'rru': {
      const m = ctx.material(a.material, p.kind === 'panel' ? 'paint-white' : 'cabinet-grey');
      if (p.kind === 'panel') {
        radome(sink, m, c, right, up, front, w, h, d);
        return;
      }
      const finDepth = Math.min(d * 0.18, 0.035);
      hexahedron(
        sink,
        m,
        rect(add(c, scale(front, d / 2 - finDepth)), right, up, w, h),
        rect(add(c, scale(front, -d / 2)), right, up, w, h),
      );
      const fins = Math.max(5, Math.min(24, Math.round(w / 0.035)));
      for (let k = 0; k < fins; k++)
        orientedBox(
          sink,
          m,
          add(
            c,
            add(
              scale(right, w * 0.44 * ((2 * k) / (fins - 1) - 1)),
              scale(front, d / 2 - finDepth / 2),
            ),
          ),
          [right, up, front],
          [Math.min(0.006, w / 60), h * 0.46, finDepth / 2 + 0.0005],
        );
      return;
    }
    case 'dish': {
      const m = ctx.material(a.material, 'paint-white');
      const R = w / 2;
      sink.frustumShell(m, {
        base: add(c, scale(front, -d / 2)),
        axis: front,
        profile: [
          { y: 0, r: R * DISH_BACK },
          { y: d, r: R },
        ],
        capBottom: true,
        capTop: true,
      });
      sink.torus(m, { centre: add(c, scale(front, d / 2)), axis: front, R, r: w * DISH_RIM });
      return;
    }
    case 'omni': {
      const m = ctx.material(a.material, 'paint-white');
      sink.rod(m, [c[0], c[1] - h / 2, c[2]], [c[0], c[1] + h / 2, c[2]], w / 2, true);
      return;
    }
  }
}

/**
 * Antenna mount, `size` = width, height, depth, facing `azimuthDeg`; `centre` is always at
 * mid-height, and per kind it means:
 * - pipe: a point on the pipe axis. One vertical pipe, diameter `size[0]`, length `size[1]`.
 * - sector-frame: the middle of the frame's depth, half way between the tower side and the pipe
 *   face. Three vertical pipes spread over the width at the front (`size[2] / 2` out along the
 *   azimuth), two face beams just behind them and two arms running back `size[2]` from the face
 *   to the tower side.
 * - standoff: a point on the pipe axis. A vertical pipe (diameter `size[0]`) on two arms reaching
 *   back `size[2]` from it to the leg or shaft it hangs from.
 */
export function buildAntennaMount(
  sink: MeshSink,
  a: AssemblyOf<'antennaMount'>,
  ctx: BuildCtx,
): void {
  const p = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const [w, h, d] = p.size;
  const { front, right } = facing(p.azimuthDeg);
  const c = p.centre;
  const lift = (q: V3, dy: number): V3 => [q[0], q[1] + dy, q[2]];
  const pipe = (q: V3, r: number) => {
    sink.rod(m, lift(q, -h / 2), lift(q, h / 2), r, true);
  };
  switch (p.kind) {
    case 'clamp': {
      if (!p.anchor || !p.pipeDiameter) throw new Error('clamp needs anchor and pipe diameter');
      const anchor = p.anchor,
        up: V3 = [0, 1, 0];
      const dir = norm([anchor[0] - c[0], 0, anchor[2] - c[2]]);
      const across = norm(cross(up, dir));
      const radius = p.pipeDiameter / 2 + 0.009;
      const plate = add(c, scale(dir, radius + 0.01));
      const frame = facing(p.azimuthDeg, p.tiltDeg ?? 0);
      orientedBox(
        sink,
        m,
        plate,
        [across, up, dir],
        [Math.max(w / 2, radius + 0.025), h / 2, 0.008],
      );
      orientedBox(
        sink,
        m,
        sub(anchor, scale(frame.front, 0.006)),
        [frame.right, frame.up, frame.front],
        [w / 2, h / 2, 0.006],
      );
      // Two rectangular arms and bolt heads retain the measured device anchor.
      for (const s of [-1, 1]) {
        const offset = scale(across, s * w * 0.32);
        const end = add(anchor, scale(frame.right, s * w * 0.32));
        sink.beam(m, add(plate, offset), end, 0.025);
        sink.rod(
          m,
          sub(end, scale(frame.front, 0.012)),
          add(end, scale(frame.front, 0.008)),
          0.011,
          true,
          8,
        );
      }
      for (const dy of [-h * 0.3, h * 0.3]) {
        let previous: V3 | undefined;
        for (let i = 0; i <= 12; i++) {
          const theta = (Math.PI * i) / 12;
          const q = add(
            add(c, [0, dy, 0]),
            add(scale(across, radius * Math.cos(theta)), scale(dir, -radius * Math.sin(theta))),
          );
          if (previous) sink.rod(m, previous, q, 0.005, true, 8);
          previous = q;
        }
        for (const s of [-1, 1]) {
          const q = add(add(c, [0, dy, 0]), scale(across, s * radius));
          const end = add(q, scale(dir, radius + 0.03));
          sink.rod(m, q, end, 0.005, true, 8);
          sink.rod(m, sub(end, scale(dir, 0.008)), end, 0.01, true, 8);
        }
      }
      return;
    }
    case 'pipe':
      pipe(c, w / 2);
      return;
    case 'standoff': {
      const r = w / 2;
      pipe(c, r);
      const back = add(c, scale(front, -d));
      for (const dy of [-h / 3, h / 3]) sink.beam(m, lift(back, dy), lift(c, dy), r * 1.2);
      return;
    }
    case 'sector-frame': {
      const r = Math.max(0.025, Math.min(0.06, Math.min(w, h) * 0.02));
      const s = r * 1.6;
      const face = add(c, scale(front, d / 2));
      const across = (k: number) => add(face, scale(right, (k * w) / 2));
      for (const k of [-1, 0, 1]) pipe(across(k), r);
      // face beams just behind the pipes, arms from the tower side out to the face
      const behind = scale(front, -(r + s / 2));
      for (const dy of [-h / 4, h / 4]) {
        sink.beam(m, lift(add(across(-1), behind), dy), lift(add(across(1), behind), dy), s);
        sink.beam(m, lift(add(c, scale(front, -d / 2)), dy), lift(face, dy), s);
      }
      return;
    }
  }
}

export const TELECOM_BUILDERS = {
  monopole: buildMonopole,
  antenna: buildAntenna,
  antennaMount: buildAntennaMount,
} satisfies BuilderTable;
