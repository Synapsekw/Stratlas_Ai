/**
 * The Map menu of the Map view and of the 3D scene (plan 2026-10-14-satellite-providers): the
 * shared `MapMenu` over each view's own choices in `rasterPacks` (`siteTiles.ts`). The stage shows
 * one chip, never one per pane (D30): the Map view's while a map shows, else the 3D scene's, which
 * took over the ground rows the stage's Layers popover once had. It stands in a corner slot of the
 * stage (`overlaySlots.ts`). An online source used for the first time asks first, in the menu
 * (`pickBase`, `OnlineSatelliteNotice`).
 */
import { ONLINE_SOURCES, type AioBridge } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { MapMenu } from '../maps/MapMenu';
import { mapMenuModel, type MapMenuModel, type OnTopKey } from '../maps/mapMenuModel';
import { shell, useShell } from '../shell';
import { siteLonLat } from './basemap';
import { pickBase } from './onlineSatellite';
import { OnlineSatelliteNotice } from './OnlineSatelliteNotice';
import { rasterPacks, useBasemap, useGround, useRasterPacks, type RasterPrefs } from './siteTiles';
import './mapMenus.css';

const openSources = () => {
  shell.getState().openSettingsPage('map-sources');
};

/** Mapbox's "Improve this map" page; main opens it, so the renderer names no provider host. */
const improveMap = () => {
  const bridge = (globalThis as { aio?: AioBridge }).aio;
  void bridge?.invoke('onlineTiles:openFeedback', { provider: 'mapbox' }).catch(() => undefined);
};

/** The Map view's On top switches and the choices they write. */
const MAP_TOGGLES: Partial<Record<OnTopKey, keyof RasterPrefs>> = {
  streets: 'streets',
  hillshade: 'hillshade',
  packs: 'satellite',
};
const SCENE_TOGGLES: Partial<Record<OnTopKey, keyof RasterPrefs>> = {
  aroundImagery: 'aroundImagery',
  aroundTerrain: 'aroundTerrain',
};

const toggle =
  (table: Partial<Record<OnTopKey, keyof RasterPrefs>>) => (key: OnTopKey, on: boolean) => {
    const pref = table[key];
    if (pref) rasterPacks.getState().set({ [pref]: on });
  };

export function useMapViewMenuModel(): MapMenuModel {
  const basemap = useBasemap();
  const prefs = useRasterPacks((s) => s.prefs);
  const keys = useRasterPacks((s) => s.online.keys);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  return useMemo(
    () =>
      mapMenuModel(
        'map',
        {
          base: basemap.base,
          onTop: { streets: prefs.streets, hillshade: prefs.hillshade, packs: prefs.satellite },
          pack: prefs.imageryPack,
        },
        ONLINE_SOURCES,
        {
          imagery: basemap.packs.map((p) => ({ id: p.id, label: p.label })),
          terrain: basemap.hillshade ? 1 : 0,
        },
        { enabled: prefs.onlineSatellite, offlineOnly },
        keys,
      ),
    [basemap, prefs, keys, offlineOnly],
  );
}

export function MapViewMenu() {
  const model = useMapViewMenuModel();
  return (
    <MapMenu
      model={model}
      testIds={{ chip: 'basemap-button', pop: 'basemap-pop' }}
      className="stage-basemap"
      place="stage"
      dark
      onPick={(id) => {
        pickBase(id, (b) => {
          rasterPacks.getState().set({ mapBase: b });
        });
      }}
      onToggle={toggle(MAP_TOGGLES)}
      onPack={(id) => {
        rasterPacks.getState().set({ imageryPack: id });
      }}
      onOpenSources={openSources}
      onImproveMap={improveMap}
      notice={<OnlineSatelliteNotice className="mm-notice" />}
    />
  );
}

export function useSceneMenuModel(): MapMenuModel | null {
  const basemap = useBasemap();
  const ground = useGround();
  const prefs = useRasterPacks((s) => s.prefs);
  const keys = useRasterPacks((s) => s.online.keys);
  const offlineOnly = useShell((s) => s.settings.offlineOnly === true);
  const placed = useWorkspace((s) => siteLonLat(s.project?.manifest ?? null) !== null);
  return useMemo(
    () =>
      placed
        ? mapMenuModel(
            'scene',
            {
              base: prefs.sceneBase ?? 'streets',
              onTop: { aroundImagery: prefs.aroundImagery, aroundTerrain: prefs.aroundTerrain },
              pack: null,
            },
            ONLINE_SOURCES,
            {
              imagery: basemap.packs.map((p) => ({ id: p.id, label: p.label })),
              terrain: ground.terrain ? 1 : 0,
            },
            { enabled: prefs.onlineSatellite, offlineOnly },
            keys,
            { aroundOffered: ground.offered },
          )
        : null,
    [placed, basemap, ground, prefs, keys, offlineOnly],
  );
}

export function SceneMapMenu() {
  const model = useSceneMenuModel();
  if (!model) return null;
  return (
    <MapMenu
      model={model}
      testIds={{ chip: 'scene-map-button', pop: 'scene-map-pop' }}
      className="stage-basemap"
      place="stage"
      dark
      onPick={(id) => {
        pickBase(id, (b) => {
          rasterPacks.getState().set({ sceneBase: b });
        });
      }}
      onToggle={toggle(SCENE_TOGGLES)}
      onPack={() => undefined}
      onOpenSources={openSources}
      onImproveMap={improveMap}
      notice={<OnlineSatelliteNotice className="mm-notice" />}
    />
  );
}

/**
 * Which view's Map menu the stage shows (D30): the Map view's while a map shows (in a split too),
 * else the 3D scene's for a site placed on the map; null: none.
 */
export function useStageBasemap(show3d: boolean, showMap: boolean): 'map' | 'scene' | null {
  const placed = useWorkspace((s) => siteLonLat(s.project?.manifest ?? null) !== null);
  if (showMap) return 'map';
  return show3d && placed ? 'scene' : null;
}

/** The stage's one Map menu chip, for the view `useStageBasemap` picked. */
export function StageBasemapChip({ view }: { view: 'map' | 'scene' }) {
  return view === 'map' ? <MapViewMenu /> : <SceneMapMenu />;
}
