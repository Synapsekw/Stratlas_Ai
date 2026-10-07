/**
 * The Globe (M10 stream G6): library projects as sites on the Earth (`globe:sites`, from their
 * manifests, issues and `tilesets.json`), the installed imagery and terrain packs for its menus
 * (`globe:packs`), and its preferences in userData `globe.json` (`aio.globe-settings/1`, its own
 * file, not a `Settings` field). The Globe makes no request of its own (no Cesium ion, no default
 * imagery or terrain); everything here reads local files.
 */
import { projectToLonLat } from '@aio/globe';
import {
  GlobeSettings,
  TilesetsFile,
  defaultGlobeSettings,
  type GlobeSite,
  type Issue,
  type LibraryEntry,
  type ProjectManifest,
  type RasterPackInfo,
  type RasterPackKind,
} from '@aio/schema';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './fsutil';
import type { Handle } from './notYet';
import { listRasterPacks } from './packs/raster';
import { readIssues, readManifest, type ProjectRegistry } from './project';

/** A library project's records, read for the Globe; null when it cannot be read. */
export interface GlobeProject {
  manifest: ProjectManifest;
  issues: readonly Issue[];
  tilesets: TilesetsFile | null;
}

export interface GlobeIpcDeps {
  handle: Handle;
  /** The library as `library:list` builds it. */
  library: () => Promise<LibraryEntry[]>;
  /** A project's manifest, issues and tilesets (folders; open packages from the registry). */
  readProject: (entry: LibraryEntry) => Promise<GlobeProject | null>;
  /** The data folder (`<data>/packs/imagery`, `<data>/packs/terrain`). */
  dataRoot: () => Promise<string>;
  /** userData `globe.json`. */
  settingsFile: string;
  /** The raster packs of a kind; defaults to G7's `listRasterPacks` over the data folder. */
  rasterPacks?: (kind: RasterPackKind) => Promise<RasterPackInfo[]>;
}

/** WGS84 longitude and latitude of a project origin, or null when its CRS is unknown here. */
export function originLonLat(m: Pick<ProjectManifest, 'crs' | 'origin'>): [number, number] | null {
  try {
    const [lon, lat] = projectToLonLat(m.origin, m.crs);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    return [((((lon + 180) % 360) + 360) % 360) - 180, lat];
  } catch {
    return null;
  }
}

/** A library project as a Globe site; null when the Globe cannot place it. */
export function siteOf(id: string, p: GlobeProject): GlobeSite | null {
  const lonLat = originLonLat(p.manifest);
  if (!lonLat) return null;
  const open = p.issues.filter((i) => i.status !== 'closed');
  const bySeverity: Record<string, number> = {};
  for (const i of open) bySeverity[String(i.severity)] = (bySeverity[String(i.severity)] ?? 0) + 1;
  return {
    projectId: id,
    name: p.manifest.name,
    lonLat,
    captures: p.manifest.captures.map((c) => ({ id: c.id, label: c.label, date: c.date })),
    issues: { open: open.length, bySeverity },
    tilesets: (p.tilesets?.entries ?? []).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
  };
}

/** Every native library project the Globe can place, in library order. */
export async function globeSites(
  entries: readonly LibraryEntry[],
  read: (entry: LibraryEntry) => Promise<GlobeProject | null>,
): Promise<GlobeSite[]> {
  const sites: GlobeSite[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'native') continue;
    const p = await read(entry).catch(() => null);
    const site = p ? siteOf(entry.id, p) : null;
    if (site) sites.push(site);
  }
  return sites;
}

/**
 * Read a library project for the Globe: a folder from disk; an open `.aio` package from the
 * registry (its manifest; its issues are not counted until it is opened); a locked one not at all.
 */
export function globeProjectReader(
  registry: Pick<ProjectRegistry, 'package'>,
): (entry: LibraryEntry) => Promise<GlobeProject | null> {
  return async (entry) => {
    if (entry.package) {
      const pkg = registry.package(entry.id);
      return pkg ? { manifest: pkg.manifest, issues: [], tilesets: null } : null;
    }
    const manifest = await readManifest(entry.path);
    if (!manifest.ok) return null;
    const issues = await readIssues(entry.path);
    return {
      manifest: manifest.value,
      issues: issues.ok ? issues.value : [],
      tilesets: await readTilesets(entry.path),
    };
  };
}

/** `tilesets.json` of a project folder, or null (none, or not readable by this build). */
export async function readTilesets(root: string): Promise<TilesetsFile | null> {
  const raw = await readJson(join(root, 'tilesets.json')).catch(() => undefined);
  if (raw === undefined) return null;
  const parsed = TilesetsFile.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** userData `globe.json`, or the defaults (missing or not readable). */
export async function readGlobeSettings(file: string): Promise<GlobeSettings> {
  const parsed = GlobeSettings.safeParse(await readJson(file).catch(() => undefined));
  return parsed.success ? parsed.data : defaultGlobeSettings();
}

export function registerGlobeIpc(deps: GlobeIpcDeps): void {
  const { handle } = deps;
  const packs =
    deps.rasterPacks ??
    (async (kind: RasterPackKind) => listRasterPacks(await deps.dataRoot(), kind));

  handle('globe:sites', async () => {
    try {
      return { ok: true as const, sites: await globeSites(await deps.library(), deps.readProject) };
    } catch (e) {
      return { ok: false as const, error: `The Globe could not list the projects: ${String(e)}` };
    }
  });
  handle('globe:packs', async () => {
    const [imagery, terrain] = await Promise.all([packs('imagery'), packs('terrain')]);
    return { ok: true as const, imagery, terrain };
  });
  handle('globe:getSettings', async () => ({
    ok: true as const,
    settings: await readGlobeSettings(deps.settingsFile),
  }));
  handle('globe:setSettings', async ({ settings }) => {
    try {
      await writeJsonAtomic(deps.settingsFile, settings);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: `Globe settings were not saved: ${String(e)}` };
    }
  });
}
