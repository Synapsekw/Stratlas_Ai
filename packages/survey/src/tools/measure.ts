import {
  bearingDeg,
  clipToRect,
  horizontalDistance,
  planArea,
  planPerimeter,
  sampleProfile,
  segments,
  slopeDistance,
  spatialArea,
  type HeightSampler,
  type Profile,
  type Pt,
} from './geometry';

/**
 * The typed measurement tools' maths (PRD SRV-3): point, line and polygon families on site points
 * (E, N, Z) in the project CRS. Every value is SI (metres, square metres) and a grade is rise over
 * run. Surfaces come in through `HeightSampler` (G2's prepared tiles, a mesh, a DSM): the tools
 * never read files.
 */

// ---------------------------------------------------------------- point

export interface ElevationReadout {
  e: number;
  n: number;
  z: number;
}

export const elevation = (p: Pt): ElevationReadout => ({ e: p[0], n: p[1], z: p[2] });

export interface ElevationDifference {
  /** The surface height under the point, or null where the surface has no data. */
  surfaceZ: number | null;
  /** Point Z minus surface Z: positive when the point is above the surface. */
  dz: number | null;
}

export function elevationDifference(p: Pt, surface: HeightSampler): ElevationDifference {
  const s = surface.heightAt(p[0], p[1]);
  return { surfaceZ: s, dz: s === null ? null : p[2] - s };
}

// ---------------------------------------------------------------- line

export interface LineMetrics {
  /** Plan length. */
  horizontalM: number;
  /** Length through the vertices in 3D. */
  slopeM: number;
  /** Length along the sampled surface (null without a surface or with no data under the line). */
  terrainM: number | null;
  /** Share of the plan length the surface covered (1 when every sample had data). */
  terrainCoverage: number;
  /** Last Z minus first Z. */
  dzM: number;
  /** dz over the plan length; NaN for a vertical line. */
  grade: number;
  /** The steepest segment's grade (signed, by magnitude). */
  maxGrade: number;
  minZ: number;
  maxZ: number;
}

/**
 * Length along a sampled profile: 3D distance between consecutive samples that both have data.
 * Returns the length and the plan length covered.
 */
export function profileLength(profile: Profile): { lengthM: number; coveredM: number } {
  let lengthM = 0;
  let coveredM = 0;
  for (let i = 1; i < profile.chainage.length; i++) {
    const za = profile.z[i - 1];
    const zb = profile.z[i];
    if (za == null || zb == null) continue;
    const dc = (profile.chainage[i] ?? 0) - (profile.chainage[i - 1] ?? 0);
    lengthM += Math.hypot(dc, zb - za);
    coveredM += dc;
  }
  return { lengthM, coveredM };
}

export function lineMetrics(
  points: readonly Pt[],
  surface?: HeightSampler,
  stepM = 0.25,
): LineMetrics {
  let horizontalM = 0;
  let slopeM = 0;
  let maxGrade = 0;
  for (const [a, b] of segments(points)) {
    const h = horizontalDistance(a, b);
    horizontalM += h;
    slopeM += slopeDistance(a, b);
    const g = h === 0 ? (b[2] === a[2] ? 0 : Infinity * Math.sign(b[2] - a[2])) : (b[2] - a[2]) / h;
    if (Math.abs(g) > Math.abs(maxGrade)) maxGrade = g;
  }
  const zs = points.map((p) => p[2]);
  const first = points[0];
  const last = points[points.length - 1];
  const dzM = first && last ? last[2] - first[2] : 0;
  let terrainM: number | null = null;
  let terrainCoverage = 0;
  if (surface && points.length > 1) {
    const { lengthM, coveredM } = profileLength(sampleProfile(points, surface, stepM));
    terrainCoverage = horizontalM > 0 ? coveredM / horizontalM : 0;
    terrainM = coveredM > 0 ? lengthM : null;
  }
  return {
    horizontalM,
    slopeM,
    terrainM,
    terrainCoverage,
    dzM,
    grade: horizontalM > 0 ? dzM / horizontalM : NaN,
    maxGrade,
    minZ: zs.length ? Math.min(...zs) : 0,
    maxZ: zs.length ? Math.max(...zs) : 0,
  };
}

/** Grade in each style from rise over run: percent, degrees and the ratios' n (run over rise). */
export function gradeStyles(riseOverRun: number): {
  percent: number;
  degrees: number;
  n: number;
} {
  return {
    percent: riseOverRun * 100,
    degrees: (Math.atan(riseOverRun) * 180) / Math.PI,
    n: riseOverRun === 0 ? Infinity : 1 / Math.abs(riseOverRun),
  };
}

export interface VertexRow {
  /** Indices of the segment's vertices. */
  from: number;
  to: number;
  dE: number;
  dN: number;
  dZ: number;
  horizontalM: number;
  slopeM: number;
  grade: number;
  bearingDeg: number;
  /** Plan chainage at the segment's end. */
  chainageM: number;
}

/** The vertex difference table: one row per segment. */
export function vertexTable(points: readonly Pt[]): VertexRow[] {
  const rows: VertexRow[] = [];
  let chainageM = 0;
  segments(points).forEach(([a, b], i) => {
    const h = horizontalDistance(a, b);
    chainageM += h;
    rows.push({
      from: i,
      to: i + 1,
      dE: b[0] - a[0],
      dN: b[1] - a[1],
      dZ: b[2] - a[2],
      horizontalM: h,
      slopeM: slopeDistance(a, b),
      grade: h === 0 ? NaN : (b[2] - a[2]) / h,
      bearingDeg: bearingDeg(a, b),
      chainageM,
    });
  });
  return rows;
}

export interface Components {
  horizontalM: number;
  verticalM: number;
  slopeM: number;
  bearingDeg: number;
  /** Vertical angle above the horizontal, degrees. */
  angleDeg: number;
  grade: number;
}

/** Horizontal and vertical components from the first point to the last. */
export function components(points: readonly Pt[]): Components {
  const a = points[0];
  const b = points[points.length - 1];
  if (!a || !b)
    return { horizontalM: 0, verticalM: 0, slopeM: 0, bearingDeg: 0, angleDeg: 0, grade: 0 };
  const h = horizontalDistance(a, b);
  const v = b[2] - a[2];
  return {
    horizontalM: h,
    verticalM: v,
    slopeM: slopeDistance(a, b),
    bearingDeg: bearingDeg(a, b),
    angleDeg: (Math.atan2(v, h) * 180) / Math.PI,
    grade: h === 0 ? NaN : v / h,
  };
}

// ---------------------------------------------------------------- berm check

export interface BermSide {
  /** Toe chainage along the profile, metres. */
  toeChainageM: number;
  /** Ground height at the toe. */
  toeZ: number;
  /** Crest edge chainage on this side. */
  crestEdgeChainageM: number;
  /** Crest height above this side's toe. */
  heightM: number;
  /** The side slope (rise over run, positive). */
  slope: number;
}

export interface BermCheck {
  crestZ: number;
  /** Width of the top, edge to edge. */
  crestWidthM: number;
  /** Width at the base, toe to toe. */
  baseWidthM: number;
  left: BermSide;
  right: BermSide;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

/** Least-squares line z = a + b c through the points. */
function fitLine(cs: number[], zs: number[]): { a: number; b: number } | null {
  const n = cs.length;
  if (n < 2) return null;
  const mc = cs.reduce((s, x) => s + x, 0) / n;
  const mz = zs.reduce((s, x) => s + x, 0) / n;
  let sxx = 0;
  let sxz = 0;
  for (let i = 0; i < n; i++) {
    const dc = (cs[i] ?? 0) - mc;
    sxx += dc * dc;
    sxz += dc * ((zs[i] ?? 0) - mz);
  }
  if (sxx === 0) return null;
  const b = sxz / sxx;
  return { a: mz - b * mc, b };
}

/**
 * A berm (safety bund, windrow) across a profile that runs from ground on one side, over the
 * berm, to ground on the other. Ground on each side is the median of the outer `groundShare` of
 * the samples; the crest is the highest level (samples within `crestTolM` of the top); each side
 * slope is a least-squares line through its samples between 20 % and 80 % of the height, and the
 * toe and crest edge are where that line meets the ground and crest levels. Exact for a
 * trapezoid on level ground whatever the sample step. Null when the profile has no berm.
 */
export function bermCheck(
  profile: { chainage: readonly number[]; z: readonly (number | null)[] },
  opts: { groundShare?: number; crestTolM?: number } = {},
): BermCheck | null {
  const cs: number[] = [];
  const zs: number[] = [];
  profile.chainage.forEach((c, i) => {
    const z = profile.z[i];
    if (z != null) {
      cs.push(c);
      zs.push(z);
    }
  });
  const n = cs.length;
  if (n < 5) return null;
  const share = opts.groundShare ?? 0.1;
  const k = Math.max(1, Math.floor(n * share));
  const groundL = median(zs.slice(0, k));
  const groundR = median(zs.slice(n - k));
  const top = Math.max(...zs);
  const height = top - Math.max(groundL, groundR);
  if (!(height > 0)) return null;
  const tol = opts.crestTolM ?? Math.max(0.005, height * 0.01);
  const peak = zs.indexOf(top);
  // the crest: contiguous samples around the peak within the tolerance
  let lo = peak;
  let hi = peak;
  while (lo > 0 && (zs[lo - 1] ?? -Infinity) >= top - tol) lo--;
  while (hi < n - 1 && (zs[hi + 1] ?? -Infinity) >= top - tol) hi++;
  const crestZ = median(zs.slice(lo, hi + 1));
  const side = (from: number, to: number, ground: number, dir: -1 | 1): BermSide | null => {
    const h = crestZ - ground;
    const fc: number[] = [];
    const fz: number[] = [];
    for (let i = from; dir < 0 ? i >= to : i <= to; i += dir) {
      const z = zs[i] ?? ground;
      if (z >= ground + 0.2 * h && z <= ground + 0.8 * h) {
        fc.push(cs[i] ?? 0);
        fz.push(z);
      }
    }
    let line = fitLine(fc, fz);
    if (!line) {
      // too few samples on the slope (coarse sampling): the chord from the crest's last sample
      // to the first sample outward at or below 20 % of the height
      let g = from;
      while ((dir < 0 ? g > to : g < to) && (zs[g] ?? ground) > ground + 0.2 * h) g += dir;
      const c0 = cs[from] ?? 0;
      const c1 = cs[g] ?? 0;
      if (c1 === c0) return null;
      const b = ((zs[g] ?? ground) - (zs[from] ?? crestZ)) / (c1 - c0);
      line = { a: (zs[from] ?? crestZ) - b * c0, b };
    }
    if (line.b === 0) return null;
    const toe = (ground - line.a) / line.b;
    const edge = (crestZ - line.a) / line.b;
    return {
      toeChainageM: toe,
      toeZ: ground,
      crestEdgeChainageM: edge,
      heightM: h,
      slope: Math.abs(line.b),
    };
  };
  const left = side(lo, 0, groundL, -1);
  const right = side(hi, n - 1, groundR, 1);
  if (!left || !right) return null;
  return {
    crestZ,
    crestWidthM: right.crestEdgeChainageM - left.crestEdgeChainageM,
    baseWidthM: right.toeChainageM - left.toeChainageM,
    left,
    right,
  };
}

// ---------------------------------------------------------------- polygon

export interface PolygonAreas {
  /** Plan (horizontal) area. */
  horizontalM2: number;
  /** Area of the polygon through its own vertices in 3D. */
  slopeM2: number;
  /** Area of the surface inside the polygon (null without a surface or with no data). */
  terrainM2: number | null;
  /** Plan area the surface had no data for. */
  uncoveredM2: number;
  perimeterM: number;
}

/**
 * Surface area of `surface` inside the ring: the plan is cut into `stepM` cells, each cell's
 * coverage by the polygon is clipped exactly, and its surface is two triangles through the
 * corner heights. Exact for a plane at any step.
 */
export function terrainArea(
  ring: readonly Pt[],
  surface: HeightSampler,
  stepM: number,
): { areaM2: number; uncoveredM2: number } {
  if (ring.length < 3) return { areaM2: 0, uncoveredM2: 0 };
  const o = ring[0] ?? [0, 0, 0];
  // relative coordinates: projected eastings are large, cells are small
  const rel = ring.map((p) => [p[0] - o[0], p[1] - o[1]] as const);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rel) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  // at most about 250,000 cells
  const span = Math.max(maxX - minX, maxY - minY);
  const step = Math.max(stepM, span / 500);
  const cols = Math.max(1, Math.ceil((maxX - minX) / step));
  const rows = Math.max(1, Math.ceil((maxY - minY) / step));
  const h = (x: number, y: number) => surface.heightAt(x + o[0], y + o[1]);
  // heights at the cell corners, computed once
  const zs: (number | null)[] = new Array<number | null>((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++) zs[r * (cols + 1) + c] = h(minX + c * step, minY + r * step);
  let areaM2 = 0;
  let uncoveredM2 = 0;
  const cellArea = step * step;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = minX + c * step;
      const y0 = minY + r * step;
      const clip = clipToRect(rel, x0, y0, x0 + step, y0 + step);
      if (clip.length < 3) continue;
      const cover = planArea(clip);
      if (cover <= 0) continue;
      const z00 = zs[r * (cols + 1) + c];
      const z10 = zs[r * (cols + 1) + c + 1];
      const z01 = zs[(r + 1) * (cols + 1) + c];
      const z11 = zs[(r + 1) * (cols + 1) + c + 1];
      if (z00 == null || z10 == null || z01 == null || z11 == null) {
        uncoveredM2 += cover;
        continue;
      }
      const t1 = spatialArea([
        [0, 0, z00],
        [step, 0, z10],
        [step, step, z11],
      ]);
      const t2 = spatialArea([
        [0, 0, z00],
        [step, step, z11],
        [0, step, z01],
      ]);
      areaM2 += cover * ((t1 + t2) / cellArea);
    }
  }
  return { areaM2, uncoveredM2 };
}

export function polygonAreas(
  ring: readonly Pt[],
  surface?: HeightSampler,
  stepM = 0.5,
): PolygonAreas {
  const horizontalM2 = planArea(ring);
  let terrainM2: number | null = null;
  let uncoveredM2 = 0;
  if (surface) {
    const t = terrainArea(ring, surface, stepM);
    uncoveredM2 = t.uncoveredM2;
    terrainM2 = uncoveredM2 >= horizontalM2 ? null : t.areaM2;
  }
  return {
    horizontalM2,
    slopeM2: spatialArea(ring),
    terrainM2,
    uncoveredM2,
    perimeterM: planPerimeter(ring),
  };
}
