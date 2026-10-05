/**
 * State of the volumetric workspace: the project's volumes and edits, the survey and base shown,
 * the selected pile (kept in step with the scene selection), the display modes, the section tool
 * and the boundary editor. Computations go to the volume worker; edits are saved through
 * `project:writeBoundaries`.
 */
import {
  BoundaryEditsFile,
  type AioBridge,
  type IpcResponse,
  type BaseVolumes,
  type BoundaryEdit,
  type VolumeBaseId,
  type VolumesFile,
} from '@aio/schema';
import { assetUrl, workspace as appWorkspace, type Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EditResponse } from './model/compute';
import { isRampId, type RampId, type ReliefStyle, type SectionProfile } from './model/dsm';
import { simplifyRing, type EN } from './model/edit';
import { enToLocal, localToEN } from './model/frame';
import { pileNode, surveyLayers, type SurveyLayers } from './model/layers';
import { applyEdits, registerCsv, type EffectivePile, type SortKey } from './model/register';
import type { PileSection } from './model/section';
import { startVolumeWorker, type VolumeService } from './worker/client';
import type { WorkerInit } from './worker/protocol';

export type SurfaceMode = 'photo' | 'elev' | 'change';
export type BodyMode = 'lift' | 'place' | 'off';

export interface EditSession {
  pile: string;
  epoch: string;
  /** Toe line being edited, easting and northing. */
  ring: EN[];
  hist: EN[][];
  sel: number;
  dirty: boolean;
  /** The line was reset to the automatic one. */
  resetToAuto: boolean;
  live: EditResponse | null;
  busy: boolean;
}

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
  base: VolumeBaseId;
  surface: SurfaceMode;
  body: BodyMode;
  density: number;
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
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  section: SectionState;
  edit: EditSession | null;
  /** Automatic volumes recomputed in the worker from the 10 cm grids, per pile and epoch. */
  recomputed: Record<string, Record<string, BaseVolumes | null>>;
  pileProfile: { pile: string; epoch: string; base: VolumeBaseId; data: PileSection } | null;
  saving: boolean;
  /** A read-only package is open: boundaries are shown, never edited or saved. */
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
  setBase(base: VolumeBaseId): void;
  setSurface(surface: SurfaceMode): void;
  /** The survey on screen: the last one under the change colours, else the chosen one. */
  shownEpoch(): string;
  setBody(body: BodyMode): void;
  setDensity(density: number): void;
  setSort(key: SortKey): void;
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
  startEdit(): Promise<void>;
  moveVertex(i: number, p: EN): Promise<void>;
  insertVertex(after: number, p: EN): Promise<void>;
  deleteVertex(i: number): Promise<void>;
  selectVertex(i: number): void;
  undo(): Promise<void>;
  resetEdit(): Promise<void>;
  cancelEdit(): void;
  saveEdit(): Promise<boolean>;
  revert(pile: string, epoch: string): Promise<boolean>;
  exportCsv(): Promise<void>;
  setMessage(message: string | null): void;
  setReadOnly(on: boolean): void;
}

export type Volumetric = VolumetricState & VolumetricActions;

/** Shown when an edit is tried in a read-only package. */
export const READ_ONLY = 'This project is a read-only package. Boundaries cannot be changed.';

export interface VolumetricDeps {
  workspace: StoreApi<Workspace>;
  /** volumes.json and edits/boundaries.json of an open project (IPC project:readVolumes). */
  readVolumes(projectId: string): Promise<IpcResponse<'project:readVolumes'>>;
  startService(init: WorkerInit): VolumeService;
  bridge(): AioBridge | null;
  now(): string;
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
  base: 'tin',
  surface: 'photo',
  body: 'lift',
  density: 1.6,
  selected: null,
  shown: [],
  elevation: DEFAULT_ELEVATION,
  relief: null,
  sort: { key: 'id', dir: 'asc' },
  section: { mode: 'idle', points: [], profile: null, busy: false },
  edit: null,
  recomputed: {},
  pileProfile: null,
  saving: false,
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
  let editSeq = 0;
  let loadSeq = 0;

  return createStore<Volumetric>()((set, get) => {
    const ws = () => deps.workspace.getState();
    const toLocal = (ring: EN[]) =>
      ring.map((q) => {
        const [x, z] = enToLocal(get().origin, q);
        return [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000] as [number, number];
      });

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
          if (s.edit) {
            showLayers();
            set({ message: 'Save or cancel the boundary edit first' });
          } else get().setEpoch(e);
          return;
        }
      }
    };

    const refreshPile = () => {
      const s = get();
      const svc = s.service;
      const pile = s.selected;
      if (!svc || !pile) return;
      if (!s.recomputed[pile])
        svc.recompute(pile).then(
          (r) => {
            set({ recomputed: { ...get().recomputed, [pile]: r } });
          },
          (e: unknown) => {
            set({ message: e instanceof Error ? e.message : String(e) });
          },
        );
      const { epoch, base } = s;
      svc.pileSection(pile, epoch, base).then(
        (data) => {
          const now = get();
          if (now.selected === pile && now.epoch === epoch && now.base === base)
            set({ pileProfile: { pile, epoch, base, data } });
        },
        () => undefined,
      );
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

    const recomputeEdit = async () => {
      const ed = get().edit;
      const svc = get().service;
      if (!ed || !svc) return;
      const seq = ++editSeq;
      set({ edit: { ...ed, busy: true } });
      try {
        const live = await svc.edit({
          pile: ed.pile,
          epoch: ed.epoch,
          ring: ed.ring,
          base: get().base,
        });
        const now = get().edit;
        if (seq !== editSeq || !now) return;
        set({ edit: { ...now, live, busy: false } });
      } catch (e) {
        const now = get().edit;
        if (now) set({ edit: { ...now, busy: false } });
        set({ message: e instanceof Error ? e.message : String(e) });
      }
    };

    const changeRing = async (ring: EN[], sel = -1) => {
      const ed = get().edit;
      if (!ed) return;
      const hist = [...ed.hist, ed.ring].slice(-60);
      set({ edit: { ...ed, ring, hist, sel, dirty: true, resetToAuto: false } });
      await recomputeEdit();
    };

    const writeEdits = async (edits: BoundaryEdit[]): Promise<boolean> => {
      const s = get();
      if (s.readOnly) {
        set({ message: READ_ONLY });
        return false;
      }
      const bridge = deps.bridge();
      if (!bridge || !s.projectId || !s.file) {
        set({ message: 'Saving is not available here' });
        return false;
      }
      set({ saving: true });
      const file = BoundaryEditsFile.parse({ schema: 'aio.boundaries/1', edits });
      const r = await bridge
        .invoke('project:writeBoundaries', { projectId: s.projectId, file })
        .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      set({ saving: false });
      if (!r.ok) {
        set({ message: r.error ?? 'The boundary could not be saved' });
        return false;
      }
      set({ edits, piles: applyEdits(s.file, edits) });
      return true;
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
            base: file.defaultBase,
            density: file.densityTPerM3,
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
            if (pile !== get().selected && !get().edit) {
              set({ selected: pile, pileProfile: null });
              refreshPile();
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
        if (get().edit) {
          set({ message: 'Save or cancel the boundary edit first' });
          return;
        }
        set({ epoch, swipe: false, surface: get().surface === 'change' ? 'photo' : get().surface });
        showLayers();
        const pile = get().selected;
        if (pile) {
          const a = assetFor(pile);
          if (a) ws().select(a);
          refreshPile();
        }
      },

      setSwipe(on) {
        if (on && get().edit) {
          set({ message: 'Save or cancel the boundary edit first' });
          return;
        }
        set({ swipe: on, swipeX: 0.5 });
        showLayers();
      },

      setSwipeX(x) {
        set({ swipeX: Math.max(0.02, Math.min(0.98, x)) });
      },

      setBase(base) {
        set({ base });
        refreshPile();
        if (get().edit) void recomputeEdit();
      },

      setSurface(surface) {
        if (surface === 'change' && get().edit) {
          set({ message: 'Save or cancel the boundary edit first' });
          return;
        }
        set({ surface });
        if (surface === 'elev') ensureRelief();
        showLayers();
      },

      shownEpoch() {
        const s = get();
        return s.surface === 'change' ? (s.file?.captures.at(-1)?.epoch ?? s.epoch) : s.epoch;
      },

      setBody(body) {
        set({ body });
      },

      setDensity(density) {
        if (density > 0 && density < 5) set({ density });
      },

      setSort(key) {
        const s = get().sort;
        set({
          sort:
            s.key === key
              ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: key === 'id' ? 'asc' : 'desc' },
        });
      },

      select(pile, opts = {}) {
        if (get().edit) {
          set({ message: 'Save or cancel the boundary edit first' });
          return;
        }
        set({ selected: pile, pileProfile: null });
        if (!pile) {
          if (ws().selection?.kind === 'asset') ws().select(null);
          return;
        }
        const a = assetFor(pile);
        if (a) {
          ws().select(a);
          if (opts.fly !== false) ws().flyTo({ kind: 'selection', selection: a });
        }
        refreshPile();
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
        if (get().edit) {
          set({ message: 'Save or cancel the boundary edit first' });
          return;
        }
        set({ section: { mode: 'picking', points: [], profile: null, busy: false } });
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
        set({ section: { mode: 'done', points, profile: null, busy: true } });
        const svc = get().service;
        if (!svc) return;
        try {
          const profile = await svc.section(a, b);
          if (get().section.points === points)
            set({ section: { mode: 'done', points, profile, busy: false } });
        } catch (e) {
          set({
            section: { mode: 'idle', points: [], profile: null, busy: false },
            message: e instanceof Error ? e.message : String(e),
          });
        }
      },

      clearSection() {
        set({ section: { mode: 'idle', points: [], profile: null, busy: false } });
      },

      async startEdit() {
        const s = get();
        if (s.readOnly) {
          set({ message: READ_ONLY });
          return;
        }
        const pile = s.piles.find((p) => p.id === s.selected);
        if (!pile) return;
        const epoch = s.epoch;
        const ep = pile.epochs[epoch];
        const src = ep?.ring ?? pile.zoneRing;
        const en = src.map((q) => localToEN(s.origin, q));
        const ring = pile.edited.includes(epoch) ? en : simplifyRing(en, 0.6);
        set({
          edit: {
            pile: pile.id,
            epoch,
            ring,
            hist: [],
            sel: -1,
            dirty: false,
            resetToAuto: false,
            live: null,
            busy: false,
          },
          surface: s.surface === 'change' ? 'photo' : s.surface,
          swipe: false,
          section: { mode: 'idle', points: [], profile: null, busy: false },
        });
        showLayers();
        await recomputeEdit();
      },

      async moveVertex(i, p) {
        const ed = get().edit;
        if (!ed || i < 0 || i >= ed.ring.length) return;
        const ring = ed.ring.map((q, k): EN => (k === i ? [p[0], p[1]] : q));
        await changeRing(ring, i);
      },

      async insertVertex(after, p) {
        const ed = get().edit;
        if (!ed) return;
        const ring = [...ed.ring];
        ring.splice(after + 1, 0, [p[0], p[1]]);
        await changeRing(ring, after + 1);
      },

      async deleteVertex(i) {
        const ed = get().edit;
        if (!ed || i < 0 || i >= ed.ring.length) return;
        if (ed.ring.length <= 3) {
          set({ message: 'A boundary needs at least three points' });
          return;
        }
        await changeRing(ed.ring.filter((_, k) => k !== i));
      },

      selectVertex(i) {
        const ed = get().edit;
        if (ed) set({ edit: { ...ed, sel: i } });
      },

      async undo() {
        const ed = get().edit;
        const prev = ed?.hist.at(-1);
        if (!ed || !prev) return;
        const hist = ed.hist.slice(0, -1);
        set({ edit: { ...ed, ring: prev, hist, sel: -1, dirty: hist.length > 0 } });
        await recomputeEdit();
      },

      async resetEdit() {
        const s = get();
        const ed = s.edit;
        const pile = s.piles.find((p) => p.id === ed?.pile);
        if (!ed || !pile) return;
        const auto = pile.auto[ed.epoch]?.ring ?? pile.zoneRing;
        await changeRing(auto.map((q) => localToEN(s.origin, q)));
        const now = get().edit;
        if (now) set({ edit: { ...now, resetToAuto: true } });
      },

      cancelEdit() {
        set({ edit: null });
      },

      async saveEdit() {
        const s = get();
        const ed = s.edit;
        if (!ed) return false;
        if (ed.resetToAuto) {
          const ok = await writeEdits(
            s.edits.filter((e) => !(e.pile === ed.pile && e.epoch === ed.epoch)),
          );
          if (ok) set({ edit: null, message: 'Back to the automatic boundary' });
          return ok;
        }
        if (!ed.live) await recomputeEdit();
        const live = get().edit?.live;
        if (!live) {
          set({ message: 'The volume of this line could not be computed' });
          return false;
        }
        const pile = s.piles.find((p) => p.id === ed.pile);
        const autoNet = pile?.auto[ed.epoch]?.volumes[s.file?.defaultBase ?? 'tin'].net ?? 0;
        const edit: BoundaryEdit = {
          pile: ed.pile,
          epoch: ed.epoch,
          ring: toLocal(ed.ring),
          volumes: live.result.volumes,
          areaM2: live.result.areaM2,
          topM: live.result.topM,
          heightM: live.result.heightM,
          autoNet,
          updatedAt: deps.now(),
        };
        const edits = [
          ...s.edits.filter((e) => !(e.pile === ed.pile && e.epoch === ed.epoch)),
          edit,
        ];
        const ok = await writeEdits(edits);
        if (ok) {
          const net = Math.round(live.result.volumes[s.base].net).toLocaleString('en-US');
          set({ edit: null, message: `Boundary saved, ${net} m³` });
        }
        return ok;
      },

      async revert(pile, epoch) {
        if (get().readOnly) {
          set({ message: READ_ONLY });
          return false;
        }
        const ok = await writeEdits(
          get().edits.filter((e) => !(e.pile === pile && e.epoch === epoch)),
        );
        if (ok) set({ message: 'Back to the automatic boundary' });
        return ok;
      },

      async exportCsv() {
        const s = get();
        const bridge = deps.bridge();
        if (!s.file || !bridge) return;
        const data = registerCsv(s.file, s.piles, s.density);
        const name = `${
          s.projectName
            .replace(/[\\/:*?"<>|]+/g, ' ')
            .replace(/\s+stockpiles?$/i, '')
            .trim() || 'Project'
        } stockpile register.csv`;
        const r = await bridge
          .invoke('dialog:saveFile', {
            defaultName: name,
            data,
            title: 'Export the stockpile register',
          })
          .catch((e: unknown) => ({
            path: null,
            error: e instanceof Error ? e.message : String(e),
          }));
        if (r.error) set({ message: r.error });
        else if (r.path) set({ message: `Saved ${r.path}` });
      },

      setMessage(message) {
        set({ message });
      },

      setReadOnly(on) {
        if (on && get().edit) get().cancelEdit();
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
  bridge: appBridge,
  now: () => new Date().toISOString(),
  prefs: localPrefStore(),
});

export function useVolumetric<T>(selector: (s: Volumetric) => T): T {
  return useStore(volumetric, selector);
}
