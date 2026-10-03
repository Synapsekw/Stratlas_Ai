/** Screen-space nearest point search. Pure; positions are in the space `m` maps to clip space. */

export interface ProjectedHit {
  index: number;
  /** NDC depth (-1 near .. 1 far). */
  depth: number;
}

/**
 * Among `count` points (xyz triples), find the front-most one whose projection lies inside the
 * ellipse of NDC radii `rx`, `ry` around (`x`, `y`). `m` is a column-major 4x4 (model-view-projection).
 * `keep` can reject points (clipping planes); it receives the untransformed coordinates.
 */
export function nearestProjected(
  positions: ArrayLike<number>,
  count: number,
  m: ArrayLike<number>,
  x: number,
  y: number,
  rx: number,
  ry: number,
  keep?: (px: number, py: number, pz: number) => boolean,
): ProjectedHit | null {
  const e = (i: number) => m[i] ?? 0;
  const [m0, m1, m3, m4, m5, m7, m8, m9, m11, m12, m13, m15] = [
    e(0),
    e(1),
    e(3),
    e(4),
    e(5),
    e(7),
    e(8),
    e(9),
    e(11),
    e(12),
    e(13),
    e(15),
  ];
  const m2 = e(2);
  const m6 = e(6);
  const m10 = e(10);
  const m14 = e(14);
  let best: ProjectedHit | null = null;
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3] ?? 0;
    const py = positions[i * 3 + 1] ?? 0;
    const pz = positions[i * 3 + 2] ?? 0;
    const w = m3 * px + m7 * py + m11 * pz + m15;
    if (w <= 0) continue;
    const dx = (m0 * px + m4 * py + m8 * pz + m12) / w - x;
    const dy = (m1 * px + m5 * py + m9 * pz + m13) / w - y;
    if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) continue;
    const depth = (m2 * px + m6 * py + m10 * pz + m14) / w;
    if (depth < -1 || depth > 1) continue;
    if (best && depth >= best.depth) continue;
    if (keep && !keep(px, py, pz)) continue;
    best = { index: i, depth };
  }
  return best;
}
