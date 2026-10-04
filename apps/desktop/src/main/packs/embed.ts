// Map packs inside `.aio` packages: the region a project needs, clipped from an installed pack
// at export, and listed and served from the package when the player's machine has no pack there.
import type { ZipArchive, ZipMember } from '@aio/project/package';
import { isKnownCrs, toWgs84 } from '@aio/geo';
import {
  EMBEDDED_PACKS_DIR,
  MapPackInfo,
  type PackageMapPackRequest,
  type PackagePlan,
  type ProjectManifest,
  type Vec3,
} from '@aio/schema';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileSource, planExtract, runExtract, type ExtractPlan } from './extract';

export type Bbox = [number, number, number, number];

/** Points of the site in the project CRS: the origin and the corners of placed rasters. */
function sitePoints(m: ProjectManifest): Vec3[] {
  const [ox, oy, oz] = m.origin;
  const pts: Vec3[] = [[ox, oy, oz]];
  // Local frame to project CRS: E = ox + x, N = oy - z (data conventions section 1).
  const toCrs = ([x, y, z]: readonly number[]): Vec3 => [
    ox + (x ?? 0),
    oy - (z ?? 0),
    oz + (y ?? 0),
  ];
  for (const l of m.layers) {
    if (l.kind === 'raster' && l.corners) {
      const { tl, tr, bl } = l.corners;
      const br: Vec3 = [tr[0] + bl[0] - tl[0], tr[1] + bl[1] - tl[1], tr[2] + bl[2] - tl[2]];
      for (const c of [tl, tr, bl, br]) pts.push(toCrs(c));
    }
  }
  return pts;
}

/**
 * Lon/lat box of the project site grown by `marginKm` on every side, or null when the project
 * has no known CRS (no map position).
 */
export function projectBbox(m: ProjectManifest, marginKm: number): Bbox | null {
  if (!('epsg' in m.crs) || !isKnownCrs(m.crs.epsg)) return null;
  const epsg = m.crs.epsg;
  const ll = sitePoints(m).map((p) => toWgs84(p, epsg));
  const lons = ll.map((p) => p[0]);
  const lats = ll.map((p) => p[1]);
  if (!lons.every(Number.isFinite) || !lats.every(Number.isFinite)) return null;
  const s = Math.min(...lats);
  const n = Math.max(...lats);
  const dLat = marginKm / 111.32;
  const mid = ((s + n) / 2) * (Math.PI / 180);
  const dLon = marginKm / (111.32 * Math.max(0.05, Math.cos(mid)));
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  return [
    round(Math.max(-180, Math.min(...lons) - dLon)),
    round(Math.max(-85, s - dLat)),
    round(Math.min(180, Math.max(...lons) + dLon)),
    round(Math.min(85, n + dLat)),
  ];
}

const covers = (outer: readonly number[], inner: readonly number[]) =>
  (outer[0] ?? 0) <= (inner[0] ?? 0) &&
  (outer[1] ?? 0) <= (inner[1] ?? 0) &&
  (outer[2] ?? 0) >= (inner[2] ?? 0) &&
  (outer[3] ?? 0) >= (inner[3] ?? 0);

const area = (b: readonly number[]) => ((b[2] ?? 0) - (b[0] ?? 0)) * ((b[3] ?? 0) - (b[1] ?? 0));

/**
 * The installed pack to clip from: it covers the whole box; among those, the ones that reach
 * `maxZoom` first, then the smallest area (a city pack before a country pack).
 */
export function choosePack(
  packs: readonly MapPackInfo[],
  bbox: Bbox,
  maxZoom: number,
): MapPackInfo | null {
  const fit = packs.filter((p) => covers(p.bbox, bbox));
  fit.sort(
    (a, b) =>
      Number(b.maxZoom >= maxZoom) - Number(a.maxZoom >= maxZoom) ||
      b.maxZoom - a.maxZoom ||
      area(a.bbox) - area(b.bbox),
  );
  return fit[0] ?? null;
}

export interface EmbedPlan {
  pack: MapPackInfo;
  file: string;
  bbox: Bbox;
  maxZoom: number;
  plan: ExtractPlan;
  head: Buffer;
}

export type EmbedPlanResult = { ok: true; value: EmbedPlan } | { ok: false; reason: string };

/** Size the region a package would carry (reads only the pack's directories). */
export async function planEmbed(o: {
  manifest: ProjectManifest;
  request: PackageMapPackRequest;
  packs: readonly MapPackInfo[];
  packsDir: string;
}): Promise<EmbedPlanResult> {
  const bbox = projectBbox(o.manifest, o.request.marginKm);
  if (!bbox) {
    return {
      ok: false,
      reason:
        'This project has no map position (its coordinate system is not known), so no map region can go with it.',
    };
  }
  const pack = choosePack(o.packs, bbox, o.request.maxZoom);
  if (!pack) {
    return {
      ok: false,
      reason:
        'No installed map pack covers this site. Add one in Settings, Offline maps, then export again.',
    };
  }
  const file = join(o.packsDir, `${pack.id}.pmtiles`);
  try {
    const { plan, head } = await planExtract(fileSource(file), {
      bbox,
      maxZoom: o.request.maxZoom,
    });
    return { ok: true, value: { pack, file, bbox, maxZoom: plan.maxZoom, plan, head } };
  } catch (e) {
    return {
      ok: false,
      reason: `The map pack "${pack.label}" could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** What the export dialog shows for an embed plan. */
export function embedSummary(r: EmbedPlanResult): NonNullable<PackagePlan['mapPack']> {
  if (!r.ok) return { ok: false, reason: r.reason };
  const v = r.value;
  return {
    ok: true,
    sourceId: v.pack.id,
    sourceLabel: v.pack.label,
    bbox: v.bbox,
    maxZoom: v.maxZoom,
    bytes: v.plan.totalBytes,
    tiles: v.plan.tiles,
  };
}

/**
 * Clip the planned region into a temp file and return the package members for it
 * (`packs/<id>.pmtiles` and its `MapPackInfo`). `dispose` deletes the temp file.
 */
export async function writeEmbed(
  e: EmbedPlan,
  o: { tempDir: string; projectName: string; signal?: AbortSignal },
): Promise<{ members: ZipMember[]; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(o.tempDir, 'stratlas-pack-'));
  try {
    const out = join(dir, `${e.pack.id}.pmtiles`);
    await runExtract({
      source: fileSource(e.file),
      plan: e.plan,
      head: e.head,
      out,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    const size = (await stat(out)).size;
    const info: MapPackInfo = {
      id: e.pack.id,
      label: `${e.pack.label}, ${o.projectName}`,
      bbox: e.bbox,
      maxZoom: e.maxZoom,
      sizeBytes: size,
      ...(e.pack.builtAt ? { builtAt: e.pack.builtAt } : {}),
      ...(e.pack.build ? { build: e.pack.build } : {}),
    };
    const json = Buffer.from(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
    return {
      members: [
        { name: `${EMBEDDED_PACKS_DIR}/${e.pack.id}.pmtiles`, file: out, size },
        { name: `${EMBEDDED_PACKS_DIR}/${e.pack.id}.json`, data: json },
      ],
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Map packs a package carries: `packs/<id>.pmtiles` with a valid `packs/<id>.json`. */
export async function packagePacks(
  archive: Pick<ZipArchive, 'entries' | 'read'>,
): Promise<{ info: MapPackInfo; member: string }[]> {
  const out: { info: MapPackInfo; member: string }[] = [];
  const re = new RegExp(`^${EMBEDDED_PACKS_DIR}/([a-z0-9-]+)\\.json$`);
  for (const name of archive.entries.keys()) {
    const m = re.exec(name);
    const member = m ? `${EMBEDDED_PACKS_DIR}/${m[1] ?? ''}.pmtiles` : null;
    if (!member || !archive.entries.has(member)) continue;
    try {
      const r = MapPackInfo.safeParse(JSON.parse((await archive.read(name)).toString('utf8')));
      if (r.success) out.push({ info: r.data, member });
    } catch {
      // A damaged description: the pack is skipped, the package still opens.
    }
  }
  return out;
}

/** Id under which an embedded pack is listed and served (`aio://packs/<id>.pmtiles`). */
export const embeddedId = (projectId: string, packId: string) => `pkg-${projectId}-${packId}`;

export interface EmbeddedPack {
  id: string;
  info: MapPackInfo;
  archive: ZipArchive;
  member: string;
}

/**
 * Embedded packs of the open packages that this machine lacks: a pack is used unless an
 * installed pack has its id or covers its area at its zoom or deeper.
 */
export async function embeddedPacks(
  installed: readonly MapPackInfo[],
  packages: Iterable<readonly [string, { archive: ZipArchive }]>,
): Promise<EmbeddedPack[]> {
  const out: EmbeddedPack[] = [];
  for (const [projectId, { archive }] of packages) {
    for (const { info, member } of await packagePacks(archive)) {
      const have = installed.some(
        (p) => p.id === info.id || (covers(p.bbox, info.bbox) && p.maxZoom >= info.maxZoom),
      );
      if (have) continue;
      out.push({ id: embeddedId(projectId, info.id), info, archive, member });
    }
  }
  return out;
}

/** `packs:list`: installed packs, then the embedded ones the machine lacks. */
export function listWithEmbedded(
  installed: readonly MapPackInfo[],
  embedded: readonly EmbeddedPack[],
): MapPackInfo[] {
  return [
    ...installed,
    ...embedded.map((e): MapPackInfo => ({ ...e.info, id: e.id, source: 'package' })),
  ];
}

/** The package member behind an embedded pack id, for `aio://packs/<id>.pmtiles`. */
export function findEmbedded(
  id: string,
  packages: Iterable<readonly [string, { archive: ZipArchive }]>,
): { archive: ZipArchive; member: string } | undefined {
  for (const [projectId, { archive }] of packages) {
    const prefix = embeddedId(projectId, '');
    if (!id.startsWith(prefix)) continue;
    const member = `${EMBEDDED_PACKS_DIR}/${id.slice(prefix.length)}.pmtiles`;
    if (archive.entries.has(member)) return { archive, member };
  }
  return undefined;
}
