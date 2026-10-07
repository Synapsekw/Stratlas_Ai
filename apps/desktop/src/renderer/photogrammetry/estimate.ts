import type { PhotoEstimate, PhotoPreset, PhotoProduct } from '@aio/schema';

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
    hint: 'A quick orthomosaic and surface on a laptop, for flat sites.',
    detail: 'Photos at a quarter of their size; the surface comes from the matched points only.',
  },
  {
    id: 'standard',
    label: 'Balanced',
    hint: 'Ortho, surface, point cloud and mesh for most surveys and inspections.',
    detail: 'Photos at half size; depth from every photo on the CPU.',
  },
  {
    id: 'high',
    label: 'High',
    hint: 'Close-range inspection and fine detail. Slow without a supported GPU.',
    detail: 'Photos at full size; the GPU when one is supported, else the CPU.',
  },
];

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
