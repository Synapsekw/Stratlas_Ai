/**
 * M10 G7 in the site view and on the map, mounted by the stage with one hook (`useSiteTiles`):
 *
 * - the project's 3D Tiles (`tilesets.json`, `tilesets:list`) streamed in the 3D stage through
 *   `@aio/tiles` (3DTilesRendererJS), with the graphics tier's budget, reloaded when a `tiles.*`
 *   job finishes;
 * - terrain and imagery around the site (Settings, Map packs: off by default, offered from the
 *   Medium tier up), built from the installed packs;
 * - the Satellite basemap: the installed imagery packs under the streets on the main map, and the
 *   terrain packs as a hillshade (on by default when there are packs).
 *
 * The choices are remembered on this computer; terrain and imagery around the site are also
 * written to the Globe settings (`GlobeSettings.aroundSite`) once that channel is built (G6).
 */
import type { EngineStage } from '@aio/engine';
import { applyRasterPacks, installRasterProtocol, type MapController } from '@aio/maps';
import type { AioBridge, ProjectManifest, RasterPackInfo, TilesetEntry } from '@aio/schema';
import {
  attachTileset,
  buildSurroundings,
  createRasterTileSource,
  siteFrame,
  tilesBudget,
  tilesetsToLoad,
  type TilesetHandle,
} from '@aio/tiles';
import { assetUrl } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useGraphics } from '../graphics';
import { TILESET_WRITERS } from '../jobs';

const KEY = 'stratlas.rasterPacks';

export interface RasterPrefs {
  /** Imagery packs under the streets on the map. */
  satellite: boolean;
  /** Terrain packs as a hillshade on the map. */
  hillshade: boolean;
  /** Terrain and imagery around the site in 3D. */
  aroundTerrain: boolean;
  aroundImagery: boolean;
}

const DEFAULTS: RasterPrefs = {
  satellite: true,
  hillshade: true,
  aroundTerrain: false,
  aroundImagery: false,
};

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readPrefs(): RasterPrefs {
  try {
    const v = JSON.parse(storage()?.getItem(KEY) ?? '{}') as Partial<
      Record<keyof RasterPrefs, unknown>
    >;
    const pick = (k: keyof RasterPrefs) => (typeof v[k] === 'boolean' ? v[k] : DEFAULTS[k]);
    return {
      satellite: pick('satellite'),
      hillshade: pick('hillshade'),
      aroundTerrain: pick('aroundTerrain'),
      aroundImagery: pick('aroundImagery'),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function aio(): AioBridge | undefined {
  return (globalThis as { aio?: AioBridge }).aio;
}

interface RasterState {
  prefs: RasterPrefs;
  imagery: RasterPackInfo[];
  terrain: RasterPackInfo[];
  /** Bumped when packs or tilesets may have changed (a pack or tiles job finished). */
  rev: number;
  set(patch: Partial<RasterPrefs>): void;
  refresh(): void;
}

export const rasterPacks = createStore<RasterState>()((set, get) => ({
  prefs: readPrefs(),
  imagery: [],
  terrain: [],
  rev: 0,
  set(patch) {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    try {
      storage()?.setItem(KEY, JSON.stringify(prefs));
    } catch {
      // blocked storage: the choice lasts for this session
    }
    if ('aroundTerrain' in patch || 'aroundImagery' in patch) void saveAroundSite(prefs);
  },
  refresh() {
    const bridge = aio();
    if (!bridge) return;
    void Promise.all([
      bridge.invoke('imageryPacks:list', {}).catch(() => null),
      bridge.invoke('terrainPacks:list', {}).catch(() => null),
    ]).then(([i, t]) => {
      const cur = get();
      set({
        imagery: unchanged(cur.imagery, i?.ok ? i.packs : []),
        terrain: unchanged(cur.terrain, t?.ok ? t.packs : []),
        rev: cur.rev + 1,
      });
    });
  },
}));

/**
 * The listed packs, keeping the current array when nothing changed: the map and the 3D
 * surroundings rebuild on a new array, and a refresh (opening a project, any finished tiles job)
 * would otherwise remove the Satellite layers and add them again, blanking the imagery while the
 * new source loads.
 */
export function unchanged(cur: RasterPackInfo[], next: RasterPackInfo[]): RasterPackInfo[] {
  return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
}

async function saveAroundSite(p: RasterPrefs): Promise<void> {
  const bridge = aio();
  if (!bridge) return;
  try {
    const cur = await bridge.invoke('globe:getSettings', {});
    if (!cur.ok) return;
    await bridge.invoke('globe:setSettings', {
      settings: {
        ...cur.settings,
        aroundSite: { terrain: p.aroundTerrain, imagery: p.aroundImagery },
      },
    });
  } catch {
    // the Globe settings are not built in this version: the local choice stands
  }
}

export function useRasterPacks<T>(selector: (s: RasterState) => T): T {
  return useStore(rasterPacks, selector);
}

let listening = false;
/** Refresh packs and tilesets when a pack or tiles job finishes (once per window). */
export function listenForJobs(): void {
  const bridge = aio();
  if (listening || !bridge) return;
  listening = true;
  bridge.on('jobs:event', (e) => {
    if (e.type !== 'update' || e.job.status !== 'done') return;
    const p = e.job.pipeline;
    if (p.startsWith('packs.') || TILESET_WRITERS.has(p)) rasterPacks.getState().refresh();
  });
}

type Project = { id: string; manifest: ProjectManifest } | null;

/** The project's visible tilesets in the 3D stage. */
export function useSiteTilesets(stage: EngineStage | null, project: Project, rev: number): void {
  const tier = useGraphics((s) => s.tier);
  const [listed, setListed] = useState<{ projectId: string; entries: TilesetEntry[] } | null>(null);
  const projectId = project?.id ?? null;
  const manifest = project?.manifest ?? null;
  const entries = listed?.projectId === projectId ? listed.entries : null;

  useEffect(() => {
    const bridge = aio();
    if (!projectId || !bridge) return;
    let live = true;
    bridge.invoke('tilesets:list', { projectId }).then(
      (r) => {
        if (!live) return;
        if (r.ok) setListed({ projectId, entries: tilesetsToLoad(r.file) });
        else console.warn('3D Tiles not listed:', r.error);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectId, rev]);

  const handles = useRef<TilesetHandle[]>([]);
  const tierNow = useRef(tier);
  useEffect(() => {
    tierNow.current = tier;
    // a new tier changes the budget of the tilesets on screen, without reloading them
    for (const h of handles.current) h.setBudget(tilesBudget(tier));
  }, [tier]);

  useEffect(() => {
    if (!stage || !projectId || !manifest || !entries?.length) return;
    const frame = siteFrame(manifest);
    const made: TilesetHandle[] = [];
    for (const entry of entries) {
      try {
        made.push(
          attachTileset(stage, {
            url: assetUrl(projectId, { path: entry.src }),
            entry,
            frame,
            budget: tilesBudget(tierNow.current),
          }),
        );
      } catch (e) {
        console.warn(`Tileset ${entry.id} not shown`, e);
      }
    }
    handles.current = made;
    return () => {
      for (const h of made) h.dispose();
      handles.current = [];
    };
  }, [stage, projectId, manifest, entries]);
}

/** Terrain and imagery around the site in 3D, when chosen and the tier offers it. */
export function useSiteSurroundings(stage: EngineStage | null, project: Project): void {
  const tier = useGraphics((s) => s.tier);
  const prefs = useRasterPacks((s) => s.prefs);
  const imagery = useRasterPacks((s) => s.imagery);
  const terrain = useRasterPacks((s) => s.terrain);
  const manifest = project?.manifest ?? null;
  const offered = tilesBudget(tier).surroundings;
  const wantTerrain = offered && prefs.aroundTerrain && terrain.length > 0;
  const wantImagery = offered && prefs.aroundImagery && imagery.length > 0;

  useEffect(() => {
    if (!stage || !manifest || (!wantTerrain && !wantImagery)) return;
    const frame = siteFrame(manifest);
    if (!frame) return;
    const abort = new AbortController();
    let mesh: Awaited<ReturnType<typeof buildSurroundings>> = null;
    void buildSurroundings({
      frame,
      terrain: wantTerrain ? createRasterTileSource('terrain', terrain) : null,
      imagery: wantImagery ? createRasterTileSource('imagery', imagery) : null,
      signal: abort.signal,
    }).then(
      (m) => {
        if (abort.signal.aborted || !m) {
          m?.geometry.dispose();
          return;
        }
        mesh = m;
        stage.scene.add(m);
        stage.requestRender();
      },
      (e: unknown) => {
        console.warn('Terrain around the site not drawn', e);
      },
    );
    return () => {
      abort.abort();
      if (mesh) {
        stage.scene.remove(mesh);
        mesh.geometry.dispose();
        const mat = mesh.material as { map?: { dispose(): void } | null; dispose(): void };
        mat.map?.dispose();
        mat.dispose();
        stage.requestRender();
      }
    };
  }, [stage, manifest, wantTerrain, wantImagery, imagery, terrain]);
}

/** The Satellite basemap and hillshade on a map. */
export function useSatelliteMap(map: MapController | null): void {
  const prefs = useRasterPacks((s) => s.prefs);
  const imagery = useRasterPacks((s) => s.imagery);
  const terrain = useRasterPacks((s) => s.terrain);
  useEffect(() => {
    if (!map) return;
    const satellite = prefs.satellite && imagery.length > 0;
    const hillshade = prefs.hillshade && terrain.length > 0;
    if (!satellite && !hillshade) return;
    let off: (() => void) | null = null;
    let live = true;
    const ml = map.map;
    // Add the packs once the style takes sources (MapLibre refuses while it loads), and again
    // after a new style replaced them.
    const attempt = () => {
      if (!live || off) return;
      try {
        off = applyRasterPacks(ml, { imagery, terrain, satellite, hillshade });
      } catch {
        return; // not ready yet: the next style event tries again
      }
      ml.off('styledata', attempt);
    };
    const restyled = () => {
      off = null;
      ml.on('styledata', attempt);
      attempt();
    };
    void installRasterProtocol().then(() => {
      if (!live) return;
      ml.on('style.load', restyled);
      restyled();
    });
    return () => {
      live = false;
      ml.off('styledata', attempt);
      ml.off('style.load', restyled);
      try {
        off?.();
      } catch {
        // the map is already gone
      }
    };
  }, [map, prefs.satellite, prefs.hillshade, imagery, terrain]);
}

/** Everything G7 adds to the site view and its main map. */
export function useSiteTiles(
  stage: EngineStage | null,
  project: Project,
  map: MapController | null,
): void {
  const rev = useRasterPacks((s) => s.rev);
  useEffect(() => {
    listenForJobs();
    rasterPacks.getState().refresh();
  }, []);
  useSiteTilesets(stage, project, rev);
  useSiteSurroundings(stage, project);
  useSatelliteMap(map);
}
