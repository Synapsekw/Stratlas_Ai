import { crsOption, fromWgs84 } from '@aio/geo';
import {
  projectPurpose,
  type Layer,
  type ProjectManifest,
  type ProjectPurpose,
  type ProjectType,
  type SeverityTemplate,
  type Vec3,
} from '@aio/schema';

/** The new project wizard's form. */
export interface WizardForm {
  name: string;
  customer: string;
  site: string;
  /** The card picked; the project's `type` is `PURPOSE_TYPE` of it. */
  purpose: ProjectPurpose;
  epsg: number;
  /** Project CRS (E, N, H), null until chosen. */
  origin: Vec3 | null;
  severityTemplate: string | null;
}

/**
 * The cards of the wizard's type picker. Each writes its id as the manifest's `purpose` and the
 * older `type` it maps to (`PURPOSE_TYPE`), which keeps deciding every behaviour.
 */
export const PROJECT_TYPES: { id: ProjectPurpose; label: string; hint: string }[] = [
  {
    id: 'survey',
    label: 'Survey',
    hint: 'Stockpiles, earthworks and terrain by survey date, with volumes',
  },
  {
    id: 'construction',
    label: 'Construction',
    hint: 'A building site followed visit by visit, with drawings and designs',
  },
  {
    id: 'vertical-asset',
    label: 'Vertical asset inspection',
    hint: 'A stack, tower, flare or facade: photos, video and a model, graded defects',
  },
  {
    id: 'confined-space',
    label: 'Confined space inspection',
    hint: 'Inside a tank, vessel or duct: photos and a model or scan, graded defects',
  },
  {
    id: 'data-fusion',
    label: 'Data fusion',
    hint: 'A large site with many sensors: any mix of data in one scene',
  },
  { id: 'road', label: 'Road', hint: 'Corridor orthomosaic, distress mapping, PCI' },
];

/**
 * What a project shows as its type: the purpose the wizard wrote, or one of the two older types
 * that no card writes any more (an inspection of either kind, a digital twin).
 */
export type ProjectKind = ProjectPurpose | 'inspection' | 'twin';

/** The older `type` as a kind, for a project without a purpose this build knows. */
const TYPE_KIND: Record<ProjectType, ProjectKind> = {
  volumetric: 'survey',
  road: 'road',
  fusion: 'data-fusion',
  inspection: 'inspection',
  twin: 'twin',
};

/**
 * The kind to show for a project: its purpose, else what its `type` says (every project from
 * before the purpose existed, and one whose purpose a later build wrote); null with neither.
 */
export function projectKind(
  manifest: Pick<ProjectManifest, 'type' | 'purpose'>,
): ProjectKind | null {
  return projectPurpose(manifest) ?? (manifest.type ? TYPE_KIND[manifest.type] : null);
}

export function kindLabel(kind: ProjectKind): string {
  if (kind === 'inspection') return 'Inspection';
  if (kind === 'twin') return 'Digital twin';
  return PROJECT_TYPES.find((c) => c.id === kind)?.label ?? kind;
}

const ASSET_STARTER = [
  'Photos of the asset (JPG with GPS and gimbal angles)',
  'The 3D model of the asset (GLB or OBJ)',
  'Flight video with its DJI SRT log beside it (MP4 or MOV)',
];
const SITE_STARTER = [
  'The site model (GLB or OBJ) and point clouds (LAS, LAZ, E57 or PLY)',
  'Orthomosaics and elevation models (GeoTIFF)',
  'Photos (JPG) and flight video with its DJI SRT log (MP4 or MOV)',
  'Site drawings (DXF)',
];

/**
 * Which data to add first to an empty project of a kind. The lines name only file kinds that
 * Import files takes (`@aio/project` builder/raw.ts); model.test.ts holds them to that.
 */
const STARTERS: Record<ProjectKind, readonly string[]> = {
  survey: [
    'The orthomosaic and elevation model (DSM) of each survey date, as GeoTIFF',
    'Or the drone photos of each date (JPG with GPS), to make the maps here',
    'A design surface to compare with (LandXML or 12da)',
  ],
  construction: [
    'Drone photos (JPG with GPS) or the orthomosaic (GeoTIFF) of each visit',
    'The site drawing (DXF) and the design surfaces (LandXML or 12da)',
    'A model of the works (GLB or OBJ) or a point cloud (LAS, LAZ, E57 or PLY)',
  ],
  'vertical-asset': ASSET_STARTER,
  'confined-space': [
    'Photos from inside (JPG); without GPS they are listed in Media, not placed',
    'A model or scan of the space (GLB, OBJ, LAS, LAZ, E57 or PLY)',
    'Video only with its DJI SRT log beside it (MP4 or MOV)',
  ],
  'data-fusion': SITE_STARTER,
  road: [
    'The corridor orthomosaic (GeoTIFF)',
    'Photos along the road, if there are any (JPG with GPS)',
    'The defect polygons are picked later, in Run the road builder',
  ],
  inspection: ASSET_STARTER,
  twin: SITE_STARTER,
};

export function starterFor(kind: ProjectKind): readonly string[] {
  return STARTERS[kind];
}

/**
 * The severity template a new project of a type starts with: a road survey takes one with a road
 * catalogue (so it opens in the road workspace), other types the first that is not a road one.
 */
export function defaultTemplateFor(
  type: ProjectType,
  templates: readonly SeverityTemplate[],
): string | null {
  const road = (t: SeverityTemplate) => t.catalogue?.assetType === 'road';
  const pick = type === 'road' ? templates.find(road) : templates.find((t) => !road(t));
  return (pick ?? templates[0])?.id ?? null;
}

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
