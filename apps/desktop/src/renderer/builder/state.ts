import type {
  AioBridge,
  AltitudeChoice,
  ImportHeights,
  ImportItem,
  IpcEvent,
  LayerPatch,
} from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { finishStagedDrawings } from '../drawings/importFlow';
import { drawings } from '../drawings/store';
import { bridge, shell } from '../shell';
import { heightsPrompt, needsTakeoff, type HeightsPrompt } from './heights';
import { terrainHeightAt } from './pick';

/** What an import read its survey date from (the import card's "Read from ..." line). */
export type DateSource = 'photos' | 'video' | 'both' | null;

export type AlignTool = { kind: 'mesh'; layerId: string } | { kind: 'video'; layerId: string };

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
   * made (not in the manifest before it), so the import card can tidy them up. `priorLayers`: the
   * layer ids the project had before the import; the card re-dates only the layers the import
   * made, so photos it added to a date's existing photos layer never move earlier flights.
   * `dateSource`: what the date was read from when the import dated its layers, else null.
   */
  importResult: {
    items: ImportItem[];
    error: string | null;
    heights?: ImportHeights;
    newDates?: string[];
    priorLayers?: string[];
    dateSource?: DateSource;
  } | null;
  /** Camera heights to confirm before the import runs (relative altitude needs a take-off H). */
  heightsPrompt: HeightsPrompt | null;
  align: AlignTool | null;
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
 * say "importing" while the heights prompt is open. Files dropped again in that time used to
 * start a second import into the same project next to the first; now that drop does nothing,
 * like a drop while an import runs.
 */
let preparing = false;

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

export const builder = createStore<Builder>()((set, get) => ({
  wizardOpen: false,
  importing: null,
  cancellable: false,
  cancelling: false,
  importResult: null,
  heightsPrompt: null,
  align: null,

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
    if (!paths.length || get().importing) return;
    // a drawing has no camera and a 360 video is not placed: neither asks for camera heights
    if (!altitude && !opts?.drawings && !opts?.as360) {
      if (preparing) return;
      preparing = true;
      const plan = await bridge
        .call('builder:altitudePlan', { projectId: project.id, paths: [...paths] })
        .finally(() => {
          preparing = false;
        });
      // an import confirmed in the heights prompt started while these heights were read
      if (get().importing) return;
      if (plan.ok && plan.value.ok && needsTakeoff(plan.value.plan)) {
        const p = plan.value.plan;
        const y = p.takeoff ? terrainHeightAt(p.takeoff.x, p.takeoff.z) : null;
        set({
          importResult: null,
          heightsPrompt: heightsPrompt(paths, p, project.manifest.origin[2], y),
        });
        return;
      }
    }
    const before = new Set(project.manifest.captures.map((c) => c.id));
    const priorLayers = project.manifest.layers.map((l) => l.id);
    importingProject = project.id;
    set({
      importing: { done: 0, total: paths.length, file: '' },
      cancellable: true,
      cancelling: false,
      importResult: null,
      heightsPrompt: null,
    });
    const aio = window.aio as AioBridge | undefined;
    const off = aio?.on('builder:progress', (e: IpcEvent<'builder:progress'>) => {
      if (e.projectId === project.id)
        set({
          importing: {
            done: e.done,
            total: e.total,
            file: e.file,
            ...(e.part !== undefined ? { part: e.part } : {}),
          },
        });
    });
    const r = await bridge.call('builder:import', {
      projectId: project.id,
      paths: [...paths],
      ...(altitude ? { altitude } : {}),
      ...(opts?.drawings ? { drawings: true } : {}),
      ...(opts?.as360 ? { as360: true } : {}),
    });
    off?.();
    // main has answered: what follows (drawing pages) is not main's import any more
    const cancelled = get().cancelling;
    importingProject = null;
    set({ cancellable: false, cancelling: false });
    if (!r.ok) {
      set({ importing: null, importResult: { items: [], error: r.error } });
      return;
    }
    if (!r.value.ok) {
      set({ importing: null, importResult: { items: r.value.items ?? [], error: r.value.error } });
      return;
    }
    if (workspace.getState().project?.id === project.id)
      workspace.getState().replaceManifest(r.value.manifest);
    // the result of this import: its rows are only ever changed in it, never in a later one
    let result: NonNullable<BuilderState['importResult']> = {
      items: r.value.items,
      error: null,
      ...(r.value.heights ? { heights: r.value.heights } : {}),
      newDates: r.value.manifest.captures.filter((c) => !before.has(c.id)).map((c) => c.id),
      priorLayers,
      dateSource: dateSourceOf(r.value.items, r.value.manifest.layers),
    };
    // a cancelled import draws nothing more: the drawings it had only copied in are closed, so
    // their copies are removed, and no page question is asked for them
    if (cancelled) result = { ...result, items: await dropStaged(project.id, result.items) };
    const staged = result.items.filter((i) => i.drawing).length;
    // PDF, WebP and SVG were only copied in, their pages are drawn in this window. The import
    // stays busy until they are in or cancelled, the page question included, so a pick or a drop
    // made meanwhile does nothing, as during any import (the guard at the top).
    set({
      importing: staged > 0 ? { done: 0, total: staged, file: '' } : null,
      importResult: result,
    });
    void shell.getState().loadLibrary();
    if (staged > 0) {
      await finishStagedDrawings(project.id, {
        items: () => result.items,
        setItem: (index, patch) => {
          const shown = get().importResult === result;
          result = {
            ...result,
            items: result.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
          };
          if (shown) set({ importResult: result });
        },
        progress: (importing) => {
          set({ importing });
        },
      }).finally(() => {
        set({ importing: null });
      });
    }
    // the first drawing that came in shows its controls: side by side, place on the site
    const drawn = result.items.find(
      (i) => i.kind === 'drawing' && i.status === 'imported' && i.layerId,
    );
    if (drawn?.layerId && workspace.getState().project?.id === project.id)
      drawings.setState({ controls: drawn.layerId });
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
    set({ importResult: null });
  },

  confirmHeights: async (altitude) => {
    const p = get().heightsPrompt;
    if (!p) return;
    set({ heightsPrompt: null });
    await get().importFiles(p.paths, altitude);
  },
  cancelHeights: () => {
    set({ heightsPrompt: null });
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
