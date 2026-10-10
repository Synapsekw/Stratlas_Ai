/**
 * M10 G7 in the site view and on the map, mounted by the stage with one hook (`useSiteTiles`):
 *
 * - the project's 3D Tiles (`tilesets.json`, `tilesets:list`) streamed in the 3D stage through
 *   `@aio/tiles` (3DTilesRendererJS), with the graphics tier's budget, reloaded when a `tiles.*`
 *   job finishes;
 * - terrain and imagery around the site (Settings, Map packs: off by default, offered from the
 *   Medium tier up), built from the installed packs;
 * - the Satellite basemap: the installed imagery packs under the streets on the project's maps,
 *   and the terrain packs as a hillshade (on by default when there are packs). The map type
 *   picker on the map, the Settings checkboxes and the command palette all write the choices
 *   here; `basemap.ts` says what they mean for a site;
 * - online satellite (Sentinel-2, off by default) under the packs, when the person switched it on.
 *
 * The choices are remembered on this computer; terrain and imagery around the site are also
 * written to the Globe settings (`GlobeSettings.aroundSite`) once that channel is built (G6).
 */
import type { EngineStage } from '@aio/engine';
import {
  installRasterProtocol,
  setStreetOverlay,
  syncRasterPacks,
  type MapController,
} from '@aio/maps';
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
import { assetUrl, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useGraphics } from '../graphics';
import { TILESET_WRITERS } from '../jobs';
import {
  basemapModel,
  groundModel,
  siteLonLat,
  type BasemapDraw,
  type BasemapModel,
  type GroundModel,
} from './basemap';

const KEY = 'stratlas.rasterPacks';

export interface RasterPrefs {
  /** Imagery packs under the streets on the map. */
  satellite: boolean;
  /** Terrain packs as a hillshade on the map. */
  hillshade: boolean;
  /** Streets and names over the imagery on the map (off: Satellite only). */
  streets: boolean;
  /** The one imagery pack the map draws, or null for the best available. */
  imageryPack: string | null;
  /** Terrain and imagery around the site in 3D. */
  aroundTerrain: boolean;
  aroundImagery: boolean;
  /**
   * Online satellite (Sentinel-2) at the bottom of the map's satellite stack. Main holds and
   * enforces the switch (userData `online.json`, ADR 0007 amended 10 Oct 2026); this copy says
   * what to draw and follows main on every refresh. Change it with `setOnlineSatellite`, which
   * asks main first.
   */
  onlineSatellite: boolean;
}

const DEFAULTS: RasterPrefs = {
  satellite: true,
  hillshade: true,
  streets: true,
  imageryPack: null,
  aroundTerrain: false,
  aroundImagery: false,
  onlineSatellite: false,
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
    type Flag = Exclude<keyof RasterPrefs, 'imageryPack'>;
    const pick = (k: Flag) => (typeof v[k] === 'boolean' ? v[k] : DEFAULTS[k]);
    return {
      satellite: pick('satellite'),
      hillshade: pick('hillshade'),
      streets: pick('streets'),
      imageryPack: typeof v.imageryPack === 'string' && v.imageryPack ? v.imageryPack : null,
      aroundTerrain: pick('aroundTerrain'),
      aroundImagery: pick('aroundImagery'),
      // main says (the first refresh): until then nothing online is drawn or asked for
      onlineSatellite: false,
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
  /**
   * Switch online satellite on or off: main first (it refuses every tile until its switch is on),
   * then the layer. Answers an error message, or null when it is done.
   */
  setOnlineSatellite(on: boolean): Promise<string | null>;
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
  async setOnlineSatellite(on) {
    const bridge = aio();
    if (!bridge) return 'Settings are not available.';
    try {
      const r = await bridge.invoke('onlineTiles:setSatellite', { on });
      if (!r.ok) return r.error;
      get().set({ onlineSatellite: r.satellite });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
  refresh() {
    const bridge = aio();
    if (!bridge) return;
    void Promise.all([
      bridge.invoke('imageryPacks:list', {}).catch(() => null),
      bridge.invoke('terrainPacks:list', {}).catch(() => null),
      bridge.invoke('onlineTiles:status', {}).catch(() => null),
    ]).then(([i, t, status]) => {
      const cur = get();
      set({
        imagery: unchanged(cur.imagery, i?.ok ? i.packs : []),
        terrain: unchanged(cur.terrain, t?.ok ? t.packs : []),
        rev: cur.rev + 1,
      });
      // main decides whether online satellite is on; the layer follows it
      const online = status?.satellite === true;
      if (status && online !== get().prefs.onlineSatellite) get().set({ onlineSatellite: online });
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

/** Where the open project is on the Earth as a stable value ("lon,lat"), or null. */
function useSiteKey(): string | null {
  return useWorkspace((s) => siteLonLat(s.project?.manifest ?? null)?.join(',') ?? null);
}

function siteOf(key: string | null): readonly [number, number] | null {
  if (key === null) return null;
  const [lon, lat] = key.split(',').map(Number);
  return lon !== undefined && lat !== undefined ? [lon, lat] : null;
}

/**
 * The basemap of the open project's maps: what is chosen, what can be chosen and what the map
 * draws. The same object until a choice, the packs or the project change.
 */
export function useBasemap(): BasemapModel {
  const prefs = useRasterPacks((s) => s.prefs);
  const imagery = useRasterPacks((s) => s.imagery);
  const terrain = useRasterPacks((s) => s.terrain);
  const site = useSiteKey();
  return useMemo(
    () => basemapModel(prefs, imagery, terrain, siteOf(site)),
    [prefs, imagery, terrain, site],
  );
}

/** What the 3D view can draw around the open project's site. */
export function useGround(): GroundModel {
  const tier = useGraphics((s) => s.tier);
  const imagery = useRasterPacks((s) => s.imagery);
  const terrain = useRasterPacks((s) => s.terrain);
  const site = useSiteKey();
  const offered = tilesBudget(tier).surroundings;
  return useMemo(
    () => groundModel(imagery, terrain, siteOf(site), offered),
    [imagery, terrain, site, offered],
  );
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

/** Maps whose streets over the imagery are hidden (Satellite only). */
const streetsHidden = new WeakSet<object>();

/**
 * Keep a map's basemap at `draw`: the imagery packs, the hillshade and the streets over them.
 * Only what differs is touched (`syncRasterPacks`), so switching the map type never empties the
 * map and never moves its camera, and a pack that stays on screen keeps the tiles it has drawn.
 */
export function useSatelliteMap(map: MapController | null, draw: BasemapDraw): void {
  // a map that has had packs on it: turning everything off must then take them away again
  const touched = useRef<MapController | null>(null);
  useEffect(() => {
    if (!map) return;
    const plain = !draw.satellite && !draw.hillshade && draw.streets && !draw.online;
    if (plain && touched.current !== map) return;
    touched.current = map;
    let live = true;
    let done = false;
    const ml = map.map;
    // Apply once the style takes sources (MapLibre refuses while it loads), and again after a
    // new style replaced them.
    const attempt = () => {
      if (!live || done) return;
      try {
        syncRasterPacks(ml, draw);
        // the streets are shown until hidden: only a map that hid them is told to show them
        if (!draw.streets || streetsHidden.has(ml)) {
          setStreetOverlay(ml, draw.streets);
          if (draw.streets) streetsHidden.delete(ml);
          else streetsHidden.add(ml);
        }
      } catch {
        return; // not ready yet: the next style event tries again
      }
      done = true;
      ml.off('styledata', attempt);
    };
    const apply = () => {
      done = false;
      ml.on('styledata', attempt);
      attempt();
    };
    const restyled = () => {
      streetsHidden.delete(ml);
      apply();
    };
    void installRasterProtocol().then(() => {
      if (!live) return;
      ml.on('style.load', restyled);
      apply();
    });
    return () => {
      live = false;
      ml.off('styledata', attempt);
      ml.off('style.load', restyled);
    };
  }, [map, draw]);
}

/** Everything G7 adds to the site view and its maps (the main one, a second when comparing). */
export function useSiteTiles(
  stage: EngineStage | null,
  project: Project,
  map: MapController | null,
  second: MapController | null = null,
): void {
  const rev = useRasterPacks((s) => s.rev);
  useEffect(() => {
    listenForJobs();
    rasterPacks.getState().refresh();
  }, []);
  useSiteTilesets(stage, project, rev);
  useSiteSurroundings(stage, project);
  const { draw } = useBasemap();
  useSatelliteMap(map, draw);
  useSatelliteMap(second, draw);
}
