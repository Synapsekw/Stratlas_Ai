import type {
  AioBridge,
  AltitudeChoice,
  ImportHeights,
  ImportItem,
  IpcEvent,
  LayerPatch,
  PanoScan,
} from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { finishStagedDrawings } from '../drawings/importFlow';
import { drawings } from '../drawings/store';
import { openPanoScan, panoImport } from '../panos/panos';
import { bridge, shell } from '../shell';
import { heightsPrompt, needsTakeoff, type HeightsPrompt } from './heights';
import { DROPPED_NOTE, QUEUED_NOTE } from './importSummary';
import { terrainHeightAt } from './pick';

/** What an import read its survey date from (the import card's "Read from ..." line). */
export type DateSource = 'photos' | 'video' | 'both' | null;

export type AlignTool =
  | { kind: 'mesh'; layerId: string }
  | { kind: 'video'; layerId: string }
  /** Place model: move, turn, tilt and scale a mesh layer with a handle and number fields. */
  | { kind: 'place'; layerId: string };

export interface BuilderState {
  wizardOpen: boolean;
  /** Import in progress (progress from main), or null. */
  importing: { done: number; total: number; file: string; part?: number } | null;
  /**
   * Main is importing the files and can be told to stop (`builder:cancelImport`). False while
   * `importing` only covers the drawings of an import being finished in this window: their page
   * question has its own way out.
   */
  cancellable: boolean;
  /** Cancel was asked for; the import ends when main has stopped what it was doing. */
  cancelling: boolean;
  /**
   * Outcome of the last import, shown until dismissed. `newDates`: the survey dates the import
   * itself created (main names them; not a date another save added meanwhile), so the import
   * card can tidy them up. Every layer the import names is one it made (its photos are a layer of
   * their own), so the card re-dates them all. `dateSource`: what the date was read from when the
   * import dated its layers, else null. `paths`: the paths this import gave `builder:import`
   * (rows name a file only), so a walk it added is processed from its original (`walks/walks.ts`).
   */
  importResult: {
    items: ImportItem[];
    error: string | null;
    heights?: ImportHeights;
    newDates?: string[];
    dateSource?: DateSource;
    paths?: string[];
  } | null;
  /** Camera heights to confirm before the import runs (relative altitude needs a take-off H). */
  heightsPrompt: HeightsPrompt | null;
  /** Drone sphere frames found in the files: import them as panoramas? Null when not asked. */
  panoOffer: PanoOffer | null;
  /** The drone panorama check failed: nothing imports until the user picks (fail closed). */
  panoFailed: { paths: readonly string[]; altitude?: AltitudeChoice } | null;
  /** The files are being scanned for drone spheres. */
  panoScanning: boolean;
  align: AlignTool | null;
  /** Drops and picks waiting for the running import, in order. */
  queued: number;
  /** Why a drop is waiting ("An import is running. ..."), or null. */
  importNotice: string | null;
}

export interface BuilderActions {
  openWizard: () => void;
  closeWizard: () => void;
  /** Create a project from the wizard, then open it. */
  created: (path: string) => Promise<void>;
  /**
   * Import raw files. Without `altitude`, files whose camera heights need a take-off height stop
   * at the heights prompt first (data-conventions section 3a).
   */
  importFiles: (
    paths: readonly string[],
    altitude?: AltitudeChoice,
    opts?: ImportOptions,
  ) => Promise<void>;
  /** Cancel the running import as a whole (a 360 stitch stops; imported files stay). */
  cancelImport: () => Promise<void>;
  /** Run the prompted import with the confirmed heights, or drop it. */
  confirmHeights: (altitude: AltitudeChoice) => Promise<void>;
  cancelHeights: () => void;
  /** Import the offered spheres as panoramas (the preview opens) and the rest as photos. */
  acceptPanoOffer: () => Promise<void>;
  /** Skip the sphere frames: import only the other files, the frames left out. */
  declinePanoOffer: () => Promise<void>;
  /** Cancel the whole import the offer or the failed check stopped at. */
  dismissPanoOffer: () => void;
  /** After a failed check: import everything as photos. */
  importAnyway: () => Promise<void>;
  pickAndImport: () => Promise<void>;
  /** Pick a flight folder and import it (Add survey date, Import a flight folder...). */
  pickAndImportFolder: () => Promise<void>;
  /** Add drawing: pick PDF, pictures or DXF and bring them in as drawings. */
  pickAndAddDrawing: () => Promise<void>;
  /** Pick 360 camera files or stitched 360 videos and add them as walks. */
  pickAndImport360: () => Promise<void>;
  dismissImport: () => void;
  startAlign: (tool: AlignTool) => void;
  stopAlign: () => void;
  /** Save an alignment and swap the open project's manifest. Returns an error text or null. */
  saveLayers: (layerIds: readonly string[], patch: LayerPatch) => Promise<string | null>;
}

/** How an import treats its files; named, so further options do not become positional flags. */
export interface ImportOptions {
  /** Add drawing: every picture becomes a drawing, not a photo or an ortho. */
  drawings?: boolean;
  /** "Add 360 video": MP4 and MOV files are stitched 360 video, not drone clips. */
  as360?: boolean;
  /**
   * Files to leave out (the frames of drone spheres imported as panoramas instead). Present,
   * even empty, it also says the panorama offer was answered.
   */
  exclude?: readonly string[];
}

export interface PanoOffer {
  paths: readonly string[];
  altitude?: AltitudeChoice;
  scan: PanoScan;
  /** The sphere frames, absolute: left out of the photo import when the offer is taken. */
  frames: string[];
  spheres: number;
}

/** The offer to import a scan's spheres as panoramas, or null when it found none. */
export function panoOfferFrom(
  paths: readonly string[],
  scan: PanoScan,
  altitude?: AltitudeChoice,
): PanoOffer | null {
  if (scan.spheres.length === 0) return null;
  return {
    paths,
    ...(altitude ? { altitude } : {}),
    scan,
    frames: scan.spheres.flatMap((s) => s.files),
    spheres: scan.spheres.length,
  };
}

export type Builder = BuilderState & BuilderActions;

export const IMPORT_FILTERS = [
  {
    name: 'Raw data',
    extensions: [
      'jpg',
      'jpeg',
      'mp4',
      'mov',
      'srt',
      'insv',
      'lrv',
      'glb',
      'obj',
      'tif',
      'tiff',
      'las',
      'laz',
      'e57',
      'dxf',
      'opf',
      // drawings (a JPEG or a georeferenced TIFF is a drawing only through Add drawing)
      'pdf',
      'png',
      'webp',
      'svg',
    ],
  },
  { name: 'All files', extensions: ['*'] },
];

/** What Add drawing offers: every one of them comes in as a drawing. */
export const DRAWING_FILTERS = [
  {
    name: 'Drawings',
    extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'svg', 'tif', 'tiff', 'dxf'],
  },
  { name: 'All files', extensions: ['*'] },
];

/** "Add 360 video": a 360 camera's own files, or a video that is already stitched. */
export const IMPORT_360_FILTERS = [
  { name: '360 video', extensions: ['insv', 'lrv', 'mp4', 'mov'] },
  { name: 'All files', extensions: ['*'] },
];

/**
 * A dropped batch whose camera heights are being read (`builder:altitudePlan`) and that shows
 * nothing yet: `importing` is set only when the import itself starts, since the panel must not
 * say "importing" while the heights prompt is open. Files dropped in that time used to start a
 * second import into the same project next to the first; now that drop waits in the queue, like
 * a drop while an import runs.
 */
let preparing = false;

/**
 * Drops and picks that came while an import ran, was being prepared or waited for its heights,
 * in the order they came, each with the project it was made in: it is only ever imported there.
 */
const waiting: {
  projectId: string;
  paths: string[];
  altitude?: AltitudeChoice;
  opts?: ImportOptions;
}[] = [];
/** The files of the imports being prepared or run, so the same drop is not queued again. */
const current: (readonly string[])[] = [];
const samePaths = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((p, i) => p === b[i]);

/** The project the running import was started in (it stays there when another one is opened). */
let importingProject: string | null = null;

/**
 * The rows of a cancelled import whose drawings main had only copied in (`ImportItem.drawing`,
 * still `queued`): each is closed (`builder:closeDrawing` removes a copy that got no page, as
 * for a cancelled page question) and reported as skipped.
 */
async function dropStaged(projectId: string, items: readonly ImportItem[]): Promise<ImportItem[]> {
  const out: ImportItem[] = [];
  for (const it of items) {
    if (!it.drawing || it.status !== 'queued') {
      out.push(it);
      continue;
    }
    const { drawing, ...row } = it;
    await bridge.call('builder:closeDrawing', { projectId, stem: drawing.stem });
    out.push({
      ...row,
      status: 'skipped',
      message: 'The import was cancelled before this drawing was drawn. Nothing of it was added.',
    });
  }
  return out;
}

/**
 * What the import read its survey date from: the kinds of its imported rows (photos, video or
 * both) when any layer it made carries a `capture`, else null (nothing was dated).
 */
function dateSourceOf(
  items: readonly ImportItem[],
  layers: readonly { id: string; capture?: string | undefined }[],
): DateSource {
  const rows = items.filter((i) => i.status === 'imported' && i.layerId);
  const ids = new Set(rows.map((i) => i.layerId));
  if (!layers.some((l) => ids.has(l.id) && l.capture)) return null;
  const photos = rows.some((i) => i.kind === 'photo');
  const video = rows.some((i) => i.kind === 'video');
  return photos && video ? 'both' : photos ? 'photos' : video ? 'video' : null;
}

type OpenProject = NonNullable<ReturnType<typeof workspace.getState>['project']>;

/**
 * The drone panorama preview opened from an offer is up: the queue waits for it, as for a card
 * (one question at a time).
 */
let previewing = false;

/** Something asks or runs: a drop or pick now waits in the queue, and the queue holds. */
function busyNow(altitude?: AltitudeChoice): boolean {
  const s = builder.getState();
  return (
    s.importing !== null ||
    s.heightsPrompt !== null ||
    s.panoOffer !== null ||
    s.panoFailed !== null ||
    previewing ||
    // the import confirmed in the heights prompt (it has its `altitude`) goes ahead of a drop
    // still being prepared (its sphere scan or its heights)
    (preparing && !altitude)
  );
}

/**
 * One import as it ran before the queue: the files are checked for drone sphere frames (and may
 * stop at the panorama offer, or at the failed-check card), the heights are read (and may stop at
 * the prompt), then main imports the files. True when an import confirmed in the heights prompt
 * started (or a card opened) while this drop was prepared, so it must wait.
 */
async function runImport(
  project: OpenProject,
  paths: readonly string[],
  altitude: AltitudeChoice | undefined,
  opts: ImportOptions | undefined,
): Promise<boolean> {
  // drone sphere frames go to the panorama import, not into a photo layer (spec section 2); a
  // queued drop is scanned when its turn comes, like any other. `exclude` says it was answered.
  if (!opts?.drawings && !opts?.as360 && opts?.exclude === undefined) {
    preparing = true;
    builder.setState({ panoScanning: true, importResult: null });
    let found: Awaited<ReturnType<typeof bridge.call<'panos:scan'>>> | null;
    try {
      found = await bridge.call('panos:scan', { projectId: project.id, paths: [...paths] });
    } catch {
      found = null;
    } finally {
      preparing = false;
      builder.setState({ panoScanning: false });
    }
    if (builder.getState().importing || builder.getState().heightsPrompt) return true;
    if (!found || !found.ok || !found.value.ok) {
      // fail closed: sphere frames must not silently become map photos
      builder.setState({ panoFailed: { paths, ...(altitude ? { altitude } : {}) } });
      return false;
    }
    const offer = panoOfferFrom(paths, found.value.scan, altitude);
    if (offer) {
      builder.setState({ panoOffer: offer, importResult: null });
      return false;
    }
  }
  // a drawing has no camera and a 360 video is not placed: neither asks for camera heights
  if (!altitude && !opts?.drawings && !opts?.as360) {
    preparing = true;
    const plan = await bridge
      .call('builder:altitudePlan', {
        projectId: project.id,
        paths: [...paths],
        // the sphere frames go to the panorama import: they ask for no camera heights
        ...(opts?.exclude?.length ? { exclude: [...opts.exclude] } : {}),
      })
      .finally(() => {
        preparing = false;
      });
    // an import confirmed in the heights prompt started (or a prompt opened) while these heights
    // were read: this drop waits for it
    if (builder.getState().importing || builder.getState().heightsPrompt) return true;
    if (plan.ok && plan.value.ok && needsTakeoff(plan.value.plan)) {
      const p = plan.value.plan;
      const y = p.takeoff ? terrainHeightAt(p.takeoff.x, p.takeoff.z) : null;
      builder.setState({
        importResult: null,
        heightsPrompt: {
          ...heightsPrompt(paths, p, project.manifest.origin[2], y),
          // the sphere frames stay out of the photos after the heights card, too
          ...(opts?.exclude ? { exclude: [...opts.exclude] } : {}),
        },
      });
      return false;
    }
  }
  importingProject = project.id;
  builder.setState({
    importing: { done: 0, total: paths.length, file: '' },
    cancellable: true,
    cancelling: false,
    importResult: null,
    heightsPrompt: null,
  });
  try {
    await importNow(project, paths, altitude, opts);
  } catch (e) {
    // the bridge or a step after it threw: the import is over, so the next drop can run
    importingProject = null;
    builder.setState({
      importing: null,
      cancellable: false,
      cancelling: false,
    });
    throw e;
  }
  return false;
}

/** Main imports the files (`importing` is set), then the drawing pages are drawn here. */
async function importNow(
  project: OpenProject,
  paths: readonly string[],
  altitude: AltitudeChoice | undefined,
  opts: ImportOptions | undefined,
): Promise<void> {
  const aio = window.aio as AioBridge | undefined;
  const off = aio?.on('builder:progress', (e: IpcEvent<'builder:progress'>) => {
    if (e.projectId === project.id)
      builder.setState({
        importing: {
          done: e.done,
          total: e.total,
          file: e.file,
          ...(e.part !== undefined ? { part: e.part } : {}),
        },
      });
  });
  const r = await bridge
    .call('builder:import', {
      projectId: project.id,
      paths: [...paths],
      ...(altitude ? { altitude } : {}),
      ...(opts?.drawings ? { drawings: true } : {}),
      ...(opts?.as360 ? { as360: true } : {}),
      ...(opts?.exclude?.length ? { exclude: [...opts.exclude] } : {}),
    })
    .finally(() => {
      off?.();
    });
  // main has answered: what follows (drawing pages) is not main's import any more
  const cancelled = builder.getState().cancelling;
  importingProject = null;
  builder.setState({ cancellable: false, cancelling: false });
  if (!r.ok) {
    builder.setState({ importing: null, importResult: { items: [], error: r.error } });
    return;
  }
  if (!r.value.ok) {
    builder.setState({
      importing: null,
      importResult: { items: r.value.items ?? [], error: r.value.error, paths: [...paths] },
    });
    return;
  }
  if (workspace.getState().project?.id === project.id)
    workspace.getState().replaceManifest(r.value.manifest);
  // nothing was left to import (every file was a sphere frame the panorama import took): no card
  if (r.value.items.length === 0 && r.value.files?.length === 0) {
    builder.setState({ importing: null, importResult: null });
    return;
  }
  // the result of this import: its rows are only ever changed in it, never in a later one
  let result: NonNullable<BuilderState['importResult']> = {
    items: r.value.items,
    error: null,
    // the files a folder expanded to first: a walk inside it is processed from its original
    paths: [...(r.value.files ?? []), ...paths],
    ...(r.value.heights ? { heights: r.value.heights } : {}),
    newDates: r.value.createdCaptures ?? [],
    dateSource: dateSourceOf(r.value.items, r.value.manifest.layers),
  };
  // a cancelled import draws nothing more: the drawings it had only copied in are closed, so
  // their copies are removed, and no page question is asked for them
  if (cancelled) result = { ...result, items: await dropStaged(project.id, result.items) };
  const staged = result.items.filter((i) => i.drawing).length;
  // PDF, WebP and SVG were only copied in, their pages are drawn in this window. The import
  // stays busy until they are in or cancelled, the page question included, so a pick or a drop
  // made meanwhile waits in the queue, as during any import (the guard in `importFiles`).
  builder.setState({
    importing: staged > 0 ? { done: 0, total: staged, file: '' } : null,
    importResult: result,
  });
  void shell.getState().loadLibrary();
  if (staged > 0) {
    await finishStagedDrawings(project.id, {
      items: () => result.items,
      setItem: (index, patch) => {
        const shown = builder.getState().importResult === result;
        result = {
          ...result,
          items: result.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
        };
        if (shown) builder.setState({ importResult: result });
      },
      progress: (importing) => {
        builder.setState({ importing });
      },
    }).finally(() => {
      builder.setState({ importing: null });
    });
  }
  // the first drawing that came in shows its controls: side by side, place on the site
  const drawn = result.items.find(
    (i) => i.kind === 'drawing' && i.status === 'imported' && i.layerId,
  );
  if (drawn?.layerId && workspace.getState().project?.id === project.id)
    drawings.setState({ controls: drawn.layerId });
}

/** A drop that came while an import ran or was prepared waits; the same files only once. */
function queue(
  projectId: string,
  paths: readonly string[],
  altitude: AltitudeChoice | undefined,
  opts: ImportOptions | undefined,
): void {
  if (current.some((c) => samePaths(c, paths)) || waiting.some((w) => samePaths(w.paths, paths)))
    return;
  waiting.push({
    projectId,
    paths: [...paths],
    ...(altitude ? { altitude } : {}),
    ...(opts ? { opts } : {}),
  });
  builder.setState({ queued: waiting.length, importNotice: QUEUED_NOTE });
}

/**
 * The next waiting drop, once nothing runs or is prepared. An open heights prompt, panorama offer
 * or failed-check card, and the panorama preview, hold the queue: their answer drains it.
 */
async function next(): Promise<void> {
  forgetOtherProjects(workspace.getState().project?.id ?? null);
  const s = builder.getState();
  if (busyNow()) return;
  const w = waiting.shift();
  if (!w) return;
  builder.setState({
    queued: waiting.length,
    importNotice: waiting.length > 0 ? QUEUED_NOTE : null,
  });
  await s.importFiles(w.paths, w.altitude, w.opts);
}

/**
 * `next()` where nobody awaits it: a waiting drop that throws says so in the import panel
 * instead of becoming an unhandled rejection.
 */
function drain(): void {
  next().catch((e: unknown) => {
    builder.setState({
      importing: null,
      importResult: { items: [], error: e instanceof Error ? e.message : String(e) },
    });
  });
}

/**
 * The waiting drops of a project that is no longer open are never imported (they would land in
 * whichever project is open next): they are dropped, and the panel says so.
 */
function forgetOtherProjects(openId: string | null): void {
  const kept = waiting.filter((w) => w.projectId === openId);
  if (kept.length === waiting.length) return;
  waiting.splice(0, waiting.length, ...kept);
  builder.setState({
    queued: waiting.length,
    importNotice: waiting.length > 0 ? QUEUED_NOTE : DROPPED_NOTE,
  });
}

export const builder = createStore<Builder>()((set, get) => ({
  wizardOpen: false,
  importing: null,
  cancellable: false,
  cancelling: false,
  importResult: null,
  heightsPrompt: null,
  panoOffer: null,
  panoFailed: null,
  panoScanning: false,
  align: null,
  queued: 0,
  importNotice: null,

  openWizard: () => {
    shell.getState().setPalette(false);
    set({ wizardOpen: true });
  },
  closeWizard: () => {
    set({ wizardOpen: false });
  },
  created: async (path) => {
    set({ wizardOpen: false });
    await shell.getState().loadLibrary();
    await shell.getState().openProject(path);
    shell.getState().go('scene');
  },

  importFiles: async (paths, altitude, opts) => {
    const project = workspace.getState().project;
    if (!project) {
      set({ importResult: { items: [], error: 'Open or create a project first, then import.' } });
      return;
    }
    if (!paths.length) return;
    // one import at a time: a drop made meanwhile waits its turn (and is scanned for drone
    // spheres when it comes). The import confirmed in the heights prompt (it has its `altitude`)
    // goes ahead of a drop still being prepared. An open heights prompt, panorama offer or
    // failed-check card is busy too: a drop now would clear it or replace it.
    if (busyNow(altitude)) {
      queue(project.id, paths, altitude, opts);
      return;
    }
    const mine = [...paths];
    current.push(mine);
    let busy: boolean;
    try {
      busy = await runImport(project, paths, altitude, opts);
    } catch (e) {
      drain();
      throw e;
    } finally {
      current.splice(current.indexOf(mine), 1);
    }
    if (busy) queue(project.id, paths, altitude, opts);
    await next();
  },

  pickAndAddDrawing: async () => {
    shell.getState().setPalette(false);
    const pick = await bridge.call('dialog:openFiles', {
      title: 'Add drawings',
      filters: DRAWING_FILTERS,
      multi: true,
    });
    if (pick.ok && pick.value.paths.length)
      await get().importFiles(pick.value.paths, undefined, { drawings: true });
  },

  pickAndImport: async () => {
    shell.getState().setPalette(false);
    const pick = await bridge.call('dialog:openFiles', {
      title: 'Import raw data',
      filters: IMPORT_FILTERS,
      multi: true,
    });
    if (pick.ok && pick.value.paths.length) await get().importFiles(pick.value.paths);
  },

  pickAndImportFolder: async () => {
    shell.getState().setPalette(false);
    const pick = await bridge.call('dialog:openFolder', { title: t('tree.addDate.folderTitle') });
    if (pick.ok && pick.value.path) await get().importFiles([pick.value.path]);
  },

  pickAndImport360: async () => {
    shell.getState().setPalette(false);
    const pick = await bridge.call('dialog:openFiles', {
      title: 'Add 360 video',
      filters: IMPORT_360_FILTERS,
      multi: true,
    });
    if (pick.ok && pick.value.paths.length)
      await get().importFiles(pick.value.paths, undefined, { as360: true });
  },

  cancelImport: async () => {
    const projectId = importingProject;
    if (!get().cancellable || projectId === null || get().cancelling) return;
    set({ cancelling: true });
    const r = await bridge.call('builder:cancelImport', { projectId });
    // nothing was cancelled (the import had just ended, or main could not be reached): the
    // button works again if the import is somehow still shown
    if (!(r.ok && r.value.ok) && importingProject === projectId) set({ cancelling: false });
  },

  dismissImport: () => {
    set({ importResult: null, ...(waiting.length === 0 ? { importNotice: null } : {}) });
  },

  confirmHeights: async (altitude) => {
    const p = get().heightsPrompt;
    if (!p) return;
    set({ heightsPrompt: null });
    await get().importFiles(p.paths, altitude, { exclude: p.exclude ?? [] });
  },
  cancelHeights: () => {
    set({ heightsPrompt: null });
    drain();
  },

  acceptPanoOffer: async () => {
    const o = get().panoOffer;
    if (!o) return;
    set({ panoOffer: null });
    // the preview is modal; the rest goes in as photos once it closes, imported or cancelled.
    // Drops meanwhile wait in the queue.
    previewing = true;
    try {
      openPanoScan(o.scan);
      await new Promise<void>((done) => {
        const stop = panoImport.subscribe((s) => {
          if (s.open) return;
          stop();
          done();
        });
      });
    } finally {
      previewing = false;
    }
    await get().importFiles(o.paths, o.altitude, { exclude: o.frames });
  },
  declinePanoOffer: async () => {
    const o = get().panoOffer;
    if (!o) return;
    set({ panoOffer: null });
    // the sphere frames never become map photos: only the other files come in
    await get().importFiles(o.paths, o.altitude, { exclude: o.frames });
  },
  dismissPanoOffer: () => {
    set({ panoOffer: null, panoFailed: null });
    // the drops that waited for the answer go on
    drain();
  },
  importAnyway: async () => {
    const f = get().panoFailed;
    if (!f) return;
    set({ panoFailed: null });
    await get().importFiles(f.paths, f.altitude, { exclude: [] });
  },

  startAlign: (align) => {
    shell.getState().setPalette(false);
    const s = shell.getState();
    if (s.screen !== 'scene') s.go('scene');
    if (s.stageMode === 'map') s.setStageMode('3d');
    set({ align });
  },
  stopAlign: () => {
    set({ align: null });
  },

  saveLayers: async (layerIds, patch) => {
    const project = workspace.getState().project;
    if (!project) return 'No project is open.';
    const r = await bridge.call('builder:updateLayers', {
      projectId: project.id,
      layerIds: [...layerIds],
      patch,
    });
    if (!r.ok) return r.error;
    if (!r.value.ok) return r.value.error;
    workspace.getState().replaceManifest(r.value.manifest);
    return null;
  },
}));

export function useBuilder<T>(selector: (s: Builder) => T): T {
  return useStore(builder, selector);
}
