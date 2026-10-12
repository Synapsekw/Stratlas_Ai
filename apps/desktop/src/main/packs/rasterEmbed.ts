// Imagery and terrain packs inside `.aio` packages: the region a project needs, clipped from an
// installed pack at export, and listed and served from the package when the player's machine has
// no pack there. Modelled on `embed.ts` (street packs).
import type { ZipArchive, ZipMember } from '@aio/project/package';
import {
  EMBEDDED_RASTER_DIRS,
  RasterPackMeta,
  type PackageRasterPlan,
  type ProjectManifest,
  type RasterPackInfo,
  type RasterPackKind,
  type RasterPackRef,
} from '@aio/schema';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectBbox, type Bbox } from './embed';
import { fileSource, planExtract, runExtract, type ExtractPlan } from './extract';
import { rasterPackDir } from './raster';

/** Id prefix under which a package's raster pack is listed and served. */
export const PACKAGE_RASTER_PREFIX = 'pkg-';

export interface RasterEmbedPlan {
  pack: RasterPackInfo;
  file: string;
  bbox: Bbox;
  maxZoom: number;
  plan: ExtractPlan;
  head: Buffer;
}

const KINDS: readonly RasterPackKind[] = ['imagery', 'terrain'];

const intersects = (a: readonly number[], b: readonly number[]) =>
  (a[0] ?? 0) <= (b[2] ?? 0) &&
  (a[2] ?? 0) >= (b[0] ?? 0) &&
  (a[1] ?? 0) <= (b[3] ?? 0) &&
  (a[3] ?? 0) >= (b[1] ?? 0);

const covers = (outer: readonly number[], inner: readonly number[]) =>
  (outer[0] ?? 0) <= (inner[0] ?? 0) &&
  (outer[1] ?? 0) <= (inner[1] ?? 0) &&
  (outer[2] ?? 0) >= (inner[2] ?? 0) &&
  (outer[3] ?? 0) >= (inner[3] ?? 0);

const abortError = (): Error => {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
};

/**
 * Size what each installed imagery and terrain pack that touches the site would add to a package
 * (reads only the pack's directories). Key of `plans` is `${kind}/${id}`.
 */
export async function planRasterEmbeds(o: {
  manifest: ProjectManifest;
  packs: { imagery: RasterPackInfo[]; terrain: RasterPackInfo[] };
  dataRoot: string;
  marginKm: number;
}): Promise<{ plans: Map<string, RasterEmbedPlan>; summary: PackageRasterPlan[] }> {
  const plans = new Map<string, RasterEmbedPlan>();
  const summary: PackageRasterPlan[] = [];
  const site = projectBbox(o.manifest, o.marginKm);
  for (const kind of KINDS) {
    for (const pack of o.packs[kind]) {
      const head = {
        kind,
        id: pack.id,
        label: pack.label,
        licence: pack.licence,
        attribution: pack.attribution,
        customerLicence: pack.customerLicence,
      };
      if (!site) {
        summary.push({
          ...head,
          ok: false,
          reason:
            'This project has no map position (its coordinate system is not known), so no map region can go with it.',
        });
        continue;
      }
      if (!intersects(pack.bbox, site)) continue;
      const file = join(rasterPackDir(o.dataRoot, kind), `${pack.id}.pmtiles`);
      try {
        const clip: Bbox = [
          Math.max(site[0], pack.bbox[0]),
          Math.max(site[1], pack.bbox[1]),
          Math.min(site[2], pack.bbox[2]),
          Math.min(site[3], pack.bbox[3]),
        ];
        const { plan, head: h } = await planExtract(fileSource(file), {
          bbox: clip,
          maxZoom: pack.maxZoom,
        });
        plans.set(`${kind}/${pack.id}`, {
          pack,
          file,
          bbox: clip,
          maxZoom: plan.maxZoom,
          plan,
          head: h,
        });
        summary.push({
          ...head,
          ok: true,
          bytes: plan.totalBytes,
          tiles: plan.tiles,
          maxZoom: plan.maxZoom,
        });
      } catch (e) {
        summary.push({
          ...head,
          ok: false,
          reason: `The ${kind} pack "${pack.label}" could not be read: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }
  return { plans, summary };
}

/** The plans for the packs the person ticked, or the first one that is not available. */
export function chooseRasterEmbeds(
  requested: readonly RasterPackRef[],
  planned: Awaited<ReturnType<typeof planRasterEmbeds>>,
): { ok: true; value: RasterEmbedPlan[] } | { ok: false; reason: string } {
  const value: RasterEmbedPlan[] = [];
  for (const r of requested) {
    const p = planned.plans.get(`${r.kind}/${r.id}`);
    if (!p) {
      return {
        ok: false,
        reason: `The ${r.kind} pack "${r.id}" is not installed or does not cover this site.`,
      };
    }
    value.push(p);
  }
  return { ok: true, value };
}

/**
 * Clip each planned region into a temp file and return the package members
 * (`packs/<kind>/<id>.pmtiles` and its `RasterPackMeta`). `dispose` deletes the temp folder.
 */
export async function writeRasterEmbeds(
  plans: readonly RasterEmbedPlan[],
  o: { tempDir: string; signal?: AbortSignal },
): Promise<{ members: ZipMember[]; bytes: number; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(o.tempDir, 'quadrion-raster-'));
  try {
    const members: ZipMember[] = [];
    let bytes = 0;
    for (const e of plans) {
      if (o.signal?.aborted) throw abortError();
      const out = join(dir, `${e.pack.kind}-${e.pack.id}.pmtiles`);
      await runExtract({
        source: fileSource(e.file),
        plan: e.plan,
        head: e.head,
        out,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      const size = (await stat(out)).size;
      const meta: Partial<RasterPackInfo> = { ...e.pack };
      delete meta.sizeBytes;
      delete meta.source;
      const info = {
        schema: 'aio.raster-pack/1',
        ...meta,
        bbox: e.bbox,
        maxZoom: e.maxZoom,
        sizeBytes: size,
        source: 'package',
      };
      const json = Buffer.from(`${JSON.stringify(info, null, 2)}\n`, 'utf8');
      const base = `${EMBEDDED_RASTER_DIRS[e.pack.kind]}/${e.pack.id}`;
      members.push(
        { name: `${base}.pmtiles`, file: out, size },
        { name: `${base}.json`, data: json },
      );
      bytes += size;
    }
    return { members, bytes, dispose: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Raster packs of one kind a package carries: `<id>.pmtiles` with a valid `<id>.json`. */
export async function packageRasterPacks(
  archive: Pick<ZipArchive, 'entries' | 'read'>,
  kind: RasterPackKind,
): Promise<{ meta: RasterPackMeta; id: string; member: string }[]> {
  const dir = EMBEDDED_RASTER_DIRS[kind];
  const re = new RegExp(`^${dir}/([a-z0-9-]+)\\.json$`);
  const out: { meta: RasterPackMeta; id: string; member: string }[] = [];
  for (const name of archive.entries.keys()) {
    const m = re.exec(name);
    const id = m?.[1];
    if (!id) continue;
    const member = `${dir}/${id}.pmtiles`;
    if (!archive.entries.has(member)) continue;
    try {
      const r = RasterPackMeta.safeParse(JSON.parse((await archive.read(name)).toString('utf8')));
      if (r.success && r.data.id === id && r.data.kind === kind) {
        out.push({ meta: r.data, id, member });
      }
    } catch {
      // A damaged description: the pack is skipped, the package still opens.
    }
  }
  return out;
}

const embeddedId = (projectId: string, id: string) => `${PACKAGE_RASTER_PREFIX}${projectId}-${id}`;

/**
 * Raster packs of the open packages that this machine lacks, listed as `pkg-<projectId>-<id>`.
 * A pack is used unless an installed pack has its id or covers its area at its zoom or deeper.
 */
export async function embeddedRasterPacks(
  installed: readonly RasterPackInfo[],
  packages: Iterable<readonly [string, { archive: ZipArchive }]>,
  kind: RasterPackKind,
): Promise<RasterPackInfo[]> {
  const out: RasterPackInfo[] = [];
  for (const [projectId, { archive }] of packages) {
    for (const { meta, id, member } of await packageRasterPacks(archive, kind)) {
      const have = installed.some(
        (p) => p.id === id || (covers(p.bbox, meta.bbox) && p.maxZoom >= meta.maxZoom),
      );
      if (have) continue;
      const size = archive.entries.get(member)?.size;
      out.push({
        id: embeddedId(projectId, id),
        kind: meta.kind,
        label: meta.label,
        bbox: meta.bbox,
        minZoom: meta.minZoom,
        maxZoom: meta.maxZoom,
        tileSize: meta.tileSize,
        format: meta.format,
        ...(meta.encoding ? { encoding: meta.encoding } : {}),
        ...(meta.verticalDatum ? { verticalDatum: meta.verticalDatum } : {}),
        licence: meta.licence,
        attribution: meta.attribution,
        ...(meta.provenance !== undefined ? { provenance: meta.provenance } : {}),
        customerLicence: meta.customerLicence,
        builtAt: meta.builtAt,
        sizeBytes: typeof size === 'number' ? size : 0,
        source: 'package',
      });
    }
  }
  return out;
}

/** The package member behind an embedded raster pack id, for `aio://packs/<kind>/<id>.pmtiles`. */
export function findEmbeddedRaster(
  kind: RasterPackKind,
  id: string,
  packages: Iterable<readonly [string, { archive: ZipArchive }]>,
): { archive: ZipArchive; member: string } | undefined {
  for (const [projectId, { archive }] of packages) {
    const prefix = embeddedId(projectId, '');
    if (!id.startsWith(prefix)) continue;
    const member = `${EMBEDDED_RASTER_DIRS[kind]}/${id.slice(prefix.length)}.pmtiles`;
    if (archive.entries.has(member)) return { archive, member };
  }
  return undefined;
}
