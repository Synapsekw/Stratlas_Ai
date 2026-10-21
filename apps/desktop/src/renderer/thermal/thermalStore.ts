/**
 * The thermal viewer's state: the project's `thermal.json`, the status of a layer's rasters, the
 * raster on show and how it is painted. No window and no singleton at import, so it runs in a unit
 * test with fake deps; `useThermal` is the app's instance, wired to the real bridge and jobs on
 * first use.
 */
import type { ThermalFile, ThermalRasterIndex, ThermalSettings } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import { autoRange } from './autoRange';
import type { PaletteId } from './palettes';
import { loadRaster, loadRasterIndex, type ThermalRaster } from './raster';
import { applySettings } from './settings';

export type ThermalProbe = {
  photoId: string;
  family: string | null;
  make: string | null;
  model: string | null;
}[];

export interface ThermalDeps {
  bridge: Pick<Bridge, 'call'>;
  loadRaster: (
    projectId: string,
    layerId: string,
    photoId: string,
  ) => Promise<ThermalRaster | null>;
  loadIndex: (projectId: string, layerId: string) => Promise<ThermalRasterIndex | null>;
  /** Start `thermal.decode` for these photos and wait for it to end: an error sentence or null. */
  decode: (layerId: string, photos: string[]) => Promise<string | null>;
}

export interface ThermalUi {
  projectId: string | null;
  layerId: string | null;
  photoId: string | null;
  file: ThermalFile | null;
  index: ThermalRasterIndex | null;
  probe: ThermalProbe | null;
  current: ThermalRaster | null;
  /** The photo `current` belongs to: null while another photo's raster loads. */
  currentOf: string | null;
  palette: PaletteId;
  /** The range on show: the raster's auto range until a person sets one. */
  range: [number, number] | null;
  /** The range follows each raster (auto) until `setRange` gets a value. */
  rangeAuto: boolean;
  decoding: boolean;
  /** A package or a reviewer who may only look: no probe, no decode, no write. */
  readOnly: boolean;
  error: string | null;
  /**
   * Read the project's thermal file and the layer's raster index, and probe the layer's photos
   * unless read-only (a package cannot be probed: its thermal photos are its index's).
   */
  open(
    projectId: string,
    layerId: string,
    photoId?: string,
    opts?: { readOnly?: boolean },
  ): Promise<void>;
  /**
   * Decode the probed thermal photos of the open layer that have no raster entry yet: one
   * `thermal.decode`, once per opening, never read-only.
   */
  decodeMissing(): Promise<void>;
  select(photoId: string | null): Promise<void>;
  setPalette(palette: PaletteId): void;
  setRange(range: [number, number] | null): void;
  /** Write the settings of `keys` (`"<layerId>/<photoId>"`), decode those photos, reload them. */
  saveSettings(keys: string[], patch: Partial<ThermalSettings>): Promise<void>;
}

const emptyFile = (): ThermalFile => ({
  schema: 'aio.thermal/1',
  photos: {},
  readings: [],
  hotspots: [],
});

export function createThermalStore(deps: ThermalDeps): StoreApi<ThermalUi> {
  return createStore<ThermalUi>()((set, get) => {
    /** `decodeMissing` already ran for this opening. */
    let missingAsked = false;
    const show = async (photoId: string | null) => {
      const { projectId, layerId } = get();
      if (!projectId || !layerId || photoId === null) {
        set({ photoId, current: null, currentOf: null });
        return;
      }
      // never the last photo's numbers under this one
      set({ photoId, current: null, currentOf: null });
      const r = await deps.loadRaster(projectId, layerId, photoId);
      // a later pick or another layer won while this loaded
      if (get().photoId !== photoId || get().layerId !== layerId) return;
      set({
        current: r,
        currentOf: r ? photoId : null,
        ...(get().rangeAuto && r ? { range: autoRange(r) } : {}),
      });
    };

    /** Decode `photos`, then read the index again and the shown photo when it was one of them. */
    const decodeAndReload = async (projectId: string, layerId: string, photos: string[]) => {
      set({ decoding: true });
      const failure = await deps.decode(layerId, photos);
      set({ decoding: false });
      if (get().projectId !== projectId || get().layerId !== layerId) return;
      if (failure !== null) set({ error: failure });
      const index = await deps.loadIndex(projectId, layerId);
      const still = () => get().projectId === projectId && get().layerId === layerId;
      if (!still()) return;
      if (index) set({ index });
      const shown = get().photoId;
      if (shown !== null && photos.includes(shown)) {
        const r = await deps.loadRaster(projectId, layerId, shown);
        if (still() && get().photoId === shown)
          set({
            current: r,
            currentOf: r ? shown : null,
            ...(get().rangeAuto && r ? { range: autoRange(r) } : {}),
          });
      }
    };

    return {
      projectId: null,
      layerId: null,
      photoId: null,
      file: null,
      index: null,
      probe: null,
      current: null,
      currentOf: null,
      palette: 'iron',
      range: null,
      rangeAuto: true,
      decoding: false,
      readOnly: false,
      error: null,

      open: async (projectId, layerId, photoId, opts) => {
        const readOnly = opts?.readOnly === true;
        missingAsked = false;
        set({
          readOnly,
          projectId,
          layerId,
          photoId: null,
          file: null,
          index: null,
          probe: null,
          current: null,
          currentOf: null,
          range: null,
          error: null,
        });
        const [read, probe, index] = await Promise.all([
          deps.bridge.call('thermal:read', { projectId }),
          readOnly ? null : deps.bridge.call('thermal:probe', { projectId, layerId }),
          deps.loadIndex(projectId, layerId),
        ]);
        if (get().projectId !== projectId || get().layerId !== layerId) return;
        if (!read.ok) set({ error: read.error });
        else if (!read.value.ok) set({ error: read.value.error });
        else set({ file: read.value.file ?? emptyFile() });
        if (probe?.ok && probe.value.ok) set({ probe: probe.value.photos });
        set({ index });
        if (photoId !== undefined) await show(photoId);
      },

      select: show,

      decodeMissing: async () => {
        const { projectId, layerId, probe, index, readOnly } = get();
        if (readOnly || missingAsked || !projectId || !layerId || probe === null) return;
        missingAsked = true;
        const photos = probe
          .filter((p) => p.family !== null && index?.photos[p.photoId] === undefined)
          .map((p) => p.photoId);
        if (photos.length > 0) await decodeAndReload(projectId, layerId, photos);
      },

      setPalette: (palette) => {
        set({ palette });
      },

      setRange: (range) => {
        const cur = get().current;
        set({ range: range ?? (cur ? autoRange(cur) : null), rangeAuto: range === null });
      },

      saveSettings: async (keys, patch) => {
        const { projectId, layerId, file } = get();
        if (get().readOnly || !projectId || !layerId || keys.length === 0) return;
        const prefix = `${layerId}/`;
        const mine = keys.filter((k) => k.startsWith(prefix));
        if (mine.length === 0) return;
        const next = applySettings(file ?? emptyFile(), mine, patch);
        set({ error: null });
        const w = await deps.bridge.call('thermal:write', { projectId, file: next });
        if (!w.ok) {
          set({ error: w.error });
          return;
        }
        if (!w.value.ok) {
          set({ error: w.value.error });
          return;
        }
        set({ file: next });
        await decodeAndReload(
          projectId,
          layerId,
          mine.map((k) => k.slice(prefix.length)),
        );
      },
    };
  });
}

/** The real deps: the app's bridge and jobs, imported on first use (the shell needs a window). */
const appDeps: ThermalDeps = {
  bridge: {
    call: async (channel, req) => (await lazyBridge()).call(channel, req),
  },
  loadRaster,
  loadIndex: loadRasterIndex,
  decode: async (layerId, photos) => {
    const [{ jobs }, { waitForJob }, { workspace }] = await Promise.all([
      import('../shell'),
      import('../jobs'),
      import('@aio/workspace'),
    ]);
    const root = workspace.getState().project?.root;
    if (!root) return 'No project is open.';
    const started = await jobs.getState().startQuiet({
      pipeline: 'thermal.decode',
      project: root,
      params: { layerId, photos },
    });
    if ('error' in started) return started.error;
    const done = await waitForJob(jobs, started.jobId);
    if (!done) return 'The decode job disappeared before it finished.';
    return done.status === 'done' ? null : (done.error ?? `The decode job ${done.status}.`);
  },
};

let bridgePromise: Promise<Bridge> | null = null;
function lazyBridge(): Promise<Bridge> {
  bridgePromise ??= import('../shell').then((m) => m.bridge);
  return bridgePromise;
}

export const thermalStore = createThermalStore(appDeps);

/** The app's thermal state, as a hook (`useThermal(s => s.current)`). */
export function useThermal<T = ThermalUi>(selector?: (s: ThermalUi) => T): T {
  return useStore(thermalStore, selector ?? ((s) => s as T));
}
useThermal.getState = thermalStore.getState;
useThermal.setState = thermalStore.setState;
