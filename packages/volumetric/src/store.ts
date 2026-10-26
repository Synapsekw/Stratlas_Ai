/**
 * State of the volumetric workspace: the project's kit piles (their outlines and saved edits, for
 * the 3D toe lines and bodies), the survey shown, the selected pile (kept in step with the scene
 * selection), the display modes, the two surveys "Cut / fill" compares and the section tool.
 * Drawing goes to the volume worker. No volume is computed here: the kit's base computation, its
 * register and its boundary editor retired (volumetric parity W3); every figure a person reads
 * comes from the survey engine, on the pile's volume measurement.
 */
import type { AioBridge, BoundaryEdit, DateShift, IpcResponse, VolumesFile } from '@aio/schema';
import { assetUrl, captureShift, workspace as appWorkspace, type Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  isRampId,
  type ChangeGridCells,
  type RampId,
  type ReliefStyle,
  type SectionProfile,
} from './model/dsm';
import type { EN } from './model/edit';
import { pileNode, surveyLayers, type SurveyLayers } from './model/layers';
import { applyEdits, type EffectivePile } from './model/register';
import { startVolumeWorker, type VolumeService } from './worker/client';
import type { WorkerInit } from './worker/protocol';

export type SurfaceMode = 'photo' | 'elev' | 'change';
export type BodyMode = 'lift' | 'place' | 'off';

/** How the Elevation surface is coloured (remembered per project). */
export interface ElevationStyle {
  ramp: RampId;
  /** Heights at the ends of the ramp, m; null: the 1st to 99th percentile of the surveys. */
  range: [number, number] | null;
  hillshade: boolean;
}

export const DEFAULT_ELEVATION: ElevationStyle = { ramp: 'turbo', range: null, hillshade: true };

/** Display choices remembered per project on this machine. */
export interface VolumePrefs {
  /** Every pile's volume, toe line and callout drawn in 3D (else only the selected pile). */
  showAll?: boolean;
  elevation?: ElevationStyle;
}

/** Where the per-project choices are kept (localStorage in the app). */
export interface VolumePrefStore {
  read(projectId: string): VolumePrefs;
  write(projectId: string, prefs: VolumePrefs): void;
}

/** Validated prefs from anything stored. */
export function parseVolumePrefs(v: unknown): VolumePrefs {
  if (!v || typeof v !== 'object') return {};
  const raw = v as Record<string, unknown>;
  const out: VolumePrefs = {};
  if (typeof raw.showAll === 'boolean') out.showAll = raw.showAll;
  const e = raw.elevation as Record<string, unknown> | undefined;
  if (e && typeof e === 'object' && isRampId(e.ramp)) {
    const r = e.range;
    const range =
      Array.isArray(r) &&
      r.length === 2 &&
      r.every((x) => typeof x === 'number' && Number.isFinite(x)) &&
      (r[0] as number) < (r[1] as number)
        ? ([r[0], r[1]] as [number, number])
        : null;
    out.elevation = { ramp: e.ramp, range, hillshade: e.hillshade !== false };
  }
  return out;
}

const PREFS_KEY = 'stratlas.volumePrefs';

/** Per-project prefs in localStorage; nothing is kept where storage is not available. */
export function localPrefStore(): VolumePrefStore {
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  const all = (): Record<string, unknown> => {
    try {
      const v = JSON.parse(storage()?.getItem(PREFS_KEY) ?? '{}') as unknown;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    read: (id) => parseVolumePrefs(all()[id]),
    write: (id, prefs) => {
      try {
        storage()?.setItem(PREFS_KEY, JSON.stringify({ ...all(), [id]: prefs }));
      } catch {
        // storage full or unavailable: the choice lasts for this session
      }
    },
  };
}

export interface SectionState {
  mode: 'idle' | 'picking' | 'done';
  points: EN[];
  profile: SectionProfile | null;
  busy: boolean;
  /** The two surveys profiled (set once the line is drawn). */
  pair: ChangePair | null;
}

/** The two surveys "Cut / fill" compares (epochs of the volumes file), from and to. */
export interface ChangePair {
  from: string;
  to: string;
}

/** The survey engine's whole-site difference for a pair, from the host (the desktop). */
export interface ChangeGrid extends ChangePair {
  grid: ChangeGridCells;
}

/** A kit pile's figure on one survey, as its volume measurement reads it (host-fed). */
export interface PileFigure {
  /** The measurement's primary value, formatted in the site's units. */
  value: string;
  /** Its tonnage from the measurement's material, or null without a density. */
  tonnes: string | null;
}

/**
 * The kit piles' figures from their volume measurements, by pile id and then survey epoch. A pile
 * listed here has a measurement (which draws its outline); an epoch without an entry has no
 * result yet. A pile not listed has no measurement.
 */
export type PileFigures = Readonly<Record<string, Readonly<Record<string, PileFigure>>>>;

const IDLE_SECTION: SectionState = {
  mode: 'idle',
  points: [],
  profile: null,
  busy: false,
  pair: null,
};

/**
 * The default pair around a survey: the one before it to it (previous to current); the first
 * survey, which has none before it, to the next one. Null with fewer than two surveys.
 */
export function defaultChangePair(epochs: readonly string[], epoch: string): ChangePair | null {
  const i = epochs.indexOf(epoch);
  const prev = i > 0 ? epochs[i - 1] : undefined;
  if (prev !== undefined) return { from: prev, to: epoch };
  const first = epochs[0];
  const next = epochs[1];
  return first !== undefined && next !== undefined ? { from: first, to: next } : null;
}

export interface VolumetricState {
  status: 'idle' | 'loading' | 'ready' | 'none' | 'error';
  error: string | null;
  projectId: string | null;
  projectName: string;
  origin: [number, number, number];
  file: VolumesFile | null;
  edits: BoundaryEdit[];
  piles: EffectivePile[];
  layers: Record<string, SurveyLayers>;
  epoch: string;
  swipe: boolean;
  /** Swipe divider across the 3D view, 0 (left) to 1 (right). */
  swipeX: number;
  surface: SurfaceMode;
  /** The surveys the Cut / fill colours compare (set while they show). */
  change: ChangePair | null;
  /** The engine's difference for `change`; null: the colours come from the surveys' heights. */
  changeGrid: ChangeGrid | null;
  body: BodyMode;
  /** The piles' figures from their volume measurements (the callouts read them). */
  pileFigures: PileFigures;
  /**
   * Piles whose volume measurement the host draws now (shown, on the date in focus): the
   * measurement's look stands for them, so the kit draws no body of its own. A pile whose
   * measurement is hidden or on another date keeps its kit body.
   */
  measuredShown: readonly string[];
  selected: string | null;
  /**
   * Piles whose volume, toe line and callout are drawn in 3D besides the selected one. Empty by
   * default: a pile shows when it is selected (clicked on the terrain, in the register or by the
   * agent); the eyes in the register show some or all of them deliberately.
   */
  shown: string[];
  elevation: ElevationStyle;
  /** Heights of the surveys for the elevation ramp, once the worker has read the DSMs. */
  relief: { auto: [number, number]; extent: [number, number] } | null;
  section: SectionState;
  /** A read-only package is open. */
  readOnly: boolean;
  /** Short notice for the person (toast). */
  message: string | null;
  service: VolumeService | null;
}

export interface VolumetricActions {
  load(): Promise<void>;
  unload(): void;
  setEpoch(epoch: string): void;
  setSwipe(on: boolean): void;
  setSwipeX(x: number): void;
  setSurface(surface: SurfaceMode): void;
  /** Pick the two surveys Cut / fill compares (two different dates of the volumes). */
  setChange(pair: ChangePair): void;
  /** The engine's difference for a pair (the host's whole-site run); ignored for another pair. */
  setChangeGrid(grid: ChangeGrid | null): void;
  /** The piles' figures from their volume measurements (the host's connector). */
  setPileFigures(figures: PileFigures): void;
  /** The piles whose volume measurement the host draws now (the host's connector). */
  setMeasuredShown(piles: readonly string[]): void;
  /** The survey on screen: the "to" survey under the change colours, else the chosen one. */
  shownEpoch(): string;
  /**
   * The shift of a survey's date (line up dates), or null. Boundaries are stored where the
   * survey saw them; the scene draws them on the lined-up dates.
   */
  epochShift(epoch: string): DateShift | null;
  setBody(body: BodyMode): void;
  select(pile: string | null, opts?: { fly?: boolean }): void;
  setPileVisible(pile: string, visible: boolean): void;
  /** Show or hide every pile; remembered for the project. */
  setAllPilesVisible(visible: boolean): void;
  /** Drawn in 3D: shown on purpose, or the selected pile. */
  isPileShown(pile: string): boolean;
  /** Change the elevation colours; remembered for the project. */
  setElevation(patch: Partial<ElevationStyle>): void;
  /** The elevation colours with the range resolved (null until the heights are known). */
  reliefStyle(): ReliefStyle | null;
  step(dir: 1 | -1): void;
  startSection(): void;
  addSectionPoint(p: EN): Promise<void>;
  clearSection(): void;
  setMessage(message: string | null): void;
  setReadOnly(on: boolean): void;
}

export type Volumetric = VolumetricState & VolumetricActions;

export interface VolumetricDeps {
  workspace: StoreApi<Workspace>;
  /** volumes.json and edits/boundaries.json of an open project (IPC project:readVolumes). */
  readVolumes(projectId: string): Promise<IpcResponse<'project:readVolumes'>>;
  startService(init: WorkerInit): VolumeService;
  /** Per-project display choices (none kept when absent). */
  prefs?: VolumePrefStore;
}

const initial: VolumetricState = {
  status: 'idle',
  error: null,
  projectId: null,
  projectName: '',
  origin: [0, 0, 0],
  file: null,
  edits: [],
  piles: [],
  layers: {},
  epoch: '',
  swipe: false,
  swipeX: 0.5,
  surface: 'photo',
  change: null,
  changeGrid: null,
  body: 'lift',
  pileFigures: {},
  measuredShown: [],
  selected: null,
  shown: [],
  elevation: DEFAULT_ELEVATION,
  relief: null,
  section: IDLE_SECTION,
  readOnly: false,
  message: null,
  service: null,
};

const DEFAULT_GRIDS = {
  piles: 'legacy/data/piles/{id}.js',
  dsm: 'legacy/data/dsm_{epoch}.js',
  coarse: 'legacy/data/vol.js',
};

/** aio:// URL of a project path that may hold `{id}` / `{epoch}` placeholders (kept unescaped). */
function patternUrl(projectId: string, path: string): string {
  return assetUrl(projectId, { path })
    .replace(/%7Bid%7D/gi, '{id}')
    .replace(/%7Bepoch%7D/gi, '{epoch}');
}

/** The survey epochs of the volumes, first to last. */
function epochsOf(file: VolumesFile | null): string[] {
  return file?.captures.map((c) => c.epoch) ?? [];
}

/** Pile id of a scene asset id such as `P02_e2`. */
function pileOfNode(piles: readonly EffectivePile[], id: string): string | null {
  for (const p of piles) {
    if (Object.values(p.epochs).some((e) => e.node === id)) return p.id;
    if (id === p.id || id.startsWith(`${p.id}_`)) return p.id;
  }
  return null;
}

export function createVolumetricStore(deps: VolumetricDeps): StoreApi<Volumetric> {
  let unsubscribe: (() => void) | null = null;
  let loadSeq = 0;

  return createStore<Volumetric>()((set, get) => {
    const ws = () => deps.workspace.getState();
    const epochShift = (epoch: string): DateShift | null => {
      const manifest = ws().project?.manifest;
      const capture = get().file?.captures.find((c) => c.epoch === epoch);
      return manifest && capture ? captureShift(manifest, capture.captureId) : null;
    };
    /** Scene selection for a pile on the shown survey (or the other one when absent). */
    const assetFor = (pile: string) => {
      const s = get();
      const p = s.piles.find((q) => q.id === pile);
      if (!p) return null;
      const epochs = [s.epoch, ...Object.keys(p.epochs).filter((e) => e !== s.epoch)];
      for (const e of epochs) {
        const terrain = s.layers[e]?.terrain;
        if (!terrain || (!p.epochs[e] && e !== s.epoch)) continue;
        return { kind: 'asset' as const, id: pileNode(pile, e, p.epochs[e]), layer: terrain };
      }
      return null;
    };

    let applyingLayers = false;
    const showLayers = () => {
      const s = get();
      const w = ws();
      const shown = get().shownEpoch();
      applyingLayers = true;
      try {
        for (const [e, sl] of Object.entries(s.layers))
          for (const id of sl.layers)
            w.setLayerVisible(id, e === shown || (s.swipe && id === sl.terrain));
      } finally {
        applyingLayers = false;
      }
    };

    const savePrefs = (patch: VolumePrefs) => {
      const id = get().projectId;
      if (!id || !deps.prefs) return;
      deps.prefs.write(id, { ...deps.prefs.read(id), ...patch });
    };

    /**
     * A survey's layer switched on by hand (dataset tree, Layers): that survey becomes the one
     * shown, so two dates never draw on top of each other outside the swipe.
     */
    const followLayers = (now: Record<string, true>, before: Record<string, true>) => {
      const s = get();
      if (applyingLayers || s.swipe || s.status !== 'ready') return;
      const current = s.shownEpoch();
      for (const [e, sl] of Object.entries(s.layers)) {
        if (e === current) continue;
        if (sl.layers.some((id) => before[id] && !now[id])) {
          get().setEpoch(e);
          return;
        }
      }
    };

    /** The survey heights for the elevation ramp, read once when the colours are first wanted. */
    let reliefAsked: VolumeService | null = null;
    const ensureRelief = () => {
      const svc = get().service;
      if (!svc || reliefAsked === svc || get().relief) return;
      reliefAsked = svc;
      svc.grid().then(
        (g) => {
          if (get().service === svc)
            set({
              relief: { auto: [g.relief[0], g.relief[1]], extent: [g.extent[0], g.extent[1]] },
            });
        },
        (e: unknown) => {
          reliefAsked = null;
          set({ message: e instanceof Error ? e.message : String(e) });
        },
      );
    };

    return {
      ...initial,

      async load() {
        const seq = ++loadSeq;
        get().unload();
        const project = ws().project;
        if (!project) return;
        set({ status: 'loading', projectId: project.id, projectName: project.manifest.name });
        try {
          const r = await deps.readVolumes(project.id);
          if (seq !== loadSeq) return;
          if (!r.ok) throw new Error(r.error);
          const file = r.volumes;
          if (!file) {
            set({ ...initial, readOnly: get().readOnly, status: 'none', projectId: project.id });
            return;
          }
          const edits = r.edits?.edits ?? [];
          const grids = file.grids ?? DEFAULT_GRIDS;
          const epochs = file.captures.map((c) => c.epoch);
          const service = deps.startService({
            patterns: {
              pile: patternUrl(project.id, grids.piles),
              dsm: patternUrl(project.id, grids.dsm),
              coarse: patternUrl(project.id, grids.coarse ?? DEFAULT_GRIDS.coarse),
            },
            epochs,
            deadband: file.deadbandM,
          });
          const prefs = deps.prefs?.read(project.id) ?? {};
          const piles = applyEdits(file, edits);
          set({
            ...initial,
            readOnly: get().readOnly,
            status: 'ready',
            projectId: project.id,
            projectName: project.manifest.name,
            origin: project.manifest.origin,
            file,
            edits,
            piles,
            layers: surveyLayers(project.manifest.layers, file.captures),
            epoch: epochs.at(-1) ?? '',
            shown: prefs.showAll ? piles.map((p) => p.id) : [],
            elevation: prefs.elevation ?? DEFAULT_ELEVATION,
            service,
          });
          showLayers();
          unsubscribe = deps.workspace.subscribe((w, prev) => {
            if (w.hidden !== prev.hidden) followLayers(w.hidden, prev.hidden);
            if (w.selection === prev.selection) return;
            const sel = w.selection;
            const pile = sel?.kind === 'asset' ? pileOfNode(get().piles, sel.id) : null;
            if (pile !== get().selected) {
              set({ selected: pile });
              // picked on the terrain or by the agent: fly to the pile it reveals
              if (pile && sel) ws().flyTo({ kind: 'selection', selection: sel });
            }
          });
        } catch (e) {
          if (seq !== loadSeq) return;
          set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      },

      unload() {
        unsubscribe?.();
        unsubscribe = null;
        get().service?.dispose();
        // read-only follows the opened package, not the volumes file
        set({ ...initial, readOnly: get().readOnly });
      },

      setEpoch(epoch) {
        // a date shows that survey's photo: the Cut / fill colours of two dates step aside
        const surface = get().surface === 'change' ? 'photo' : get().surface;
        set({ epoch, swipe: false, surface, change: null, changeGrid: null });
        showLayers();
        const pile = get().selected;
        if (pile) {
          const a = assetFor(pile);
          if (a) ws().select(a);
        }
      },

      setSwipe(on) {
        set({ swipe: on, swipeX: 0.5 });
        showLayers();
      },

      setSwipeX(x) {
        set({ swipeX: Math.max(0.02, Math.min(0.98, x)) });
      },

      setSurface(surface) {
        const s = get();
        if (surface === 'change') {
          // previous to current, picked afresh each time the colours are switched on
          const pair = defaultChangePair(epochsOf(s.file), s.epoch);
          if (!pair) return;
          set({ surface, change: pair, changeGrid: null });
        } else set({ surface, change: null, changeGrid: null });
        if (surface === 'elev') ensureRelief();
        showLayers();
      },

      setChange(asked) {
        const s = get();
        const epochs = epochsOf(s.file);
        const i = epochs.indexOf(asked.from);
        const j = epochs.indexOf(asked.to);
        if (i < 0 || j < 0 || i === j) return;
        // the earlier survey is always From: a From picked after To swaps them
        const pair = i < j ? asked : { from: asked.to, to: asked.from };
        if (s.surface === 'change' && s.change?.from === pair.from && s.change.to === pair.to)
          return;
        set({ surface: 'change', swipe: false, change: { ...pair }, changeGrid: null });
        showLayers();
      },

      setChangeGrid(grid) {
        const c = get().change;
        if (grid && (c?.from !== grid.from || c.to !== grid.to)) return;
        set({ changeGrid: grid });
      },

      setPileFigures(figures) {
        set({ pileFigures: figures });
      },

      setMeasuredShown(piles) {
        const was = get().measuredShown;
        const same = was.length === piles.length && was.every((p, i) => p === piles[i]);
        if (!same) set({ measuredShown: [...piles] });
      },

      epochShift,

      shownEpoch() {
        const s = get();
        return s.surface === 'change' && s.change ? s.change.to : s.epoch;
      },

      setBody(body) {
        set({ body });
      },

      select(pile, opts = {}) {
        set({ selected: pile });
        if (!pile) {
          if (ws().selection?.kind === 'asset') ws().select(null);
          return;
        }
        const a = assetFor(pile);
        if (a) {
          ws().select(a);
          if (opts.fly !== false) ws().flyTo({ kind: 'selection', selection: a });
        }
      },

      setPileVisible(pile, visible) {
        const s = get();
        const others = s.shown.filter((id) => id !== pile);
        const shown = visible ? [...others, pile] : others;
        set({ shown });
        // the "all" choice is what is remembered: it ends when one pile is hidden again
        const all = s.piles.length > 0 && s.piles.every((p) => shown.includes(p.id));
        savePrefs({ showAll: all });
      },

      setAllPilesVisible(visible) {
        set({ shown: visible ? get().piles.map((p) => p.id) : [] });
        savePrefs({ showAll: visible });
      },

      isPileShown(pile) {
        const s = get();
        return pile === s.selected || s.shown.includes(pile);
      },

      setElevation(patch) {
        const elevation = { ...get().elevation, ...patch };
        const r = elevation.range;
        if (r && !(r[0] < r[1])) return;
        set({ elevation });
        ensureRelief();
        savePrefs({ elevation });
      },

      reliefStyle() {
        const s = get();
        const range = s.elevation.range ?? s.relief?.auto;
        if (!range) return null;
        return {
          ramp: s.elevation.ramp,
          lo: range[0],
          hi: range[1],
          hillshade: s.elevation.hillshade,
        };
      },

      step(dir) {
        const s = get();
        if (!s.piles.length) return;
        const i = s.piles.findIndex((p) => p.id === s.selected);
        const n = s.piles.length;
        const next = s.piles[(((i < 0 ? 0 : i + dir) % n) + n) % n];
        if (next) get().select(next.id);
      },

      startSection() {
        set({ section: { ...IDLE_SECTION, mode: 'picking' } });
      },

      async addSectionPoint(p) {
        const sec = get().section;
        if (sec.mode !== 'picking') return;
        const points = [...sec.points, p];
        if (points.length < 2) {
          set({ section: { ...sec, points } });
          return;
        }
        const [a, b] = points as [EN, EN];
        // the surveys Cut / fill compares, else the one before the shown survey to it
        const s = get();
        const pair = s.change ?? defaultChangePair(epochsOf(s.file), s.epoch);
        set({ section: { mode: 'done', points, profile: null, busy: true, pair } });
        const svc = get().service;
        if (!svc) return;
        try {
          const profile = await svc.section(a, b, pair?.from, pair?.to);
          if (get().section.points === points)
            set({ section: { mode: 'done', points, profile, busy: false, pair } });
        } catch (e) {
          set({ section: IDLE_SECTION, message: e instanceof Error ? e.message : String(e) });
        }
      },

      clearSection() {
        set({ section: IDLE_SECTION });
      },

      setMessage(message) {
        set({ message });
      },

      setReadOnly(on) {
        set({ readOnly: on });
      },
    };
  });
}

const appBridge = () => (globalThis as { aio?: AioBridge }).aio ?? null;

/** The app-wide volumetric store over the app workspace. */
export const volumetric = createVolumetricStore({
  workspace: appWorkspace,
  readVolumes: (projectId) => {
    const b = appBridge();
    return b
      ? b.invoke('project:readVolumes', { projectId })
      : Promise.resolve({ ok: true, volumes: null, edits: null });
  },
  startService: startVolumeWorker,
  prefs: localPrefStore(),
});

export function useVolumetric<T>(selector: (s: Volumetric) => T): T {
  return useStore(volumetric, selector);
}
