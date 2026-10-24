import { fitWalk, walkHeadingAt, type WalkFit, type XZ } from '@aio/geo';
import type { MapOverlay, MapPointerSession } from '@aio/maps';
import {
  readWalkOrientationData,
  shiftLocal,
  unshiftLocal,
  WalkOrientation,
  WalkRawPath,
  type AssetRef,
  type DateShift,
  type JobRecord,
  type LayerPatch,
  type ProjectManifest,
  type Vec3,
  type WalkLayer,
} from '@aio/schema';
import { t } from '@aio/ui';
import {
  assetUrl,
  captureIndex,
  dateShiftOf,
  dateTags,
  useWorkspace,
  workspace,
  type OpenProject,
} from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useMap } from '../builder/activeViews';
import { builder } from '../builder/state';
import { newSurveyDate, setLayersCapture } from '../change/SurveyDate';
import { localToLonLat } from '../change/draw';
import { drawings } from '../drawings/store';
import { jobs, shell } from '../shell';
import type { StageMode } from '../store';
import {
  PANE_KINDS,
  resolveSplit,
  sideOf,
  type PaneKind,
  type SplitPref,
} from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import {
  dateChoices,
  placeSurfaces,
  rememberedSurface,
  SCENE_SURFACE,
  surfaceFramesOf,
  walkPathState,
  type DrawingLookup,
  type PlaceSurface,
  type WalkPathState,
} from './placeModel';
import { createPlaceStore, handlePins, type PlaceHandle, type PlaceState } from './placeStore';
import { walkMap, setWalkMapOverlays, setWalkMapPointer } from './walkMapStore';
import {
  MapBeamMarkers,
  resolveCssColour,
  walkBeamMarker,
  walkMapOverlays,
  walkNowMapOverlay,
  walkPreviewMapOverlay,
  type BeamMarker,
} from './walkMapOverlay';
import {
  walkDrawingsForSheet,
  walkNowOnSheet,
  walkShown,
  type SheetWalk,
  type WalkDrawing,
  type WalkNow,
} from './walkOverlay';
import { comparedWalks, walkCompare } from './walkCompare';
import { walkViews, type WalkViewNow } from './walkView';
import { jobForWalk, splitWithWalk } from './walkModel';
import {
  locateOriginal,
  processWalk,
  setPlaceWalkHandler,
  setRemovePlacementHandler,
  walks,
} from './walks';
import { walkFolderId, walkRecordKey } from './walkStore';

/*
 * Place walk, wired (design "Walk placing by start and end"): `placeWalk(layerId)` shows the
 * surface (the map or the 3D view fill the stage, a drawing sits beside the 3D view), reads the
 * walk's raw path and orientation, and starts the session (`placeStore.ts`): the path check when
 * the walk has no usable path, else Start. Fine-tune puts the 360 video beside the surface. The
 * toolbar (`PlaceWalkStrip.tsx`) sits over the surface; Save applies the survey date field, then
 * sends the calibration through `builder.saveLayers`, whose answer (the manifest with the pose
 * written) updates the walk's row. Remove placement sends `{ walk: null }`.
 */

/** What the live fit needs from the walk's folder; null parts: not there or unreadable. */
export interface WalkInputs {
  raw: WalkRawPath | null;
  orientation: Float64Array[] | null;
}

const NO_INPUTS: WalkInputs = { raw: null, orientation: null };

/**
 * The orientation data file the header names (`data`, a plain file name), next to the header, as
 * main reads it; undefined for a header that is not a path (the layer's `orientationData` then).
 */
export function orientationDataRef(header: AssetRef, data: string): AssetRef | undefined {
  if (!('path' in header)) return undefined;
  const p = header.path.replaceAll('\\', '/');
  const slash = p.lastIndexOf('/');
  return { path: slash < 0 ? data : `${p.slice(0, slash)}/${data}` };
}

/**
 * Read the walk's `raw-path.json` and orientation records through the project's asset URLs. A
 * file that is missing, unreadable or of a newer schema reads as absent: the walk is then placed
 * pins-only (main's project log names the bad file when it writes the pose).
 */
export async function loadWalkInputs(
  projectId: string,
  layer: WalkLayer,
  get: (url: string) => Promise<Response> = (url) => fetch(url, { cache: 'no-store' }),
): Promise<WalkInputs> {
  const refs = layer.path;
  if (!refs) return NO_INPUTS;
  const json = async (ref: AssetRef): Promise<unknown> => {
    const r = await get(assetUrl(projectId, ref));
    return r.ok ? ((await r.json()) as unknown) : null;
  };
  let raw: WalkRawPath | null;
  try {
    const parsed = WalkRawPath.safeParse(await json(refs.raw));
    raw = parsed.success ? parsed.data : null;
  } catch {
    raw = null;
  }
  let orientation: Float64Array[] | null = null;
  if (refs.orientation) {
    try {
      const header = WalkOrientation.safeParse(await json(refs.orientation));
      const data = header.success
        ? (orientationDataRef(refs.orientation, header.data.data) ?? refs.orientationData)
        : undefined;
      if (header.success && data) {
        const r = await get(assetUrl(projectId, data));
        if (r.ok)
          orientation = readWalkOrientationData(header.data, new Uint8Array(await r.arrayBuffer()));
      }
    } catch {
      orientation = null;
    }
  }
  return { raw, orientation };
}

/** What the strip around the session shows: where it sits and what it is doing. */
export interface PlaceUi {
  /** The walk being placed (null: Place walk is closed). */
  layerId: string | null;
  /** The surface pane the strip sits over (null: none can be offered, the strip sits in the 360 pane). */
  host: PlaceSurface | null;
  inputs: WalkInputs;
  saving: boolean;
  /** Closing with unsaved pins: the strip asks "Keep these pins?". */
  asking: boolean;
  note: string | null;
  /** The latest seek the 360 pane should make (`n` tells two seeks to one time apart). */
  seek: { t: number; n: number } | null;
  /** Place walk was asked for another walk while this one has unsaved pins: it waits for the answer. */
  pending: string | null;
  /** The survey date field: a capture id, `add:YYYY-MM-DD`, or null (save undated). */
  date: string | null;
  /** Fine-tune shows the 360 video beside the surface. */
  fineTune: boolean;
}

const CLOSED: PlaceUi = {
  layerId: null,
  host: null,
  inputs: NO_INPUTS,
  saving: false,
  asking: false,
  note: null,
  seek: null,
  pending: null,
  date: null,
  fineTune: false,
};

export function createPlaceUi(): StoreApi<PlaceUi> {
  return createStore<PlaceUi>()(() => ({ ...CLOSED }));
}

/** The session store with its seeks sent to the 360 pane through `ui`. */
export function createPlaceSession(ui: StoreApi<PlaceUi>): StoreApi<PlaceState> {
  return createPlaceStore({
    fit: fitWalk,
    seek: (time) => {
      ui.setState((s) => ({ seek: { t: time, n: (s.seek?.n ?? 0) + 1 } }));
    },
  });
}

/** What the flow needs from the app (tests give their own). */
export interface PlaceWalkDeps {
  project(): OpenProject | null;
  drawings: DrawingLookup;
  loadInputs(projectId: string, layer: WalkLayer): Promise<WalkInputs>;
  /**
   * Show `host` for placing (the map or 3D fill the stage; a drawing beside the 3D view), with the
   * 360 video beside it when `fineTune`.
   */
  openSurface(layerId: string, host: PlaceSurface, fineTune: boolean): void;
  /** `builder.saveLayers`: null when saved (the manifest is replaced), else why not. */
  save(layerId: string, patch: LayerPatch): Promise<string | null>;
  /** `builder:ensureCapture` for a day; the manifest is replaced. */
  ensureCapture(day: string): Promise<{ captureId: string } | { error: string }>;
  /** `LayerPatch { capture }` on one layer; the manifest is replaced. */
  setCapture(layerId: string, captureId: string): Promise<string | null>;
  /** When the camera says the walk was filmed (`walk.json`), if it says. */
  capturedAt(layer: WalkLayer): string | undefined;
  /** The walk's newest `walk.process` job (its id tells a new run from the last one). */
  job(layer: WalkLayer): (Pick<JobRecord, 'status' | 'progress'> & { id?: string }) | undefined;
  /** What the stage shows of the model now: the map or the 3D view. */
  modelSurface(): 'map' | '3d';
  /** Process walk from the notice: null when started, else why not. */
  process(layer: WalkLayer): Promise<string | null>;
}

/** One choice of the survey date field. */
export interface DateChoice {
  id: string;
  /** The survey date as people read it (`12 Oct 2026`), with the capture's label. */
  label: string;
  colour: string;
}

export const hasCrs = (m: Pick<ProjectManifest, 'crs'>): boolean => 'epsg' in m.crs;

export interface PlaceWalkFlow {
  begin(layerId: string): Promise<void>;
  /** The walk being placed, as the open manifest has it now. */
  walk(): WalkLayer | null;
  surfaces(): PlaceSurface[];
  /** The project's orthomosaic layers (what the map draws of its own imagery under the pins). */
  orthos(): string[];
  /** The date field's choices: the project's dates (the `capturedAt` one first), and a day to add. */
  dates(): { pick: DateChoice[]; add?: string };
  /** The date field: a capture id, `add:YYYY-MM-DD`, or null (save undated). */
  setDate(value: string | null): void;
  chooseSurface(s: PlaceSurface): void;
  /** Where the walk's computed path stands (the check's notice). */
  pathState(): WalkPathState;
  /** Process walk from the check's notice; why not shows in the note. */
  process(): Promise<void>;
  /** The check's Place between two points anyway. */
  placeAnyway(): void;
  /** Fine-tune on (from placed, the 360 video beside the surface) or off. */
  fineTune(on: boolean): void;
  save(): Promise<void>;
  /** Remove the saved placement of `layerId` (the walk being placed when absent); null when done. */
  removePlacement(layerId?: string): Promise<string | null>;
  /** Close the strip: asks first when there are unsaved pins. */
  close(): void;
  /** Leave the walk as it was (then place the walk that was waiting, if one was). */
  discard(): void;
  /** Back to placing from the question. */
  keepPlacing(): void;
  /**
   * The walk being placed is no longer in the project (removed from the sidebar, or any other
   * way): drop its session, so its path and pins leave the surface and nothing waits on it.
   */
  dropIfGone(): void;
  /**
   * The walk's path may have changed (other files named, or its `walk.process` job started,
   * finished or failed: a reprocess rewrites the same file names): read it again into the session.
   */
  pathChanged(): Promise<void>;
}

export function createPlaceWalk(
  deps: PlaceWalkDeps,
  session: StoreApi<PlaceState>,
  ui: StoreApi<PlaceUi>,
): PlaceWalkFlow {
  let begun = 0;
  /** What the session's path was last read for (`pathKeyOf`); null: none open. */
  let pathKey: string | null = null;
  /**
   * The path's files and the walk's newest `walk.process` run and its status: a reprocess writes
   * the same file names, so only the job tells that the files were written again.
   */
  const pathKeyOf = (w: WalkLayer): string => {
    const job = deps.job(w);
    return JSON.stringify([w.path ?? null, job?.id ?? null, job?.status ?? null]);
  };
  /** The walks with a Save or a Remove placement on its way: one write at a time per walk. */
  const writing = new Set<string>();
  const walkOf = (): WalkLayer | null => {
    const id = ui.getState().layerId;
    const m = deps.project()?.manifest;
    return m?.layers.find((l): l is WalkLayer => l.kind === 'walk' && l.id === id) ?? null;
  };
  const surfacesOf = (): PlaceSurface[] => {
    const m = deps.project()?.manifest;
    const w = walkOf();
    return m && w ? placeSurfaces(m, w, hasCrs(m)) : [];
  };
  const reset = (): void => {
    session.getState().cancel();
    pathKey = null;
    ui.setState({ ...CLOSED });
  };
  /** After the answer to "Keep these pins?": the walk that was waiting is placed next. */
  const next = (): void => {
    const waiting = ui.getState().pending;
    reset();
    if (waiting) void begin(waiting);
  };

  const dates = (): { pick: DateChoice[]; add?: string } => {
    const m = deps.project()?.manifest;
    const w = walkOf();
    if (!m || !w) return { pick: [] };
    const { pick, add } = dateChoices(w, m.captures, deps.capturedAt(w));
    const tags = dateTags(m.captures);
    const choices = pick.flatMap((id): DateChoice[] => {
      const c = m.captures.find((x) => x.id === id);
      const tag = tags[id];
      if (!c || !tag) return [];
      const label = c.label && c.label !== tag.long ? `${tag.long}, ${c.label}` : tag.long;
      return [{ id, label, colour: tag.colour }];
    });
    return add === undefined ? { pick: choices } : { pick: choices, add };
  };

  /** The date field's first value: the walk's own date, else the first choice, else the day to add. */
  const defaultDate = (w: WalkLayer): string | null => {
    if (w.capture !== undefined) return w.capture;
    const d = dates();
    const first = d.pick[0];
    if (first) return first.id;
    return d.add === undefined ? null : `add:${d.add}`;
  };

  /** Apply the date field to an undated walk before Save: null when done, else why not. */
  const applyDate = async (layerId: string): Promise<string | null> => {
    const w = walkOf();
    const value = ui.getState().date;
    if (!w || w.capture !== undefined || value === null) return null;
    let captureId = value;
    if (value.startsWith('add:')) {
      const made = await deps.ensureCapture(value.slice(4));
      if ('error' in made) return made.error;
      captureId = made.captureId;
    }
    const error = await deps.setCapture(layerId, captureId);
    if (error) return error;
    session.getState().setDate(captureId);
    return null;
  };

  const begin = async (layerId: string): Promise<void> => {
    const project = deps.project();
    const layer = project?.manifest.layers.find(
      (l): l is WalkLayer => l.kind === 'walk' && l.id === layerId,
    );
    if (!project || !layer) return;
    const cur = ui.getState();
    if (cur.layerId === layerId && session.getState().layerId === layerId) {
      if (cur.host) deps.openSurface(layerId, cur.host, cur.fineTune);
      return;
    }
    // unsaved pins on another walk: ask first, place this one after the answer
    if (
      cur.layerId !== null &&
      session.getState().layerId === cur.layerId &&
      session.getState().dirty
    ) {
      ui.setState({ asking: true, pending: layerId });
      if (cur.host) deps.openSurface(cur.layerId, cur.host, cur.fineTune);
      return;
    }
    const ask = ++begun;
    session.getState().cancel();
    pathKey = null;
    const list = placeSurfaces(project.manifest, layer, hasCrs(project.manifest));
    const host = rememberedSurface(layer, list, deps.modelSurface()) ?? list[0] ?? SCENE_SURFACE;
    ui.setState({ ...CLOSED, layerId, host });
    // the field reads the walk through `ui`, so it is set once the walk is there
    ui.setState({ date: defaultDate(layer) });
    deps.openSurface(layerId, host, false);
    // the key of what is read now: a change while it reads is read again after the start
    const readFor = pathKeyOf(layer);
    const inputs = await deps.loadInputs(project.id, layer);
    // a newer Place walk (or a close) came first
    if (ask !== begun || ui.getState().layerId !== layerId) return;
    const m = deps.project()?.manifest ?? project.manifest;
    const now = m.layers.find((l): l is WalkLayer => l.kind === 'walk' && l.id === layerId);
    if (!now) {
      reset();
      return;
    }
    pathKey = readFor;
    ui.setState({ inputs });
    session.getState().start(now, m, {
      raw: inputs.raw,
      drawings: deps.drawings,
      orientation: inputs.orientation,
      ready: walkPathState(now, deps.job(now), inputs.raw) === 'ready',
    });
    session.getState().chooseSurface(host);
    await pathChanged();
  };

  const pathChanged = async (): Promise<void> => {
    const w = walkOf();
    const project = deps.project();
    // only an open session (its files read once) follows its path
    if (!w || !project || pathKey === null || session.getState().layerId !== w.id) return;
    const key = pathKeyOf(w);
    if (key === pathKey) return;
    pathKey = key;
    const inputs = await deps.loadInputs(project.id, w);
    // another walk, a close, or a newer change came first
    if (ui.getState().layerId !== w.id || pathKey !== key) return;
    const now = walkOf() ?? w;
    ui.setState({ inputs });
    session
      .getState()
      .setInputs(
        inputs.raw,
        inputs.orientation,
        walkPathState(now, deps.job(now), inputs.raw) === 'ready',
      );
  };

  return {
    begin,
    walk: walkOf,
    surfaces: surfacesOf,
    orthos: () =>
      (deps.project()?.manifest.layers ?? []).flatMap((l) =>
        l.kind === 'raster' && l.role === 'ortho' ? [l.id] : [],
      ),
    dates,
    setDate: (value) => {
      ui.setState({ date: value });
    },
    chooseSurface: (s) => {
      const id = ui.getState().layerId;
      if (!id) return;
      ui.setState({ host: s, note: null });
      deps.openSurface(id, s, ui.getState().fineTune);
      session.getState().chooseSurface(s);
    },
    pathState: () => {
      const w = walkOf();
      return w ? walkPathState(w, deps.job(w), ui.getState().inputs.raw) : 'none';
    },
    process: async () => {
      const w = walkOf();
      if (!w) return;
      ui.setState({ note: null });
      const error = await deps.process(w);
      if (error && ui.getState().layerId === w.id) ui.setState({ note: error });
    },
    placeAnyway: () => {
      session.getState().placeAnyway();
    },
    fineTune: (on) => {
      const { host, layerId: id } = ui.getState();
      if (!id || !host) return;
      session.getState().setFineTune(on);
      ui.setState({ fineTune: on && session.getState().step === 'fine-tune' });
      deps.openSurface(id, host, ui.getState().fineTune);
    },
    save: async () => {
      const id = ui.getState().layerId;
      const st = session.getState();
      if (!id || st.layerId !== id || ui.getState().saving) return;
      // a Remove placement on its way: saving now could bring the placement back, or lose it
      if (writing.has(id)) {
        ui.setState({ note: t('walk.place.busy') });
        return;
      }
      // a pin waiting to be moved lets go: a move made while saving would not be saved
      if (st.armed === 'move' && st.moving !== null) st.armMove(st.moving);
      ui.setState({ saving: true, note: null, asking: false });
      writing.add(id);
      let error: string | null;
      try {
        // the survey date field first, so a walk without a date never blocks placing
        error = await applyDate(id);
        if (!error && ui.getState().layerId === id)
          error = await deps.save(id, { walk: session.getState().calibration() });
      } finally {
        writing.delete(id);
      }
      if (ui.getState().layerId !== id) return;
      if (error) {
        ui.setState({ saving: false, note: error });
        return;
      }
      next();
    },
    removePlacement: async (layerId) => {
      const id = layerId ?? ui.getState().layerId;
      if (!id) return null;
      // a Save (or another Remove) of this walk on its way: one write at a time
      if (writing.has(id)) return t('walk.place.busy');
      writing.add(id);
      let error: string | null;
      try {
        error = await deps.save(id, { walk: null });
      } finally {
        writing.delete(id);
      }
      if (!error && ui.getState().layerId === id) reset();
      return error;
    },
    close: () => {
      if (session.getState().dirty) ui.setState({ asking: true });
      else reset();
    },
    discard: next,
    keepPlacing: () => {
      ui.setState({ asking: false, pending: null });
    },
    dropIfGone: () => {
      if (ui.getState().layerId !== null && !walkOf()) next();
    },
    pathChanged,
  };
}

// ---------- what the walk being placed draws, and where ----------

/** The walk's survey date colour (`var(--date-N)`), or the accent for an undated walk. */
export function walkColour(
  m: Pick<ProjectManifest, 'captures' | 'layers'>,
  layer: WalkLayer,
): string {
  const c = captureIndex(m).of[layer.id];
  return (c ? dateTags(m.captures)[c]?.colour : undefined) ?? 'var(--acc)';
}

/** The camera's heading for the 360 view's north tick (yaw offset included), or null. */
export function viewHeading(
  fit: WalkFit | null,
  orientation: readonly Float64Array[] | null,
  yawOffsetDeg: number,
  time: number,
): number | null {
  if (!fit) return null;
  const h = walkHeadingAt(fit, orientation, time) ?? fit.at(time)?.headingRad ?? null;
  return h === null ? null : h + (yawOffsetDeg * Math.PI) / 180;
}

/**
 * The session wants the next click on the surface: Start and End, or in fine-tune an armed pin,
 * a pin moved, or Align view's second click. A placed walk ignores plain clicks (its handles drag).
 */
export function wantsSurfaceClick(s: Pick<PlaceState, 'step' | 'armed'>): boolean {
  return (
    s.step === 'start' ||
    s.step === 'end' ||
    (s.step === 'fine-tune' &&
      (s.armed === 'pin' || s.armed === 'move' || s.armed === 'align-surface'))
  );
}

/**
 * The Start and End handles of a placed walk (placed or fine-tune): the first and the last active
 * pin by time, at their model x/z, with the pin's height when it has one. Empty otherwise.
 */
export function sessionHandles(
  s: Pick<PlaceState, 'step' | 'fit' | 'pins'>,
): { handle: PlaceHandle; xz: XZ; y: number | null }[] {
  if ((s.step !== 'placed' && s.step !== 'fine-tune') || !s.fit) return [];
  const shown = handlePins(s.fit);
  if (!shown) return [];
  const at = (handle: PlaceHandle, pin: typeof shown.start) => ({
    handle,
    xz: [pin.target[0], pin.target[1]] as XZ,
    y: s.pins[pin.index]?.y ?? null,
  });
  return [at('start', shown.start), at('end', shown.end)];
}

/*
 * The walks' map overlays come from two writers: the placed walks (`setPlacedMapOverlays`, from
 * the stage) and the session placing a walk on the map (`followMap`). Both go out together.
 */
let placedMap: readonly MapOverlay[] = [];
let sessionMap: readonly MapOverlay[] = [];
const publishMap = (): void => {
  setWalkMapOverlays([...placedMap, ...sessionMap]);
};

/** The placed walks' map overlays (every visible, placed walk at 60 %). */
export function setPlacedMapOverlays(overlays: readonly MapOverlay[]): void {
  if (overlays.length === 0 && placedMap.length === 0) return;
  placedMap = overlays;
  publishMap();
}

/**
 * Keep the main map in step with a walk placed on the map: its path, stills and pins once placed
 * (an inactive pin says why on hover), the current position apart, the hover preview while Start
 * or End waits, and one pointer session (hover, clicks, the Start and End handles) for as long as
 * the session is on the map. Returns the unsubscribe.
 */
export function followMap(
  session: StoreApi<PlaceState>,
  ui: StoreApi<PlaceUi>,
  project: () => OpenProject | null,
): () => void {
  let pathFor: {
    fit: WalkFit | null;
    layer: WalkLayer | null;
    shift: DateShift | null;
    overlay: MapOverlay | null;
  } = { fit: null, layer: null, shift: null, overlay: null };
  let shown = false;
  const sessionShift = (layerId: string | null): DateShift | null => {
    const m = project()?.manifest;
    return m && layerId !== null ? dateShiftOf(m, layerId) : null;
  };
  /** A pick on the map as model x/z of the walk's own frame (the writer subtracts the shift). */
  const pickedAt = (local: Vec3): [number, number] => {
    const p = unshiftLocal(local, sessionShift(session.getState().layerId));
    return [p[0], p[2]];
  };
  // one object for the life of the session: the map cancels a drag when its session is replaced
  const pointer: MapPointerSession = {
    // the map shows the walk where its date lies: a pick is saved without the shift, a handle
    // is drawn with it
    onMove: (local) => {
      const at = local ? pickedAt(local) : null;
      session.getState().hover(at, local?.[1]);
    },
    onClick: (local) => {
      if (wantsSurfaceClick(session.getState()))
        session.getState().click(pickedAt(local), local[1]);
    },
    handles: () => {
      const shift = sessionShift(session.getState().layerId);
      return sessionHandles(session.getState()).map((h) => ({
        id: h.handle,
        local: shiftLocal([h.xz[0], h.y ?? 0, h.xz[1]], shift),
      }));
    },
    onDrag: (id, local) => {
      if (id === 'start' || id === 'end')
        session.getState().dragHandle(id, pickedAt(local), local[1]);
    },
    onDragEnd: () => {
      session.getState().endDrag();
    },
    onCancel: () => {
      const s = session.getState();
      if (s.armed === 'move' && s.moving !== null) s.armMove(s.moving);
    },
  };
  const clear = (): void => {
    if (shown) {
      sessionMap = [];
      publishMap();
    }
    shown = false;
    pathFor = { fit: null, layer: null, shift: null, overlay: null };
    if (walkMap.getState().pointer === pointer) setWalkMapPointer(null);
  };
  const update = (): void => {
    const s = session.getState();
    const p = project();
    const layer =
      p?.manifest.layers.find((l): l is WalkLayer => l.kind === 'walk' && l.id === s.layerId) ??
      null;
    const toLonLat = p ? localToLonLat(p.manifest) : null;
    if (!p || !layer || s.surface?.kind !== 'map' || !toLonLat || !s.fit) {
      clear();
      return;
    }
    const proj = { toLonLat };
    const colour = (l: WalkLayer): string => resolveCssColour(walkColour(p.manifest, l));
    const raw = ui.getState().inputs.raw;
    const shift = dateShiftOf(p.manifest, layer.id);
    // from the start click on: a lone start pin stays drawn while the cursor is off the map
    if (s.pins.length === 0) pathFor = { fit: null, layer: null, shift: null, overlay: null };
    else if (pathFor.fit !== s.fit || pathFor.layer !== layer || pathFor.shift !== shift) {
      const shownLayer = { ...layer, visible: true };
      const [ov] = walkMapOverlays([{ layer: shownLayer, fit: s.fit, raw, shift }], proj, colour, {
        placingId: layer.id,
      });
      pathFor = {
        fit: s.fit,
        layer,
        shift,
        overlay: ov
          ? {
              ...ov,
              tooltip: (props) =>
                props.kind === 'pin' && props.active === false ? t('walk.pin.gone') : null,
            }
          : null,
      };
    }
    const now = walkNowMapOverlay({ layer, fit: s.fit, raw, shift }, proj, colour, s.timeS);
    const preview = s.preview
      ? walkPreviewMapOverlay(
          layer.id,
          s.preview.xz,
          proj,
          colour(layer),
          s.preview.ghost,
          s.preview.tooClose,
          shift,
        )
      : null;
    sessionMap = [pathFor.overlay, now, preview].filter((o): o is MapOverlay => o !== null);
    publishMap();
    shown = true;
    setWalkMapPointer(pointer);
  };
  return session.subscribe(update);
}

// ---------- the app's instance ----------

/**
 * Where the stage shows `host` for placing: the map and 3D fill the stage; a drawing shows in the
 * split beside the 3D view (never beside the 360 video); fine-tune puts the 360 video beside the
 * surface.
 */
export function surfaceLayout(
  saved: SplitPref | undefined,
  host: PlaceSurface,
  fineTune: boolean,
): { mode: StageMode; split?: SplitPref } {
  const kind: PaneKind = host.kind === 'drawing' ? 'raster' : host.kind;
  const raster = host.kind === 'drawing' ? { raster: host.id } : {};
  if (fineTune) {
    const withWalk = splitWithWalk(saved, PANE_KINDS);
    const other = sideOf(withWalk, 'walk360') === 'left' ? 'right' : 'left';
    return { mode: 'split', split: { ...withWalk, [other]: kind, ...raster } };
  }
  if (host.kind !== 'drawing') return { mode: host.kind };
  // a drawing shows only in the split, always beside the 3D view (never the 360 video or the map)
  const sides = resolveSplit(saved, PANE_KINDS);
  const side = sideOf(sides, 'raster') ?? 'left';
  const other = side === 'left' ? 'right' : 'left';
  return {
    mode: 'split',
    split: { ...sides, [side]: 'raster', [other]: '3d', raster: host.id },
  };
}

function openSurface(layerId: string, host: PlaceSurface, fineTune: boolean): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(layerId);
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  const { mode, split } = surfaceLayout(saved, host, fineTune);
  if (split) stagePrefs.getState().update(project.id, { split });
  if (sh.stageMode !== mode) sh.setStageMode(mode);
}

/** What the stage shows of the model now: the map (full or on a side of the split), else 3D. */
function modelSurface(): 'map' | '3d' {
  const sh = shell.getState();
  if (sh.stageMode === 'map') return 'map';
  if (sh.stageMode !== 'split') return '3d';
  const id = workspace.getState().project?.id;
  const saved = id === undefined ? undefined : stagePrefs.getState().byProject[id]?.split;
  const sides = resolveSplit(saved, PANE_KINDS);
  return sides.left === 'map' || sides.right === 'map' ? 'map' : '3d';
}

/** Process walk from the check: a stitched video starts at once, a camera file asks for its original. */
async function processFromCheck(l: WalkLayer): Promise<string | null> {
  const record = walks.getState().records[walkRecordKey(l)];
  if (!record) return t('walk.place.notListed');
  if (record.source.layout === 'equirect') return processWalk(l.id, { walk: walkFolderId(l) });
  const r = await locateOriginal(record);
  if (!r) return null;
  if ('error' in r) return r.error;
  return processWalk(l.id, { walk: walkFolderId(l), src: [r.path] });
}

export const placeUi = createPlaceUi();
export const placeSession = createPlaceSession(placeUi);

export const placeFlow = createPlaceWalk(
  {
    project: () => workspace.getState().project,
    drawings: (id) => drawings.getState().placed[id],
    loadInputs: (projectId, layer) => loadWalkInputs(projectId, layer),
    openSurface,
    save: (layerId, patch) => builder.getState().saveLayers([layerId], patch),
    ensureCapture: newSurveyDate,
    setCapture: (layerId, captureId) => setLayersCapture([layerId], captureId),
    capturedAt: (layer) => walks.getState().records[walkRecordKey(layer)]?.source.capturedAt,
    job: (l) => {
      const root = workspace.getState().project?.root;
      return root === undefined
        ? undefined
        : jobForWalk(jobs.getState().jobs, root, walkFolderId(l));
    },
    modelSurface,
    process: processFromCheck,
  },
  placeSession,
  placeUi,
);

followMap(placeSession, placeUi, () => workspace.getState().project);

// another project (or none): the session belongs to the one it was opened in
let openedIn: string | null = workspace.getState().project?.id ?? null;
workspace.subscribe((s) => {
  const id = s.project?.id ?? null;
  if (id === openedIn) return;
  openedIn = id;
  if (placeUi.getState().layerId !== null) placeFlow.discard();
});

// the walk being placed was removed (any way it goes): its session and its pins go with it; a
// path written (or gone) since it opened is read again
workspace.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  placeFlow.dropIfGone();
  void placeFlow.pathChanged();
});

// the walk's walk.process job started, finished or failed: its path is read again
jobs.subscribe(() => {
  void placeFlow.pathChanged();
});

setPlaceWalkHandler((layerId) => {
  void placeFlow.begin(layerId);
});

setRemovePlacementHandler((id) => placeFlow.removePlacement(id));

/** A walk is being placed on this surface kind (the stage shows its pointer layer). */
export function usePlacingOn(kind: 'map' | '3d'): boolean {
  return useStore(placeUi, (s) => s.layerId !== null && s.host?.kind === kind);
}

// ---------- placed walks: drawn on every surface, outside placing too ----------

/**
 * What the inputs of a placed walk are read for: the files it names, and its pose and pins. A
 * reprocess rewrites the raw path under the same name, and main then rewrites the pose (a new
 * `flight` or quality on the layer), so a changed pose or placement reads the files again.
 */
export const inputsKey = (projectId: string, walk: WalkLayer): string =>
  `${projectId}|${walk.id}|${JSON.stringify(walk.path ?? null)}|${JSON.stringify(walk.flight ?? null)}|${JSON.stringify(walk.place ?? null)}`;

/** The inputs of placed walks (by layer id), read once per `inputsKey`; `clear` forgets them all. */
export function createInputsCache(
  load: (projectId: string, walk: WalkLayer) => Promise<WalkInputs>,
) {
  const cache = new Map<string, { key: string; inputs: Promise<WalkInputs> }>();
  return {
    get(projectId: string, walk: WalkLayer): Promise<WalkInputs> {
      const key = inputsKey(projectId, walk);
      let cached = cache.get(walk.id);
      if (cached?.key !== key) {
        cached = { key, inputs: load(projectId, walk) };
        cache.set(walk.id, cached);
      }
      return cached.inputs;
    },
    clear(): void {
      cache.clear();
    },
  };
}

const inputsCache = createInputsCache((projectId, walk) => loadWalkInputs(projectId, walk));
const cachedInputs = (projectId: string, walk: WalkLayer) => inputsCache.get(projectId, walk);

// another project (or the same one opened again from another folder): read everything afresh
let inputsProject: string | null = projectCacheKey(workspace.getState().project);
workspace.subscribe((s) => {
  const now = projectCacheKey(s.project);
  if (now === inputsProject) return;
  inputsProject = now;
  inputsCache.clear();
});

function projectCacheKey(p: OpenProject | null | undefined): string | null {
  return p ? `${p.id}|${p.root}` : null;
}

/** The walks with a saved placement that fits (not `unplaced`). */
export function placedWalks(m: Pick<ProjectManifest, 'layers'>): WalkLayer[] {
  return m.layers.filter(
    (l): l is WalkLayer =>
      l.kind === 'walk' && l.place !== undefined && l.place.quality !== 'unplaced',
  );
}

/**
 * The live fits of the placed walks whose inputs are read (`inputsOf` undefined: not yet), from
 * their saved pins and the drawings as they lie now (a moved drawing moves its walks).
 */
export function placedWalkFits(
  m: ProjectManifest,
  inputsOf: (layer: WalkLayer) => WalkInputs | undefined,
  lookup: DrawingLookup,
): SheetWalk[] {
  const frames = surfaceFramesOf(m, lookup);
  return placedWalks(m).flatMap((layer): SheetWalk[] => {
    const inputs = inputsOf(layer);
    if (!inputs || !layer.place) return [];
    const fit = fitWalk(inputs.raw, layer.place, frames, layer.durationS);
    return fit.error ? [] : [{ layer, fit, raw: inputs.raw, shift: dateShiftOf(m, layer.id) }];
  });
}

/**
 * The walks drawn on one drawing (`sheetId`): every visible, placed walk, and the walk being
 * placed on it (`placing`, its live fit in place of its saved one, shown even when switched off).
 */
export function walksOnSheet(
  m: ProjectManifest,
  sheetId: string,
  placed: readonly SheetWalk[],
  lookup: DrawingLookup,
  opts: {
    placing?: SheetWalk | null;
    hidden?: ReadonlySet<string>;
    size?: { width: number; height: number } | undefined;
  } = {},
): WalkDrawing[] {
  const frame = surfaceFramesOf(m, lookup).drawing(sheetId);
  if (!frame) return [];
  const placing = opts.placing ?? null;
  const list = placed.filter((w) => w.layer.id !== placing?.layer.id);
  let hidden = opts.hidden;
  if (placing) {
    list.push({ ...placing, layer: { ...placing.layer, visible: true } });
    if (hidden?.has(placing.layer.id))
      hidden = new Set([...hidden].filter((id) => id !== placing.layer.id));
  }
  return walkDrawingsForSheet(list, frame, (l) => walkColour(m, l), {
    placingId: placing?.layer.id ?? null,
    ...(hidden ? { hidden } : {}),
    ...(opts.size ? { size: opts.size } : {}),
  });
}

/**
 * The placed walks on the map (only with a coordinate system): one overlay per visible, placed
 * walk at 60 %, leaving out `except` (the walk a session is placing on the map draws itself).
 */
export function placedMapOverlays(
  m: ProjectManifest,
  placed: readonly SheetWalk[],
  hidden: ReadonlySet<string>,
  except: string | null,
): MapOverlay[] {
  const toLonLat = localToLonLat(m);
  if (!toLonLat) return [];
  return walkMapOverlays(
    placed.filter((w) => w.layer.id !== except),
    { toLonLat },
    (l) => resolveCssColour(walkColour(m, l)),
    { placingId: null, hidden },
  );
}

/** The shown placed walks a 360 pane shows now, each with its view (two while comparing). */
function viewedPlaced(
  placed: readonly SheetWalk[],
  views: Readonly<Record<string, WalkViewNow>>,
  hidden: ReadonlySet<string> | undefined,
  except: string | null,
): { walk: SheetWalk; view: WalkViewNow }[] {
  const out: { walk: SheetWalk; view: WalkViewNow }[] = [];
  for (const [id, view] of Object.entries(views)) {
    if (id === except) continue;
    const walk = placed.find((w) => w.layer.id === id);
    if (!walk || !walkShown(walk.layer, { placingId: null, ...(hidden ? { hidden } : {}) }))
      continue;
    out.push({ walk, view });
  }
  return out;
}

/**
 * The Beam of every shown placed walk a 360 pane shows now (both walks while comparing), for the
 * map: where it is at the pane's time and where the pane looks. None for the walk a session edits
 * (the session draws its own) or without a coordinate system.
 */
export function placedBeamMarkers(
  m: ProjectManifest,
  placed: readonly SheetWalk[],
  hidden: ReadonlySet<string>,
  except: string | null,
  views: Readonly<Record<string, WalkViewNow>>,
): BeamMarker[] {
  const toLonLat = localToLonLat(m);
  if (!toLonLat) return [];
  const out: BeamMarker[] = [];
  for (const { walk, view } of viewedPlaced(placed, views, hidden, except)) {
    const b = walkBeamMarker(walk, { toLonLat }, resolveCssColour(walkColour(m, walk.layer)), view);
    if (b) out.push(b);
  }
  return out;
}

/**
 * Where each shown placed walk a 360 pane shows is now on the drawing `sheetId`, with its Beam
 * (both walks while comparing; each read from its own pane, so two panes never flicker between
 * them). Empty when the drawing has no frame.
 */
export function placedNowOnSheet(
  m: ProjectManifest,
  sheetId: string,
  placed: readonly SheetWalk[],
  lookup: DrawingLookup,
  views: Readonly<Record<string, WalkViewNow>>,
  opts: {
    except?: string | null;
    hidden?: ReadonlySet<string>;
    size?: { width: number; height: number } | undefined;
  } = {},
): WalkNow[] {
  const shown = viewedPlaced(placed, views, opts.hidden, opts.except ?? null);
  if (shown.length === 0) return [];
  const frame = surfaceFramesOf(m, lookup).drawing(sheetId);
  if (!frame) return [];
  const out: WalkNow[] = [];
  for (const { walk, view } of shown) {
    const now = walkNowOnSheet(walk, frame, (l) => walkColour(m, l), view.t, opts.size, view);
    if (now) out.push(now);
  }
  return out;
}

/**
 * The workspace's switched-off layers as a set (stable while they do not change), but for the two
 * walks a running compare shows: they draw whatever their visibility, which stays as it is.
 */
export function useHiddenLayers(): ReadonlySet<string> {
  const hidden = useWorkspace((s) => s.hidden);
  const comparedKey = useStore(walkCompare, (s) => comparedWalks(s).join('\n'));
  return useMemo(() => {
    const shown = new Set(comparedKey ? comparedKey.split('\n') : []);
    return new Set(Object.keys(hidden).filter((id) => !shown.has(id)));
  }, [hidden, comparedKey]);
}

/**
 * The live fits of the open project's placed walks (inputs read once and shared), rebuilt when
 * the manifest or a drawing's placement changes; `inputsOf` gives a walk's read inputs. While
 * `active` is false nothing is read or fitted (no fits, no inputs).
 */
export function usePlacedWalkFits(active = true): {
  fits: SheetWalk[];
  inputsOf: (layerId: string) => WalkInputs | undefined;
} {
  const project = useWorkspace((s) => s.project);
  const placed = useStore(drawings, (s) => s.placed);
  const [loaded, setLoaded] = useState<
    Readonly<Record<string, { key: string; value: WalkInputs }>>
  >({});
  const projectId = project?.id ?? null;
  const manifest = project?.manifest;
  const wanted = useMemo(
    () =>
      active && manifest && projectId !== null
        ? placedWalks(manifest).map((w) => ({ w, key: inputsKey(projectId, w) }))
        : [],
    [active, manifest, projectId],
  );
  useEffect(() => {
    if (projectId === null) return;
    let live = true;
    for (const { w, key } of wanted)
      void cachedInputs(projectId, w).then((value) => {
        if (!live) return;
        setLoaded((prev) => (prev[w.id]?.key === key ? prev : { ...prev, [w.id]: { key, value } }));
      });
    return () => {
      live = false;
    };
  }, [wanted, projectId]);
  const fits = useMemo(() => {
    if (!active || !manifest || projectId === null) return [];
    return placedWalkFits(
      manifest,
      (l) => {
        const e = loaded[l.id];
        return e?.key === inputsKey(projectId, l) ? e.value : undefined;
      },
      (id) => placed[id],
    );
  }, [active, manifest, projectId, loaded, placed]);
  const inputsOf = useMemo(() => {
    const byId = new Map(wanted.map(({ w, key }) => [w.id, key]));
    return (id: string): WalkInputs | undefined => {
      const e = loaded[id];
      return e && e.key === byId.get(id) ? e.value : undefined;
    };
  }, [wanted, loaded]);
  return { fits, inputsOf };
}

/**
 * The walk a session is placing or editing, on whatever surface: the placed walks drawn faintly
 * leave it out (its saved spot would disagree with the draft until Save).
 */
export function walkBeingEdited(s: Pick<PlaceState, 'layerId'>): string | null {
  return s.layerId;
}

/**
 * The placed walks on the main map at 60 %, but for the walk a session is editing (on any
 * surface); the stage calls it once and the overlays leave with the stage.
 */
export function usePlacedWalksOnMap(): void {
  const { fits } = usePlacedWalkFits();
  const manifest = useWorkspace((s) => s.project?.manifest);
  const hidden = useHiddenLayers();
  const except = useStore(placeSession, walkBeingEdited);
  useEffect(() => {
    setPlacedMapOverlays(manifest ? placedMapOverlays(manifest, fits, hidden, except) : []);
  }, [manifest, fits, hidden, except]);
  // every walk a 360 pane shows gets its Beam (two while comparing), outside React: a time tick
  // or a drag neither rebuilds the paths nor renders the stage
  const map = useMap()?.map ?? null;
  useEffect(() => {
    if (!map || !manifest) return;
    const beams = new MapBeamMarkers(map);
    const draw = () => {
      beams.set(placedBeamMarkers(manifest, fits, hidden, except, walkViews.getState()));
    };
    draw();
    const off = walkViews.subscribe(draw);
    return () => {
      off();
      beams.dispose();
    };
  }, [map, manifest, fits, hidden, except]);
  useEffect(
    () => () => {
      setPlacedMapOverlays([]);
    },
    [],
  );
}

/**
 * The model heading of the 360 view's picture centre at `time` (yaw offset included), for the
 * north tick: from the live session while this walk is being placed, else from its saved
 * placement. Null while the walk is not placed.
 */
export function useWalkViewHeading(walk: WalkLayer, time: number): number | null {
  return useWalkViewHeadingAt(walk)(time);
}

/** `useWalkViewHeading` as a function of time (compare pairs two walks' moments). */
export function useWalkViewHeadingAt(walk: WalkLayer): (time: number) => number | null {
  const sessionOn = useStore(placeSession, (s) => s.layerId === walk.id);
  const sessionFit = useStore(placeSession, (s) => (s.layerId === walk.id ? s.fit : null));
  const sessionYaw = useStore(placeSession, (s) => s.yawOffsetDeg);
  const sessionOrient = useStore(placeUi, (s) =>
    s.layerId === walk.id ? s.inputs.orientation : null,
  );
  const { fits, inputsOf } = usePlacedWalkFits();
  const saved = fits.find((w) => w.layer.id === walk.id);
  const orientation = inputsOf(walk.id)?.orientation ?? null;
  if (sessionOn) return (time) => viewHeading(sessionFit, sessionOrient, sessionYaw, time);
  const place = saved?.layer.place;
  if (!saved || !place) return () => null;
  return (time) => viewHeading(saved.fit, orientation, place.yawOffsetDeg, time);
}

/** The placed walk's live fit and date shift (the compare pairs spots in the scene). */
export function usePlacedWalk(layerId: string | null): SheetWalk | null {
  const { fits } = usePlacedWalkFits();
  return layerId === null ? null : (fits.find((w) => w.layer.id === layerId) ?? null);
}
