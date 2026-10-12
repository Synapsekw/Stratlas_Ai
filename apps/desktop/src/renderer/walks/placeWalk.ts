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
  type DrawingLookup,
  type PlaceSurface,
} from './placeModel';
import { createPlaceStore, type PlaceState } from './placeStore';
import { walkMap, setWalkMapOverlays, setWalkMapPick } from './walkMapStore';
import { resolveCssColour, walkMapOverlays, walkNowMapOverlay } from './walkMapOverlay';
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
}

const CLOSED: Omit<PlaceUi, 'seek'> = {
  layerId: null,
  host: null,
  inputs: NO_INPUTS,
  saving: false,
  asking: false,
  note: null,
};

export function createPlaceUi(): StoreApi<PlaceUi> {
  return createStore<PlaceUi>()(() => ({ ...CLOSED, seek: null }));
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
  /** Leave the walk as it was. */
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
  const discard = (): void => {
    session.getState().cancel();
    ui.setState({ ...CLOSED });
  };
  const failed = (note: string): void => {
    ui.setState({ note });
  };

  return {
    begin: async (layerId) => {
      const project = deps.project();
      const layer = project?.manifest.layers.find(
        (l): l is WalkLayer => l.kind === 'walk' && l.id === layerId,
      );
      if (!project || !layer) return;
      if (ui.getState().layerId === layerId && session.getState().layerId === layerId) {
        deps.openSurface(layerId, ui.getState().host);
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
        discard();
        return;
      }
      ui.setState({ inputs });
      session.getState().start(now, m, {
        raw: inputs.raw,
        drawings: deps.drawings,
        orientation: inputs.orientation,
      });
    },
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
      discard();
    },
    close: () => {
      if (session.getState().dirty) ui.setState({ asking: true });
      else discard();
    },
    discard,
    keepPlacing: () => {
      ui.setState({ asking: false });
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
    if (shown) setWalkMapOverlays([]);
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
    setWalkMapOverlays([pathFor.overlay, now].filter((o): o is MapOverlay => o !== null));
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

/** The inputs of placed walks read for their view (by layer id and the files they name). */
const inputsCache = new Map<string, { key: string; inputs: Promise<WalkInputs> }>();

/**
 * The model heading of the 360 view's picture centre at `time` (yaw offset included), for the
 * north tick: from the live session while this walk is being placed, else from its saved
 * placement. Null while the walk is not placed.
 */
export function useWalkViewHeading(
  projectId: string,
  walk: WalkLayer,
  time: number,
): number | null {
  const sessionOn = useStore(placeSession, (s) => s.layerId === walk.id);
  const sessionFit = useStore(placeSession, (s) => (s.layerId === walk.id ? s.fit : null));
  const sessionYaw = useStore(placeSession, (s) => s.yawOffsetDeg);
  const sessionOrient = useStore(placeUi, (s) =>
    s.layerId === walk.id ? s.inputs.orientation : null,
  );
  const manifest = useWorkspace((s) => s.project?.manifest);
  const placed = useStore(drawings, (s) => s.placed);
  const [inputs, setInputs] = useState<{ key: string; value: WalkInputs } | null>(null);
  const place = walk.place && walk.place.quality !== 'unplaced' ? walk.place : null;
  const key = `${projectId}|${walk.id}|${JSON.stringify(walk.path ?? null)}`;
  useEffect(() => {
    if (sessionOn || !place) return;
    let cached = inputsCache.get(walk.id);
    if (cached?.key !== key) {
      cached = { key, inputs: loadWalkInputs(projectId, walk) };
      inputsCache.set(walk.id, cached);
    }
    let live = true;
    void cached.inputs.then((value) => {
      if (live) setInputs({ key, value });
    });
    return () => {
      live = false;
    };
  }, [sessionOn, place, key, projectId, walk]);
  const savedFit = useMemo(() => {
    if (sessionOn || !place || !manifest || inputs?.key !== key) return null;
    const fit = fitWalk(
      inputs.value.raw,
      place,
      surfaceFramesOf(manifest, (id) => placed[id]),
      walk.durationS,
    );
    return fit.error ? null : fit;
  }, [sessionOn, place, manifest, inputs, key, placed, walk.durationS]);
  if (sessionOn) return viewHeading(sessionFit, sessionOrient, sessionYaw, time);
  return place && inputs?.key === key
    ? viewHeading(savedFit, inputs.value.orientation, place.yawOffsetDeg, time)
    : null;
}
