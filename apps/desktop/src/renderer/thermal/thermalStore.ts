/**
 * The thermal viewer's state: the project's `thermal.json`, the status of a layer's rasters, the
 * raster on show and how it is painted. No window and no singleton at import, so it runs in a unit
 * test with fake deps; `useThermal` is the app's instance, wired to the real bridge and jobs on
 * first use.
 */
import {
  ThermalRasterMeta,
  thermalPhotoKey,
  type ThermalFile,
  type ThermalRasterIndex,
  type ThermalSettings,
} from '@aio/schema';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import { autoRange } from './autoRange';
import type { PaletteId } from './palettes';
import { loadRaster, loadRasterIndex, type ThermalRaster } from './raster';
import { DESIGN_DEFAULTS, applySettings, settingsDiffer } from './settings';

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
  /** A raster's sidecar alone (`<photoId>.json`): null when missing or not valid. */
  loadMeta: (
    projectId: string,
    layerId: string,
    photoId: string,
  ) => Promise<ThermalRasterMeta | null>;
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
  /**
   * The photo whose raster load finished, `current` being its raster or null when it has none
   * that reads; null while a photo's raster loads.
   */
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
   * Decode the probed thermal photos of the open layer that need it: no raster entry yet, or an
   * `ok` entry whose raster is missing or unreadable, or was decoded with settings other than the
   * photo's own (a decode after a save that failed or was cancelled). One `thermal.decode`, once
   * per opening, never read-only.
   */
  decodeMissing(): Promise<void>;
  select(photoId: string | null): Promise<void>;
  setPalette(palette: PaletteId): void;
  setRange(range: [number, number] | null): void;
  /**
   * Apply `patch` to the settings of `keys` (`"<layerId>/<photoId>"`), write them, decode those
   * photos and reload them. A photo with no settings of its own starts from what its raster was
   * decoded with (its height-based distance, say), else the file's or the design defaults.
   */
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
    /** Photos of this opening whose raster did not load. */
    let broken = new Set<string>();
    /** The raster load under way, so `decodeMissing` knows how the shown photo's went. */
    let showing: Promise<void> = Promise.resolve();
    const load = async (photoId: string | null) => {
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
      if (r) broken.delete(photoId);
      else broken.add(photoId);
      set({
        current: r,
        currentOf: photoId,
        ...(get().rangeAuto && r ? { range: autoRange(r) } : {}),
      });
    };
    const show = (photoId: string | null): Promise<void> => {
      showing = load(photoId);
      return showing;
    };

    /**
     * Where the photos of `keys` with no settings of their own start: what their raster used. A
     * field the camera's SDK clamped was not asked for, so that one is the design default's.
     */
    const basesOf = async (
      projectId: string,
      layerId: string,
      file: ThermalFile | null,
      keys: readonly string[],
    ): Promise<Record<string, ThermalSettings>> => {
      const prefix = `${layerId}/`;
      const bases: Record<string, ThermalSettings> = {};
      await Promise.all(
        keys
          .filter((k) => !file?.photos[k])
          .map(async (k) => {
            const meta = await deps.loadMeta(projectId, layerId, k.slice(prefix.length));
            if (!meta) return;
            const base: ThermalSettings = { ...meta.settings };
            for (const c of meta.clamped)
              if (c in DESIGN_DEFAULTS)
                Object.assign(base, { [c]: DESIGN_DEFAULTS[c as keyof ThermalSettings] });
            bases[k] = base;
          }),
      );
      return bases;
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
            currentOf: shown,
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
        broken = new Set();
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
        const { projectId, layerId, probe, readOnly } = get();
        if (readOnly || missingAsked || !projectId || !layerId || probe === null) return;
        missingAsked = true;
        // how the shown photo's raster loaded counts too
        await showing;
        const still = () => get().projectId === projectId && get().layerId === layerId;
        if (!still()) return;
        const { index, file } = get();
        const thermal = probe.filter((p) => p.family !== null).map((p) => p.photoId);
        const redo = await Promise.all(
          thermal.map(async (id) => {
            const entry = index?.photos[id];
            if (entry === undefined) return true;
            if (entry.status !== 'ok') return false;
            if (broken.has(id)) return true;
            const meta = await deps.loadMeta(projectId, layerId, id);
            if (!meta) return true;
            const own = file?.photos[thermalPhotoKey(layerId, id)]?.settings;
            return own !== undefined && settingsDiffer(own, meta.settings, meta.clamped);
          }),
        );
        if (!still()) return;
        const photos = thermal.filter((_, i) => redo[i]);
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
        const next = applySettings(
          file ?? emptyFile(),
          mine,
          patch,
          file?.defaults ? {} : await basesOf(projectId, layerId, file, mine),
        );
        if (get().projectId !== projectId || get().layerId !== layerId) return;
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
  loadMeta: async (projectId, layerId, photoId) => {
    try {
      const path = ['thermal', 'rasters', layerId, `${photoId}.json`].map(encodeURIComponent);
      const res = await fetch(`aio://project/${encodeURIComponent(projectId)}/${path.join('/')}`);
      if (!res.ok) return null;
      const meta = ThermalRasterMeta.safeParse(await res.json());
      return meta.success ? meta.data : null;
    } catch {
      return null;
    }
  },
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
