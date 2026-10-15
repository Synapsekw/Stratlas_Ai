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
    axis: [0, 1, 0],
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
      const backW = p.kind === 'panel' ? w * PANEL_BACK : w;
      hexahedron(
        sink,
        m,
        rect(add(c, scale(front, d / 2)), right, up, w, h),
        rect(add(c, scale(front, -d / 2)), right, up, backW, h),
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
 * Antenna mount round `centre`, `size` = width, height, depth, facing `azimuthDeg`. Pipe: one
 * vertical pipe, diameter `size[0]`, length `size[1]`. Sector frame: three vertical pipes spread
 * over the width at the front (`size[2] / 2` out along the azimuth), two face beams just behind
 * them and two arms running back `size[2]` towards the tower. Standoff: a vertical pipe (diameter
 * `size[0]`) at `centre` on two arms reaching back `size[2]` to the leg or shaft it hangs from.
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
