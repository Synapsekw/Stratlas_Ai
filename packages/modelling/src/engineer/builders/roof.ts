import { add, sub, scale, cross, norm, dot, type MeshSink, type V3 } from '../geom';

/** Closed sheet following a fitted planar quad. Corrugation is bounded construction detail. */
export function roofSheet(
  sink: MeshSink,
  material: string,
  corners: [V3, V3, V3, V3],
  thickness: number,
  corrugation?: { pitch: number; depth: number },
): void {
  const [a, b, c, d] = corners;
  let up = norm(cross(sub(b, a), sub(d, a)));
  if (up[1] < 0) up = scale(up, -1);
  const n = corrugation
    ? Math.min(2048, Math.max(4, Math.ceil(Math.hypot(...sub(b, a)) / corrugation.pitch) * 4))
    : 1;
  const prim = sink.prim(material);
  const centre = scale(add(add(a, b), add(c, d)), 0.25);
  const face = (pts: V3[], normal: V3) => {
    sink.fan(prim, pts, normal);
  };
  const top: [V3, V3][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const offset = scale(up, (corrugation?.depth ?? 0) * 0.5 * Math.cos((i * Math.PI) / 2));
    top.push([add(add(a, scale(sub(b, a), t)), offset), add(add(d, scale(sub(c, d), t)), offset)]);
  }
  for (let i = 0; i < n; i++) {
    const left = top[i],
      right = top[i + 1];
    if (!left || !right) continue;
    const pts: [V3, V3, V3, V3] = [left[0], right[0], right[1], left[1]];
    const bottom = pts.map((p) => sub(p, scale(up, thickness)));
    let normal = norm(cross(sub(pts[1], pts[0]), sub(pts[3], pts[0])));
    if (dot(normal, up) < 0) normal = scale(normal, -1);
    face(pts, normal);
    face(bottom, scale(normal, -1));
    for (const [j, k] of [
      [0, 1],
      [2, 3],
      ...(i === 0 ? [[3, 0]] : []),
      ...(i === n - 1 ? [[1, 2]] : []),
    ]) {
      if (j === undefined || k === undefined) continue;
      const p = pts[j],
        q = pts[k],
        p0 = bottom[j],
        q0 = bottom[k];
      if (!p || !q || !p0 || !q0) continue;
      let side = norm(cross(sub(q, p), up));
      if (dot(side, sub(scale(add(p, q), 0.5), centre)) < 0) side = scale(side, -1);
      face([p, q, q0, p0], side);
    }
  }
}
