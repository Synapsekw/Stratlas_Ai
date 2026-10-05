/**
 * Comparing two survey dates in the split: one 3D view, map or ortho per date (captures), with
 * linked views. Generic over captures: any project with two dated captures offers it.
 */
import type { CameraLink, EngineStage } from '@aio/engine';
import type { MapController } from '@aio/maps';
import { formatDate } from '@aio/ui';
import { useVolumetric, type Volumetric } from '@aio/volumetric';
import {
  canCompare,
  captureIndex,
  scopedStore,
  useWorkspace,
  workspace,
  type CaptureHints,
  type CaptureIndex,
  type ScopedStore,
} from '@aio/workspace';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useGraphics, type GpuTier } from '../graphics';
import type { SplitDates } from './splitModel';

/** The main 3D view sees the workspace through this (one date while it shows one). */
export const primaryScene: ScopedStore = scopedStore(workspace);
/** The main map sees the workspace through this. */
export const primaryMap: ScopedStore = scopedStore(workspace);

/** Layer lists and survey keys the volumetric workspace knows (volumes.json captures). */
export function volumeHints(v: Pick<Volumetric, 'file' | 'layers'>): CaptureHints {
  const layers: Record<string, string[]> = {};
  const epochs: Record<string, string> = {};
  for (const c of v.file?.captures ?? []) {
    epochs[c.captureId] = c.epoch;
    const sl = v.layers[c.epoch];
    if (sl?.layers.length) layers[c.captureId] = sl.layers;
  }
  return { layers, epochs };
}

/** The open project's captures and their layers. */
export function useCaptureIndex(): CaptureIndex | null {
  const manifest = useWorkspace((s) => s.project?.manifest);
  const file = useVolumetric((s) => s.file);
  const layers = useVolumetric((s) => s.layers);
  return useMemo(
    () => (manifest ? captureIndex(manifest, volumeHints({ file, layers })) : null),
    [manifest, file, layers],
  );
}

/**
 * Graphics memory two 3D views may use together, per tier (estimated: buffers, textures, render
 * targets of both views). The Low tier runs one 3D view and offers the swipe instead.
 */
export const COMPARE_GPU_BYTES: Record<GpuTier, number> = {
  low: 0,
  medium: 1.5 * 2 ** 30,
  high: 3 * 2 ** 30,
  ultra: 6 * 2 ** 30,
};

/** The dates the split can show (null with fewer than two dated captures). */
export function splitDates(index: CaptureIndex | null, tier: GpuTier): SplitDates | undefined {
  if (!index || !canCompare(index)) return undefined;
  return { captures: index.captures.map((c) => c.id), twin3d: tier !== 'low' };
}

export function useSplitDates(index: CaptureIndex | null): SplitDates | undefined {
  const tier = useGraphics((s) => s.tier);
  return useMemo(() => splitDates(index, tier), [index, tier]);
}

/** A capture as a pane corner names it: its date, "31 Dec 2020". */
export function captureLabel(index: CaptureIndex, id: string | undefined): string {
  const c = index.captures.find((x) => x.id === id);
  return c ? formatDate(c.date) : '';
}

/** The live comparison, for the inspection hook (tests, DevTools). */
export const compareRuntime: {
  second: EngineStage | null;
  link: CameraLink | null;
  maps: [MapController | null, MapController | null];
} = { second: null, link: null, maps: [null, null] };

/* ----------------------------------------------------------------------- notices */

interface NoticeState {
  text: string | null;
  show(text: string): void;
  clear(): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** A short notice on the stage (the swipe instead of two 3D views on the Low tier). */
export const compareNotice = createStore<NoticeState>()((set) => ({
  text: null,
  show(text) {
    if (timer) clearTimeout(timer);
    set({ text });
    timer = setTimeout(() => {
      set({ text: null });
    }, 8000);
  },
  clear() {
    if (timer) clearTimeout(timer);
    set({ text: null });
  },
}));

export function useCompareNotice(): string | null {
  return useStore(compareNotice, (s) => s.text);
}

/* ----------------------------------------------------------------------- linked maps */

/** What a map link needs of MapLibre's map. */
export interface LinkableMap {
  on(type: 'move', listener: () => void): unknown;
  off(type: 'move', listener: () => void): unknown;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  jumpTo(view: { center: [number, number]; zoom: number; bearing: number; pitch: number }): unknown;
}

/**
 * Two maps of the same place (two survey dates): pan, zoom or rotate one and the other follows.
 * Returns an unlink function. The map that moves first (`from`) sets the view.
 */
export function linkMaps(from: LinkableMap, to: LinkableMap): () => void {
  let syncing = false;
  const copy = (a: LinkableMap, b: LinkableMap) => () => {
    if (syncing) return;
    const c = a.getCenter();
    const view = {
      center: [c.lng, c.lat] as [number, number],
      zoom: a.getZoom(),
      bearing: a.getBearing(),
      pitch: a.getPitch(),
    };
    const d = b.getCenter();
    if (
      Math.abs(d.lng - c.lng) < 1e-10 &&
      Math.abs(d.lat - c.lat) < 1e-10 &&
      Math.abs(b.getZoom() - view.zoom) < 1e-6 &&
      Math.abs(b.getBearing() - view.bearing) < 1e-6 &&
      Math.abs(b.getPitch() - view.pitch) < 1e-6
    )
      return;
    syncing = true;
    try {
      b.jumpTo(view);
    } finally {
      syncing = false;
    }
  };
  const ab = copy(from, to);
  const ba = copy(to, from);
  from.on('move', ab);
  to.on('move', ba);
  ab();
  return () => {
    from.off('move', ab);
    to.off('move', ba);
  };
}
