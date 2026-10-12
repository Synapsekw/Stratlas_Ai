import { fitWalk, walkHeadingAt, type WalkFit } from '@aio/geo';
import type { MapOverlay } from '@aio/maps';
import {
  readWalkOrientationData,
  WalkOrientation,
  WalkRawPath,
  type AssetRef,
  type LayerPatch,
  type ProjectManifest,
  type Vec3,
  type WalkLayer,
} from '@aio/schema';
import { t } from '@aio/ui';
import {
  assetUrl,
  captureIndex,
  dateTags,
  useWorkspace,
  workspace,
  type OpenProject,
} from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { builder } from '../builder/state';
import { newSurveyDate, setLayersCapture } from '../change/SurveyDate';
import { localToLonLat } from '../change/draw';
import { drawings } from '../drawings/store';
import { shell } from '../shell';
import { PANE_KINDS, sideOf } from '../workspace/splitModel';
import { stagePrefs } from '../workspace/stagePrefs';
import {
  dateChoices,
  placeSurfaces,
  rememberedSurface,
  surfaceFramesOf,
  surfaceKey,
  type DrawingLookup,
  type PlaceSurface,
} from './placeModel';
import { createPlaceStore, type PlaceState } from './placeStore';
import { walkMap, setWalkMapOverlays, setWalkMapPick } from './walkMapStore';
import { resolveCssColour, walkMapOverlays, walkNowMapOverlay } from './walkMapOverlay';
import { walkDrawingsForSheet, type SheetWalk, type WalkDrawing } from './walkOverlay';
import { splitWithWalk } from './walkModel';
import { setPlaceWalkHandler, walks } from './walks';
import { walkRecordKey } from './walkStore';

/*
 * Place walk, wired (design "Placing a walk: the flow"): `placeWalk(layerId)` opens the split with
 * the 360 video on one side and the surface on the other, reads the walk's raw path and
 * orientation, and starts the session (`placeStore.ts`). The strip (`PlaceWalkStrip.tsx`) sits
 * over the surface pane; Save sends the calibration through `builder.saveLayers`, whose answer
 * (the manifest with the pose written) updates the walk's row.
 */

/** What the live fit needs from the walk's folder; null parts: not there or unreadable. */
export interface WalkInputs {
  raw: WalkRawPath | null;
  orientation: Float64Array[] | null;
}

const NO_INPUTS: WalkInputs = { raw: null, orientation: null };

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
  if (refs.orientation && refs.orientationData) {
    try {
      const header = WalkOrientation.safeParse(await json(refs.orientation));
      if (header.success) {
        const r = await get(assetUrl(projectId, refs.orientationData));
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
  /** Show the 360 video and `host` side by side (null: the 360 video beside what is there). */
  openSurface(layerId: string, host: PlaceSurface | null): void;
  /** `builder.saveLayers`: null when saved (the manifest is replaced), else why not. */
  save(layerId: string, patch: LayerPatch): Promise<string | null>;
  /** `builder:ensureCapture` for a day; the manifest is replaced. */
  ensureCapture(day: string): Promise<{ captureId: string } | { error: string }>;
  /** `LayerPatch { capture }` on one layer; the manifest is replaced. */
  setCapture(layerId: string, captureId: string): Promise<string | null>;
  /** When the camera says the walk was filmed (`walk.json`), if it says. */
  capturedAt(layer: WalkLayer): string | undefined;
}

/** One choice of the date step. */
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
  /** The date step: the project's dates (the `capturedAt` one first), and a day to add. */
  dates(): { pick: DateChoice[]; add?: string };
  chooseDate(captureId: string): Promise<void>;
  addDate(day: string): Promise<void>;
  chooseSurface(s: PlaceSurface): void;
  save(): Promise<void>;
  /** Close the strip: asks first when there are unsaved pins. */
  close(): void;
  /** Leave the walk as it was (then place the walk that was waiting, if one was). */
  discard(): void;
  /** Back to placing from the question. */
  keepPlacing(): void;
}

export function createPlaceWalk(
  deps: PlaceWalkDeps,
  session: StoreApi<PlaceState>,
  ui: StoreApi<PlaceUi>,
): PlaceWalkFlow {
  let begun = 0;
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
    ui.setState({ ...CLOSED });
  };
  const failed = (note: string): void => {
    ui.setState({ note });
  };
  /** The remembered (or first) surface chosen, so the strip opens on its first step. */
  const enterHost = (): void => {
    const h = ui.getState().host;
    if (!h || session.getState().step !== 'surface') return;
    if (surfacesOf().some((x) => surfaceKey(x) === surfaceKey(h)))
      session.getState().chooseSurface(h);
  };
  /** After the answer to "Keep these pins?": the walk that was waiting is placed next. */
  const next = (): void => {
    const waiting = ui.getState().pending;
    reset();
    if (waiting) void begin(waiting);
  };

  const begin = async (layerId: string): Promise<void> => {
    const project = deps.project();
    const layer = project?.manifest.layers.find(
      (l): l is WalkLayer => l.kind === 'walk' && l.id === layerId,
    );
    if (!project || !layer) return;
    const cur = ui.getState();
    if (cur.layerId === layerId && session.getState().layerId === layerId) {
      deps.openSurface(layerId, cur.host);
      return;
    }
    // unsaved pins on another walk: ask first, place this one after the answer
    if (
      cur.layerId !== null &&
      session.getState().layerId === cur.layerId &&
      session.getState().dirty
    ) {
      ui.setState({ asking: true, pending: layerId });
      deps.openSurface(cur.layerId, cur.host);
      return;
    }
    const ask = ++begun;
    session.getState().cancel();
    const list = placeSurfaces(project.manifest, layer, hasCrs(project.manifest));
    const host = rememberedSurface(layer, list) ?? list[0] ?? null;
    ui.setState({ ...CLOSED, layerId, host });
    deps.openSurface(layerId, host);
    const inputs = await deps.loadInputs(project.id, layer);
    // a newer Place walk (or a close) came first
    if (ask !== begun || ui.getState().layerId !== layerId) return;
    const m = deps.project()?.manifest ?? project.manifest;
    const now = m.layers.find((l): l is WalkLayer => l.kind === 'walk' && l.id === layerId);
    if (!now) {
      reset();
      return;
    }
    ui.setState({ inputs });
    session.getState().start(now, m, {
      raw: inputs.raw,
      drawings: deps.drawings,
      orientation: inputs.orientation,
    });
    enterHost();
  };

  return {
    begin,
    walk: walkOf,
    surfaces: surfacesOf,
    dates: () => {
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
    },
    chooseDate: async (captureId) => {
      const id = ui.getState().layerId;
      if (!id) return;
      ui.setState({ note: null });
      const error = await deps.setCapture(id, captureId);
      if (error) {
        failed(error);
        return;
      }
      session.getState().setDate(captureId);
      enterHost();
    },
    addDate: async (day) => {
      const id = ui.getState().layerId;
      if (!id) return;
      ui.setState({ note: null });
      const made = await deps.ensureCapture(day);
      if ('error' in made) {
        failed(made.error);
        return;
      }
      const error = await deps.setCapture(id, made.captureId);
      if (error) {
        failed(error);
        return;
      }
      session.getState().setDate(made.captureId);
      enterHost();
    },
    chooseSurface: (s) => {
      const id = ui.getState().layerId;
      if (!id) return;
      ui.setState({ host: s, note: null });
      deps.openSurface(id, s);
      session.getState().chooseSurface(s);
    },
    save: async () => {
      const id = ui.getState().layerId;
      const st = session.getState();
      if (!id || st.layerId !== id || ui.getState().saving) return;
      ui.setState({ saving: true, note: null, asking: false });
      const error = await deps.save(id, { walk: st.calibration() });
      if (ui.getState().layerId !== id) return;
      if (error) {
        ui.setState({ saving: false, note: error });
        return;
      }
      next();
    },
    close: () => {
      if (session.getState().dirty) ui.setState({ asking: true });
      else reset();
    },
    discard: next,
    keepPlacing: () => {
      ui.setState({ asking: false, pending: null });
    },
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

/** The session armed for a click on the surface (a pin, or the second click of Align view). */
export function wantsSurfaceClick(s: Pick<PlaceState, 'armed'>): boolean {
  return (
    s.armed === 'start' || s.armed === 'end' || s.armed === 'pin' || s.armed === 'align-surface'
  );
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
 * Keep the main map in step with a walk placed on the map: its path, stills and pins as overlays
 * (an inactive pin says why on hover), the current position apart, and a point pick while the
 * session waits for a click. Returns the unsubscribe.
 */
export function followMap(
  session: StoreApi<PlaceState>,
  ui: StoreApi<PlaceUi>,
  project: () => OpenProject | null,
): () => void {
  let pathFor: { fit: WalkFit | null; layer: WalkLayer | null; overlay: MapOverlay | null } = {
    fit: null,
    layer: null,
    overlay: null,
  };
  let ours: unknown = null;
  let shown = false;
  const clear = (): void => {
    if (shown) {
      sessionMap = [];
      publishMap();
    }
    shown = false;
    pathFor = { fit: null, layer: null, overlay: null };
    if (ours !== null && walkMap.getState().pick === ours) setWalkMapPick(null);
    ours = null;
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
    if (pathFor.fit !== s.fit || pathFor.layer !== layer) {
      const shownLayer = { ...layer, visible: true };
      const [ov] = walkMapOverlays([{ layer: shownLayer, fit: s.fit, raw }], proj, colour, {
        placingId: layer.id,
      });
      pathFor = {
        fit: s.fit,
        layer,
        overlay: ov
          ? {
              ...ov,
              tooltip: (props) =>
                props.kind === 'pin' && props.active === false ? t('walk.pin.gone') : null,
            }
          : null,
      };
    }
    const now = walkNowMapOverlay({ layer, fit: s.fit, raw }, proj, colour, s.timeS);
    sessionMap = [pathFor.overlay, now].filter((o): o is MapOverlay => o !== null);
    publishMap();
    shown = true;
    const want = wantsSurfaceClick(s);
    const armed = walkMap.getState().pick;
    if (want && (armed === null || armed !== ours)) {
      setWalkMapPick({
        onPick: (local: Vec3) => {
          session.getState().click([local[0], local[2]], local[1]);
        },
      });
      ours = walkMap.getState().pick;
    } else if (!want && ours !== null && armed === ours) {
      setWalkMapPick(null);
      ours = null;
    }
  };
  // the session without a fit yet shows nothing; a walk with no path draws pins only
  return session.subscribe(update);
}

// ---------- the app's instance ----------

/** The split with the 360 video beside `host`: the surface on the side the video is not on. */
function openSurface(layerId: string, host: PlaceSurface | null): void {
  const project = workspace.getState().project;
  if (!project) return;
  walks.getState().select(layerId);
  const sh = shell.getState();
  if (sh.screen !== 'scene') sh.go('scene');
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  const sides = splitWithWalk(saved, PANE_KINDS);
  const other = sideOf(sides, 'walk360') === 'left' ? 'right' : 'left';
  const split = !host
    ? sides
    : host.kind === 'map'
      ? { ...sides, [other]: 'map' as const }
      : { ...sides, [other]: 'raster' as const, raster: host.id };
  stagePrefs.getState().update(project.id, { split });
  if (sh.stageMode !== 'split') sh.setStageMode('split');
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

setPlaceWalkHandler((layerId) => {
  void placeFlow.begin(layerId);
});

// ---------- placed walks: drawn on every surface, outside placing too ----------

/** The inputs of placed walks (by layer id), read once per the files they name. */
const inputsCache = new Map<string, { key: string; inputs: Promise<WalkInputs> }>();

const inputsKey = (projectId: string, walk: WalkLayer): string =>
  `${projectId}|${walk.id}|${JSON.stringify(walk.path ?? null)}`;

function cachedInputs(projectId: string, walk: WalkLayer): Promise<WalkInputs> {
  const key = inputsKey(projectId, walk);
  let cached = inputsCache.get(walk.id);
  if (cached?.key !== key) {
    cached = { key, inputs: loadWalkInputs(projectId, walk) };
    inputsCache.set(walk.id, cached);
  }
  return cached.inputs;
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
    return fit.error ? [] : [{ layer, fit, raw: inputs.raw }];
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

/** The workspace's switched-off layers as a set (stable while they do not change). */
export function useHiddenLayers(): ReadonlySet<string> {
  const hidden = useWorkspace((s) => s.hidden);
  return useMemo(() => new Set(Object.keys(hidden)), [hidden]);
}

/**
 * The live fits of the open project's placed walks (inputs read once and shared), rebuilt when
 * the manifest or a drawing's placement changes; `inputsOf` gives a walk's read inputs.
 */
export function usePlacedWalkFits(): {
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
      manifest && projectId !== null
        ? placedWalks(manifest).map((w) => ({ w, key: inputsKey(projectId, w) }))
        : [],
    [manifest, projectId],
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
    if (!manifest || projectId === null) return [];
    return placedWalkFits(
      manifest,
      (l) => {
        const e = loaded[l.id];
        return e?.key === inputsKey(projectId, l) ? e.value : undefined;
      },
      (id) => placed[id],
    );
  }, [manifest, projectId, loaded, placed]);
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
 * The placed walks on the main map at 60 % while no session places one there (the stage calls
 * it once); the overlays leave with the stage.
 */
export function usePlacedWalksOnMap(): void {
  const { fits } = usePlacedWalkFits();
  const manifest = useWorkspace((s) => s.project?.manifest);
  const hidden = useHiddenLayers();
  const except = useStore(placeSession, (s) => (s.surface?.kind === 'map' ? s.layerId : null));
  useEffect(() => {
    setPlacedMapOverlays(manifest ? placedMapOverlays(manifest, fits, hidden, except) : []);
  }, [manifest, fits, hidden, except]);
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
  const sessionOn = useStore(placeSession, (s) => s.layerId === walk.id);
  const sessionFit = useStore(placeSession, (s) => (s.layerId === walk.id ? s.fit : null));
  const sessionYaw = useStore(placeSession, (s) => s.yawOffsetDeg);
  const sessionOrient = useStore(placeUi, (s) =>
    s.layerId === walk.id ? s.inputs.orientation : null,
  );
  const { fits, inputsOf } = usePlacedWalkFits();
  if (sessionOn) return viewHeading(sessionFit, sessionOrient, sessionYaw, time);
  const saved = fits.find((w) => w.layer.id === walk.id);
  return saved?.layer.place
    ? viewHeading(
        saved.fit,
        inputsOf(walk.id)?.orientation ?? null,
        saved.layer.place.yawOffsetDeg,
        time,
      )
    : null;
}
