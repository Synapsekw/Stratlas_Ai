import type { AioBridge, ImportItem, IpcEvent, LayerPatch } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { bridge, shell } from '../shell';

export type AlignTool = { kind: 'mesh'; layerId: string } | { kind: 'video'; layerId: string };

export interface BuilderState {
  wizardOpen: boolean;
  /** Import in progress (progress from main), or null. */
  importing: { done: number; total: number; file: string } | null;
  /** Outcome of the last import, shown until dismissed. */
  importResult: { items: ImportItem[]; error: string | null } | null;
  align: AlignTool | null;
}

export interface BuilderActions {
  openWizard: () => void;
  closeWizard: () => void;
  /** Create a project from the wizard, then open it. */
  created: (path: string) => Promise<void>;
  importFiles: (paths: readonly string[]) => Promise<void>;
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

  importFiles: async (paths) => {
    const project = workspace.getState().project;
    if (!project) {
      set({ importResult: { items: [], error: 'Open or create a project first, then import.' } });
      return;
    }
    if (!paths.length || get().importing) return;
    set({ importing: { done: 0, total: paths.length, file: '' }, importResult: null });
    const aio = window.aio as AioBridge | undefined;
    const off = aio?.on('builder:progress', (e: IpcEvent<'builder:progress'>) => {
      if (e.projectId === project.id)
        set({ importing: { done: e.done, total: e.total, file: e.file } });
    });
    const r = await bridge.call('builder:import', { projectId: project.id, paths: [...paths] });
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
    set({ importing: null, importResult: { items: r.value.items, error: null } });
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
