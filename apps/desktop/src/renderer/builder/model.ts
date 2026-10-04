import { crsOption, fromWgs84 } from '@aio/geo';
import type { Layer, ProjectType, Vec3 } from '@aio/schema';

/** The new project wizard's form. */
export interface WizardForm {
  name: string;
  customer: string;
  site: string;
  type: ProjectType;
  epsg: number;
  /** Project CRS (E, N, H), null until chosen. */
  origin: Vec3 | null;
  severityTemplate: string | null;
}

export const PROJECT_TYPES: { id: ProjectType; label: string; hint: string }[] = [
  {
    id: 'inspection',
    label: 'Inspection',
    hint: 'Photos, video and a model of one asset, graded defects',
  },
  { id: 'volumetric', label: 'Volumetric', hint: 'Stockpiles and earthworks by date, volumes' },
  { id: 'road', label: 'Road', hint: 'Corridor orthomosaic, distress mapping, PCI' },
  { id: 'twin', label: 'Digital twin', hint: 'Plant model, ortho, point cloud, flights' },
  { id: 'fusion', label: 'Free fusion', hint: 'Any mix of data in one scene' },
];

/** Problems that block creating the project, by field. */
export function wizardProblems(f: WizardForm): Partial<Record<'name' | 'epsg' | 'origin', string>> {
  const out: Partial<Record<'name' | 'epsg' | 'origin', string>> = {};
  if (!f.name.trim()) out.name = 'Give the project a name.';
  if (f.epsg === 4326 || f.epsg === 3857)
    out.epsg = 'Pick a projected CRS in metres (a UTM zone), not longitude and latitude.';
  else if (!crsOption(f.epsg)) out.epsg = `EPSG:${String(f.epsg)} is not available offline.`;
  if (!f.origin) out.origin = 'Set the project origin.';
  return out;
}

/**
 * A typed coordinate: "lat, lon[, h]" in degrees, or "E N [H]" in the project CRS (metres).
 * Returns project CRS (E, N, H) or null.
 */
export function parseCoordinate(text: string, epsg: number): Vec3 | null {
  const nums = text
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
  if (nums.length < 2 || nums.length > 3 || nums.some((n) => !Number.isFinite(n))) return null;
  const [a = 0, b = 0, h = 0] = nums;
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
    try {
      const p = fromWgs84([b, a, h], epsg);
      return [p[0], p[1], h];
    } catch {
      return null;
    }
  }
  return [a, b, h];
}

/** Inverse of a column-major 4x4 (null when singular). */
export function invertMat4(m: readonly number[]): number[] | null {
  const a = (i: number) => m[i] ?? 0;
  const [a00, a01, a02, a03] = [a(0), a(1), a(2), a(3)];
  const [a10, a11, a12, a13] = [a(4), a(5), a(6), a(7)];
  const [a20, a21, a22, a23] = [a(8), a(9), a(10), a(11)];
  const [a30, a31, a32, a33] = [a(12), a(13), a(14), a(15)];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-15) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

/** A point picked in the scene (local frame) in the mesh's own coordinates. */
export function modelPoint(transform: readonly number[], world: Vec3): Vec3 {
  const inv = invertMat4(transform);
  if (!inv) throw new Error('The model transform cannot be inverted.');
  const e = (i: number) => inv[i] ?? 0;
  const [x, y, z] = world;
  return [
    e(0) * x + e(4) * y + e(8) * z + e(12),
    e(1) * x + e(5) * y + e(9) * z + e(13),
    e(2) * x + e(6) * y + e(10) * z + e(14),
  ];
}

/** Video time (s) of a clip at project time `nowMs`, with a trial time offset. */
export function clipVideoTime(
  clip: Extract<Layer, { kind: 'video' }>,
  nowMs: number,
  offsetMs = clip.offsetMs,
): number {
  return Math.max(0, (nowMs - clip.flight.startUtcMs - offsetMs) / 1000);
}
