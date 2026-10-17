import { getActiveScene } from '@aio/engine';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import { LayerPatch, type PanoRef, type PhotoRef, type Vec3 } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { Intersection } from 'three';
import { groundHit } from '../builder/droneHits';
import { hitLayer, terrainHeightAt, useStagePick } from '../builder/pick';
import { builder } from '../builder/state';
import { isTyping } from '../keys';
import { setPanoPick } from '../workspace/panoPickHook';
import { openPanoBeside } from './openBeside';
import { createPinStore, type PinActions, type PinState, type PinStep } from './pinStore';

/*
 * The placing session wired to the app (pinned media design): the one pin store, saving through
 * the builder, and the clicks it asks for: the 3D view and the map while the step wants a point
 * on the site, the Panoramas pane while a line-up wants a landmark in the 360.
 */

export type PinSession = StoreApi<PinState & PinActions>;

/** The placing session of the app. */
export const pinSession: PinSession = createPinStore({
  manifest: () => workspace.getState().project?.manifest ?? null,
  save: async (layerId, patch) => {
    const parsed = LayerPatch.safeParse(patch);
    if (!parsed.success) return t('pin.strip.invalid');
    return builder.getState().saveLayers([layerId], parsed.data);
  },
  openPanoBeside: (layerId, panoId) => {
    openPanoBeside(layerId, panoId);
  },
});

export function usePinSession<T>(selector: (s: PinState & PinActions) => T, store = pinSession): T {
  return useStore(store, selector);
}

/** Steps that take a click on the site (the 3D view or the map). */
const SITE_STEPS: readonly PinStep[] = ['pick', 'scene', 'aim'];
/** Steps that take a landmark click in the 360. */
const PANO_STEPS: readonly PinStep[] = ['pano', 'scene', 'more'];

/** The name a photo or 360 goes by on the strip: its name, else its file name, else its id. */
export function mediaName(item: PhotoRef | PanoRef): string {
  if ('name' in item && item.name) return item.name;
  const path = 'path' in item.src ? item.src.path : '';
  const base = path.split(/[\\/]/).pop() ?? '';
  return base === '' ? item.id : base;
}

/** A point on the site for the step the session is at; resolves once it is handled. */
function sitePoint(store: PinSession, p: Vec3, heightKnown: boolean): Promise<void> {
  const s = store.getState();
  if (s.step === 'pick') return s.pickSurface(p, heightKnown);
  if (s.step === 'scene') return s.pickLandmark(p);
  if (s.step === 'aim') return s.aim(p);
  return Promise.resolve();
}

/** A 3D click: a hit on a layer's surface has its height; the bare ground plane has none. */
function sceneClick(store: PinSession, hit: Intersection | null, x: number, y: number): void {
  if (hit) {
    void sitePoint(store, [hit.point.x, hit.point.y, hit.point.z], hitLayer(hit) !== null);
    return;
  }
  const h = getActiveScene();
  const pane = document.querySelector<HTMLElement>('.pane-3d');
  const p = h && pane ? groundHit(h, pane, x, y) : null;
  if (p) void sitePoint(store, p, false);
}

/** A map click: the map has no height, so the model under the point gives it when there is one. */
function mapClick(store: PinSession, local: Vec3): Promise<void> {
  const y = terrainHeightAt(local[0], local[2]);
  return sitePoint(store, [local[0], y ?? 0, local[2]], y !== null);
}

/**
 * Arms the clicks the session's step asks for: the 3D view and the active map while it wants a
 * point on the site (re-armed after every map click), the Panoramas pane while it wants a
 * landmark in the 360 being lined up. Escape cancels the session.
 */
export function usePinPicking(store: PinSession = pinSession): void {
  const target = useStore(store, (s) => s.target);
  const step = useStore(store, (s) => s.step);
  const onSite = target !== null && SITE_STEPS.includes(step);
  const onPano = target?.kind === 'pano' && PANO_STEPS.includes(step);
  const [map, setMap] = useState<MapController | null>(() => getActiveMap());
  useEffect(() => onActiveMap(setMap), []);

  useStagePick(onSite, (hit, c) => {
    sceneClick(store, hit, c.x, c.y);
  });

  useEffect(() => {
    if (!onSite || !map) return;
    let off: (() => void) | null = null;
    // the pick re-arms at once (the map's pick is one-shot), so a click while the last one is
    // still being handled (its save running) is dropped
    let handling = false;
    const arm = (): void => {
      off = map.pickPoint(
        (local) => {
          arm();
          if (handling) return;
          handling = true;
          void mapClick(store, local).finally(() => {
            handling = false;
          });
        },
        () => {
          store.getState().cancel();
        },
      );
    };
    arm();
    return () => {
      off?.();
    };
    // the step is a dependency so a pick that leaves the step disarms and the next re-arms
  }, [onSite, map, store, step]);

  useEffect(() => {
    if (!onPano) return;
    const { layerId, itemId } = target;
    const pick = (p: { layerId: string; panoId: string; offsetDeg: number }): void => {
      if (p.layerId === layerId && p.panoId === itemId) store.getState().pickPano(p.offsetDeg);
    };
    setPanoPick(pick);
    return () => {
      setPanoPick(null);
    };
  }, [onPano, target, store]);

  useEffect(() => {
    if (!target) return;
    // first (capture on the window) and only this: an Escape that ends the session does not
    // also reset the 3D tool, cancel a map drawing or close the split; one typed in a field
    // only leaves the field
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      store.getState().cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [target, store]);
}
