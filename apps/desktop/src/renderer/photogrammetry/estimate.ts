import type { PhotoCameraGroup, PhotoEstimate, PhotoPreset, PhotoProduct } from '@aio/schema';

/** The wizard's presets in plain words (plan "Quality presets"). */
export const PRESETS: readonly {
  id: PhotoPreset;
  label: string;
  hint: string;
  detail: string;
}[] = [
  {
    id: 'fast',
    label: 'Quick',
    hint: 'A quick photo map and surface, for flat sites.',
    detail: 'Photos at a quarter of their size; the surface comes from the matched points only.',
  },
  {
    id: 'standard',
    label: 'Standard',
    hint: 'Maps, point cloud and 3D model for most surveys and inspections.',
    detail: 'Photos at half size; depth from every photo.',
  },
  {
    id: 'high',
    label: 'High',
    hint: 'Close-range inspection and fine detail. Much slower.',
    detail: 'Photos at full size.',
  },
];

/** The preset's name as the person reads it: "Quick", "Standard", "High". */
export const presetLabel = (preset: PhotoPreset): string =>
  PRESETS.find((p) => p.id === preset)?.label ?? preset;

/** What a run can make, in the wizard's words; `tiles` streams large results in 3D. */
export const PRODUCTS: readonly { id: PhotoProduct; label: string; hint: string }[] = [
  { id: 'ortho', label: 'Orthomosaic', hint: 'A true-scale photo map of the site.' },
  { id: 'dsm', label: 'Surface model (DSM)', hint: 'Heights of everything: volumes, change.' },
  { id: 'dtm', label: 'Terrain model (DTM)', hint: 'Bare ground, buildings and piles removed.' },
  { id: 'cloud', label: 'Point cloud', hint: 'Coloured points for measuring in 3D.' },
  { id: 'mesh', label: 'Textured mesh', hint: 'A 3D model of the site in the site view.' },
  {
    id: 'tiles',
    label: '3D Tiles',
    hint: 'The full mesh and cloud, streamed in 3D and the Globe.',
  },
];

/** The products a preset makes unless the person changes them. */
export function defaultProducts(preset: PhotoPreset): PhotoProduct[] {
  return preset === 'fast' ? ['ortho', 'dsm'] : ['ortho', 'dsm', 'dtm', 'cloud', 'mesh'];
}

/** "About 30 to 60 min", "About 3 to 6 h", "About 1 to 2 days". */
export function formatMinutes([lo, hi]: readonly [number, number]): string {
  if (hi <= 0) return 'No time: there is nothing to process.';
  const unit = (m: number): [number, string] =>
    m < 90 ? [m, 'min'] : m < 48 * 60 ? [m / 60, 'h'] : [m / 1440, 'days'];
  const [a, ua] = unit(lo);
  const [b, ub] = unit(hi);
  const r = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 2) / 2));
  if (hi < 1) return 'Under a minute';
  if (ua === ub && r(a) === r(b)) return `About ${r(b)} ${ub}`;
  if (ua === ub) return `About ${r(a)} to ${r(b)} ${ub}`;
  return `About ${r(a)} ${ua} to ${r(b)} ${ub}`;
}

/** Bytes in the units a person reads on a drive: "38 GB", "750 MB". */
export function formatBytes(b: number): string {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  if (b >= 100 * GB) return `${String(Math.round(b / GB))} GB`;
  if (b >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (b >= MB) return `${String(Math.round(b / MB))} MB`;
  return `${String(Math.max(0, Math.round(b / 1024)))} KB`;
}

/** The estimate's notes split into camera groups, the photos' UTM zone and everything else. */
export function splitNotes(e: PhotoEstimate): {
  groups: string[];
  zone: { epsg: number; text: string } | null;
  other: string[];
} {
  const groups: string[] = [];
  const other: string[] = [];
  let zone: { epsg: number; text: string } | null = null;
  for (const n of e.notes ?? []) {
    const g = /^Camera group: (.*)\.$/.exec(n);
    const z = /^The photos are in UTM zone .*\(EPSG:(\d+)\)\.$/.exec(n);
    if (g?.[1]) groups.push(g[1]);
    else if (z?.[1]) zone = { epsg: Number(z[1]), text: n };
    else other.push(n);
  }
  return { groups, zone, other };
}

/** A camera group of the estimate in the wizard: "Stratlas Synthetic SYN-20, 1600 × 1200 (58 photos)". */
export function cameraLabel(c: PhotoCameraGroup): string {
  const name = [c.make, c.model].filter(Boolean).join(' ') || 'Unknown camera';
  const focal = c.focalMm ? `, ${String(c.focalMm)} mm` : '';
  return `${name}, ${String(c.widthPx)} × ${String(c.heightPx)}${focal} (${String(c.photos)} ${c.photos === 1 ? 'photo' : 'photos'})`;
}

/** Camera groups to list: the estimate's `cameras`, then groups only a note names (no frame size). */
export function cameraGroups(e: PhotoEstimate): string[] {
  return [...(e.cameras ?? []).map(cameraLabel), ...splitNotes(e).groups];
}

/** The photos' UTM zone: the estimate's `suggestedEpsg`, else the one its note names. */
export function suggestedEpsg(e: PhotoEstimate): number | null {
  return e.suggestedEpsg ?? splitNotes(e).zone?.epsg ?? null;
}

/** True when the estimate says the data drive is too small. */
export const diskShort = (e: PhotoEstimate): boolean =>
  (e.notes ?? []).some((n) => n.startsWith('Needs ') && n.includes(' free on '));

/** A file-name safe run id from the time, e.g. `20261007-0915`, unique among `taken`. */
export function newRunId(now: Date, taken: readonly string[]): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${String(now.getFullYear())}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${String(i)}`;
    if (!taken.includes(id)) return id;
  }
}

// ---------------------------------------------------------------- the simple flow

/**
 * What **Create maps from photos** starts with when the person only chooses photos: Standard
 * quality (with its usual outputs: the photo map and the surface models, the point cloud and the
 * 3D model), each photo's own GNSS quality, the project's coordinate system, and no stop for
 * ground control.
 */
export const SIMPLE_DEFAULTS = {
  preset: 'standard',
  gnss: 'auto',
  groundControlFirst: false,
} as const satisfies { preset: PhotoPreset; gnss: string; groundControlFirst: boolean };

/** The photos of an estimate in numbers: how many, from how many cameras, how many without GPS. */
export interface PhotoSummary {
  photos: number;
  cameras: number;
  noGps: number;
  /** The count is extrapolated from a sample (large folders). */
  about: boolean;
}

/** Main reads at most this many photos for an estimate and extrapolates the rest. */
const ESTIMATE_SAMPLE = 300;

/**
 * Count the photos of an estimate. `known` is the exact count when the source says it (a photos
 * layer); folders are counted from the camera groups, which are extrapolated above the sample.
 */
export function photoSummary(e: PhotoEstimate, known?: number): PhotoSummary {
  const notes = splitNotes(e);
  const fromCameras = (e.cameras ?? []).reduce((n, c) => n + c.photos, 0);
  const fromNotes = notes.groups.reduce(
    (n, g) => n + Number(/\((?:about )?(\d+) photos?\)/.exec(g)?.[1] ?? 0),
    0,
  );
  const counted = fromCameras + fromNotes;
  const gpsText = notes.other.find((n) => n.includes(' no GPS position')) ?? '';
  const noGps = Number(/^(\d+) photos? ha(?:s|ve) no GPS position/.exec(gpsText)?.[1] ?? 0);
  const photos = known ?? counted;
  return {
    photos,
    cameras: (e.cameras ?? []).length + notes.groups.length,
    noGps: Math.min(noGps, photos),
    about: known === undefined && counted > ESTIMATE_SAMPLE,
  };
}

/** "248 photos, 1 camera, GPS on all". */
export function summaryLine(s: PhotoSummary): string {
  const n = s.photos.toLocaleString('en-US');
  const photos = `${s.about ? 'About ' : ''}${n} ${s.photos === 1 ? 'photo' : 'photos'}`;
  const cameras = `${String(s.cameras)} ${s.cameras === 1 ? 'camera' : 'cameras'}`;
  const gps =
    s.noGps === 0
      ? 'GPS on all'
      : s.noGps >= s.photos
        ? 'no GPS'
        : `${s.noGps.toLocaleString('en-US')} without GPS`;
  return `${photos}, ${cameras}, ${gps}`;
}

/** What the missing GPS means for the person, or null when every photo has a position. */
export function gpsNote(s: PhotoSummary): string | null {
  if (s.noGps === 0 || s.photos === 0) return null;
  if (s.noGps >= s.photos)
    return 'These photos have no GPS position. The maps can still be made, but they will not sit in the right place until you add ground control points.';
  const one = s.noGps === 1;
  return `${s.noGps.toLocaleString('en-US')} ${one ? 'photo has' : 'photos have'} no GPS position. ${one ? 'It is' : 'They are'} placed by matching the other photos.`;
}

const isUtm = (epsg: number) => (epsg > 32600 && epsg <= 32660) || (epsg > 32700 && epsg <= 32760);
const utmName = (epsg: number) => `UTM zone ${String(epsg % 100)}${epsg > 32700 ? 'S' : 'N'}`;

/**
 * The one coordinate question worth asking: the project and the photos are in different UTM
 * zones, so the photos were taken far from where the project is. A project on a national or
 * local grid is left alone (the photos' UTM zone says nothing about it).
 */
export function zoneQuestion(
  projectEpsg: number | null,
  photosEpsg: number | null,
): { project: { epsg: number; name: string }; photos: { epsg: number; name: string } } | null {
  if (projectEpsg === null || photosEpsg === null || projectEpsg === photosEpsg) return null;
  if (!isUtm(projectEpsg) || !isUtm(photosEpsg)) return null;
  return {
    project: { epsg: projectEpsg, name: utmName(projectEpsg) },
    photos: { epsg: photosEpsg, name: utmName(photosEpsg) },
  };
}

/** "Needs 59 GB free on the data drive, has 21 GB": the two sizes, when the drive is too small. */
export function diskNeed(e: PhotoEstimate): { needs: string; has: string } | null {
  for (const n of e.notes ?? []) {
    const m = /^Needs (.+?) free on the data drive, has (.+?)\. /.exec(n);
    if (m?.[1] && m[2]) return { needs: m[1], has: m[2] };
  }
  return null;
}

/** The estimate's note about working at a smaller size to stay within memory, if it has one. */
export const memoryNote = (e: PhotoEstimate): string | null =>
  (e.notes ?? []).find((n) => n.includes('within memory')) ?? null;

/** A run counts as long when even its quick end takes a working day. */
export const LONG_RUN_MINUTES = 8 * 60;
export const isLongRun = (e: PhotoEstimate): boolean => e.minutes[0] >= LONG_RUN_MINUTES;

/** The next quicker quality, or null for the quickest. */
export function fasterPreset(preset: PhotoPreset): PhotoPreset | null {
  return preset === 'high' ? 'standard' : preset === 'standard' ? 'fast' : null;
}

/** "About 3 to 6 h" inside a sentence: "about 3 to 6 h". */
export const timeWords = (minutes: readonly [number, number]): string => {
  const t = formatMinutes(minutes);
  return t.charAt(0).toLowerCase() + t.slice(1);
};

/**
 * The one hint about time: the chosen quality takes very long on this computer and a quicker one
 * exists. "High takes about 20 to 39 h on this computer. Standard: about 5 to 10 h."
 */
export function longRunHint(
  preset: PhotoPreset,
  estimate: PhotoEstimate,
  faster: { preset: PhotoPreset; estimate: PhotoEstimate } | null,
): { text: string; switchTo: PhotoPreset | null } | null {
  if (!isLongRun(estimate)) return null;
  const here = `${presetLabel(preset)} takes ${timeWords(estimate.minutes)} on this computer.`;
  if (!faster || faster.estimate.minutes[1] >= estimate.minutes[1])
    return { text: here, switchTo: null };
  return {
    text: `${here} ${presetLabel(faster.preset)}: ${timeWords(faster.estimate.minutes)}.`,
    switchTo: faster.preset,
  };
}
