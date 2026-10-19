/**
 * The processed outputs of the sites in focus on the Globe, renderer side: which sites are in
 * focus, which of each site's rasters the person switched on (held for the session, never
 * saved), and the kit-pyramid indexes read for them (forgotten when the Globe closes).
 *
 * The file is not called `siteOutputs.ts`: next to `SiteOutputs.tsx`, an import of
 * `./SiteOutputs` would find it on a case-insensitive disk (Windows).
 */
import { defaultShown, parsePyramid, type PyramidIndex } from '@aio/globe';
import type { DateShift, GlobeRaster, GlobeSite, ProjectManifest } from '@aio/schema';
import { layerDateShifts } from '@aio/workspace';
import { create } from 'zustand';

/** At most two sites in focus: the open project, then the picked site when it is another one. */
export function focusSites(openId: string | null, pickedId: string | null): string[] {
  const out: string[] = [];
  if (openId !== null) out.push(openId);
  if (pickedId !== null && pickedId !== openId) out.push(pickedId);
  return out;
}

/** What a site needs for its switches. */
export type SwitchSite = Pick<GlobeSite, 'projectId' | 'captures' | 'rasters'>;

/** The key of a pyramid index in `indexes` and the cache. */
export const pyramidKey = (projectId: string, src: string): string => `${projectId}\n${src}`;

/**
 * The rasters a site in focus draws: each with its index (one not read yet is left out) and the
 * date shift of its layer, so a lined-up date is drawn at its corrected place. `rasters` come in
 * draw order. Only the open project has a manifest to take the shifts from; another site is
 * drawn where its files are.
 */
export function outputRasters(
  projectId: string,
  rasters: readonly GlobeRaster[],
  indexes: Readonly<Record<string, PyramidIndex | null | undefined>>,
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'> | null,
): { layerId: string; src: string; index: PyramidIndex; shift?: DateShift }[] {
  const shifts = manifest ? layerDateShifts(manifest) : {};
  return rasters.flatMap((r) => {
    const index = indexes[pyramidKey(projectId, r.src)];
    if (!index) return [];
    const shift = shifts[r.layerId];
    return [{ layerId: r.layerId, src: r.src, index, ...(shift ? { shift } : {}) }];
  });
}

export interface SiteOutputsState {
  /** Shown layer ids per project; undefined means the site's defaults (`defaultShown`). */
  shown: Record<string, string[] | undefined>;
  /**
   * Flip one raster of a site: the defaults are copied first, so the first touch keeps what the
   * site showed and changes only this one.
   */
  toggle(site: SwitchSite, layerId: string): void;
  /** Read indexes by `pyramidKey`: the index, or null when it could not be read. */
  indexes: Record<string, PyramidIndex | null>;
}

export const useSiteOutputs = create<SiteOutputsState>()((set) => ({
  shown: {},
  indexes: {},
  toggle: (site, layerId) => {
    set((s) => {
      const now = shownOf(s.shown, site);
      const next = now.includes(layerId) ? now.filter((id) => id !== layerId) : [...now, layerId];
      return { shown: { ...s.shown, [site.projectId]: next } };
    });
  },
}));

/** The layer ids a site shows now. */
export function shownOf(shown: SiteOutputsState['shown'], site: SwitchSite): string[] {
  return shown[site.projectId] ?? defaultShown(site);
}

const cache = new Map<string, Promise<PyramidIndex | null>>();

const projectFile = (projectId: string, path: string): string =>
  `aio://project/${encodeURIComponent(projectId)}/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Read a raster's `tiles.json` over `aio://project/...`, once per project and source while the
 * Globe is open. Null when it is missing, unreadable or not a kit pyramid: never throws.
 */
export function loadPyramid(projectId: string, src: string): Promise<PyramidIndex | null> {
  const key = pyramidKey(projectId, src);
  const known = cache.get(key);
  if (known) return known;
  const read = (async (): Promise<PyramidIndex | null> => {
    try {
      const res = await fetch(projectFile(projectId, src));
      if (!res.ok) return null;
      return parsePyramid((await res.json()) as unknown);
    } catch {
      return null;
    }
  })().then((index) => {
    // a read that lands after the Globe closed is dropped
    if (cache.get(key) === read)
      useSiteOutputs.setState((s) => ({ indexes: { ...s.indexes, [key]: index } }));
    return index;
  });
  cache.set(key, read);
  return read;
}

/** Forget every index (the Globe closed): the next visit reads them again. */
export function clearPyramids(): void {
  cache.clear();
  useSiteOutputs.setState({ indexes: {} });
}
