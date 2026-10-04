import type {
  AioBridge,
  AltitudeChoice,
  ImportHeights,
  ImportItem,
  IpcEvent,
  LayerPatch,
} from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, shell } from '../shell';
import { heightsPrompt, needsTakeoff, type HeightsPrompt } from './heights';
import { terrainHeightAt } from './pick';

export type AlignTool = { kind: 'mesh'; layerId: string } | { kind: 'video'; layerId: string };

export interface BuilderState {
  wizardOpen: boolean;
  /** Import in progress (progress from main), or null. */
  importing: { done: number; total: number; file: string } | null;
  /** Outcome of the last import, shown until dismissed. */
  importResult: { items: ImportItem[]; error: string | null; heights?: ImportHeights } | null;
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
  importFiles: (paths: readonly string[], altitude?: AltitudeChoice) => Promise<void>;
  /** Run the prompted import with the confirmed heights, or drop it. */
  confirmHeights: (altitude: AltitudeChoice) => Promise<void>;
  cancelHeights: () => void;
  pickAndImport: () => Promise<void>;
  dismissImport: () => void;
  startAlign: (tool: AlignTool) => void;
  stopAlign: () => void;
  /** Save an alignment and swap the open project's manifest. Returns an error text or null. */
  saveLayers: (layerIds: readonly string[], patch: LayerPatch) => Promise<string | null>;
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
      'glb',
      'obj',
      'tif',
      'tiff',
      'las',
      'laz',
      'e57',
    ],
  },
  { name: 'All files', extensions: ['*'] },
];

export const builder = createStore<Builder>()((set, get) => ({
  wizardOpen: false,
  importing: null,
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

  importFiles: async (paths, altitude) => {
    const project = workspace.getState().project;
    if (!project) {
      set({ importResult: { items: [], error: 'Open or create a project first, then import.' } });
      return;
    }
    if (!paths.length || get().importing) return;
    if (!altitude) {
      const plan = await bridge.call('builder:altitudePlan', {
        projectId: project.id,
        paths: [...paths],
      });
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
    set({
      importing: { done: 0, total: paths.length, file: '' },
      importResult: null,
      heightsPrompt: null,
    });
    const aio = window.aio as AioBridge | undefined;
    const off = aio?.on('builder:progress', (e: IpcEvent<'builder:progress'>) => {
      if (e.projectId === project.id)
        set({ importing: { done: e.done, total: e.total, file: e.file } });
    });
    const r = await bridge.call('builder:import', {
      projectId: project.id,
      paths: [...paths],
      ...(altitude ? { altitude } : {}),
    });
    off?.();
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
    set({
      importing: null,
      importResult: {
        items: r.value.items,
        error: null,
        ...(r.value.heights ? { heights: r.value.heights } : {}),
      },
    });
    void shell.getState().loadLibrary();
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
