import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import {
  frameProjection,
  mediaPinData,
  removeMediaPins,
  setMapPanoOpenHandler,
  setMediaPins,
  type MapPin,
} from '@aio/maps';
import type { ProjectManifest } from '@aio/schema';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo } from 'react';
import { useMap } from '../builder/activeViews';
import { shell } from '../shell';
import type { SplitPref } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import { drawnPins, keyString } from './pinModel';

/*
 * Photos and 360s on the map: a 360 clicked on the map is entered in the 3D view (put beside the
 * map when no 3D view is on screen), and pinned items with a heading show an arrow on the map.
 * The marker plates and the photo click are the map's own (`@aio/maps` mediaMarkers).
 */

type MapLibreMap = Parameters<typeof setMediaPins>[0];
type ArrowData = Parameters<typeof setMediaPins>[1];

/** How long a 3D view that is only now opening may take to load the 360's layer. */
const WAIT_MS = 20_000;

/** Whether a 3D view is on the stage now. */
export function threeDOnScreen(): boolean {
  const sh = shell.getState();
  if (sh.stageMode === '3d') return true;
  if (sh.stageMode !== 'split') return false;
  const id = workspace.getState().project?.id;
  const split = id ? stagePrefs.getState().byProject[id]?.split : undefined;
  // a split never set up shows the 3D view beside the map
  return split ? split.left === '3d' || split.right === '3d' : true;
}

let pending: (() => void) | null = null;

/** Call `go` once a 3D view shows the panoramas layer `layerId` (or give up after a while). */
function whenPanoLayer(layerId: string, go: () => void): void {
  pending?.();
  let offFrame: (() => void) | null = null;
  const ready = (s: SceneHandle) => s.scene.getObjectByName(`panoramas:${layerId}`) !== undefined;
  const finish = () => {
    stop();
    go();
  };
  const watch = (s: SceneHandle | null) => {
    offFrame?.();
    offFrame = null;
    if (!s) return;
    if (ready(s)) {
      finish();
      return;
    }
    offFrame = s.onFrame(() => {
      if (ready(s)) finish();
    });
    s.requestRender();
  };
  const offScene = onActiveScene(watch);
  const timer = setTimeout(() => {
    stop();
  }, WAIT_MS);
  const stop = () => {
    offScene();
    offFrame?.();
    offFrame = null;
    clearTimeout(timer);
    if (pending === stop) pending = null;
  };
  pending = stop;
  watch(getActiveScene());
}

/**
 * Enter 360 `id` of `layerId` from the map: in the 3D view on screen, else in a 3D view put
 * beside the map (the map on the left, as a photo opened from the map), once it has the layer.
 */
export function openPanoFromMap(layerId: string, id: string): void {
  const w = workspace.getState();
  w.setLayerVisible(layerId, true);
  if (threeDOnScreen()) {
    w.openPano(layerId, id);
    return;
  }
  const project = w.project;
  if (!project) return;
  const saved: SplitPref = stagePrefs.getState().byProject[project.id]?.split ?? {
    left: '3d',
    right: 'map',
  };
  stagePrefs.getState().update(project.id, { split: { ...saved, left: 'map', right: '3d' } });
  const sh = shell.getState();
  if (sh.stageMode !== 'split') sh.setStageMode('split');
  if (sh.screen !== 'scene') sh.go('scene');
  w.select({ kind: 'pano', id, layer: layerId });
  whenPanoLayer(layerId, () => {
    workspace.getState().openPano(layerId, id);
  });
}

/** The pins of the shown layers that have a heading, as map arrows. */
export function arrowPins(manifest: ProjectManifest, hidden: ReadonlySet<string>): MapPin[] {
  return drawnPins(manifest, hidden).flatMap((p) =>
    p.headingDeg === undefined
      ? []
      : [{ id: keyString(p.key), kind: p.key.kind, ground: p.ground, headingDeg: p.headingDeg }],
  );
}

/**
 * Draw these arrows on the map now, or once it is idle when its style is busy (sources reloading
 * after a save: 'load' has long fired). Returns a function that stops a waiting draw.
 */
export function showPinArrows(map: MapLibreMap, data: ArrowData): () => void {
  let live = true;
  const draw = () => {
    if (!live) return;
    if (!map.isStyleLoaded()) {
      map.once('idle', draw);
      return;
    }
    setMediaPins(map, data);
  };
  draw();
  return () => {
    live = false;
    map.off('idle', draw);
  };
}

export function PinMapMount(): null {
  // a store read, not a state set in an effect: a map that comes up with this mount is seen
  const ctl = useMap();
  const manifest = useWorkspace((s) => s.project?.manifest);
  const hiddenMap = useWorkspace((s) => s.hidden);
  const hidden = useMemo(() => new Set(Object.keys(hiddenMap)), [hiddenMap]);

  useEffect(() => {
    setMapPanoOpenHandler(openPanoFromMap);
    return () => {
      setMapPanoOpenHandler(null);
      pending?.();
    };
  }, []);

  useEffect(() => {
    const map = ctl?.map;
    if (!map || !manifest) return;
    const proj = frameProjection(manifest.crs, manifest.origin);
    if (!proj) return;
    return showPinArrows(
      map,
      mediaPinData(arrowPins(manifest, hidden), (g) => proj.toLonLat(g)),
    );
  }, [ctl, manifest, hidden]);

  useEffect(() => {
    const map = ctl?.map;
    if (!map) return;
    return () => {
      // the map may be gone already (its controller disposed first)
      try {
        removeMediaPins(map);
      } catch {
        /* removed with the map */
      }
    };
  }, [ctl]);

  return null;
}
