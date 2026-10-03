import { defaultRoutes } from '@aio/ai';
import type { LibraryEntry, Settings } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createBridge, type Bridge } from './bridge';

export type Screen = 'projects' | 'scene' | 'issues' | 'media' | 'reports' | 'settings';
export type StageMode = '3d' | 'map' | 'split';

/** Used until main answers settings:get. Offline first: cloud AI is off. */
export const DEFAULT_SETTINGS: Settings = {
  cloudAi: false,
  theme: 'dark',
  sidebarCollapsed: false,
  dataRoot: '',
  routes: defaultRoutes(),
};

export interface ShellState {
  screen: Screen;
  settings: Settings;
  settingsError: string | null;
  /** null until the first library:list answer. */
  library: LibraryEntry[] | null;
  libraryError: string | null;
  /** Path of the project being opened. */
  opening: string | null;
  openError: string | null;
  paletteOpen: boolean;
  stageMode: StageMode;
  rightCollapsed: boolean;
  videoDocked: boolean;
  videoHidden: boolean;
}

export interface ShellActions {
  init: () => Promise<void>;
  go: (screen: Screen) => void;
  loadLibrary: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<string | null>;
  toggleSidebar: () => Promise<void>;
  openProject: (path: string) => Promise<void>;
  closeProject: () => void;
  addProjectFolder: () => Promise<void>;
  chooseDataRoot: () => Promise<void>;
  setPalette: (open: boolean) => void;
  setStageMode: (mode: StageMode) => void;
  toggleRight: () => void;
  setVideoDocked: (docked: boolean) => void;
  setVideoHidden: (hidden: boolean) => void;
  dismissOpenError: () => void;
}

export type Shell = ShellState & ShellActions;

export function createShellStore(bridge: Bridge, workspace: StoreApi<Workspace>): StoreApi<Shell> {
  return createStore<Shell>()((set, get) => ({
    screen: 'projects',
    settings: DEFAULT_SETTINGS,
    settingsError: null,
    library: null,
    libraryError: null,
    opening: null,
    openError: null,
    paletteOpen: false,
    stageMode: '3d',
    rightCollapsed: false,
    videoDocked: false,
    videoHidden: false,

    init: async () => {
      const [settings] = await Promise.all([bridge.call('settings:get', {}), get().loadLibrary()]);
      if (settings.ok) set({ settings: settings.value, settingsError: null });
      else set({ settingsError: settings.error });
    },

    go: (screen) => {
      set({ screen });
    },

    loadLibrary: async () => {
      const r = await bridge.call('library:list', {});
      if (r.ok) set({ library: r.value, libraryError: null });
      else set({ library: get().library ?? [], libraryError: r.error });
    },

    updateSettings: async (patch) => {
      const before = get().settings;
      set({ settings: { ...before, ...patch } });
      const r = await bridge.call('settings:set', patch);
      if (r.ok) {
        set({ settings: r.value, settingsError: null });
        return null;
      }
      // Keep the local change so the app stays usable; report the failure.
      set({ settingsError: r.error });
      return r.error;
    },

    toggleSidebar: async () => {
      await get().updateSettings({ sidebarCollapsed: !get().settings.sidebarCollapsed });
    },

    openProject: async (path) => {
      set({ opening: path, openError: null });
      const r = await bridge.call('project:open', { path });
      if (!r.ok) {
        set({ opening: null, openError: r.error });
        return;
      }
      if (!r.value.ok) {
        set({ opening: null, openError: r.value.error });
        return;
      }
      const { id, root, manifest, issues } = r.value;
      workspace.getState().openProject({ id, root, manifest }, issues);
      set({ opening: null, screen: 'scene' });
    },

    closeProject: () => {
      workspace.getState().closeProject();
      set({ screen: 'projects' });
    },

    addProjectFolder: async () => {
      const pick = await bridge.call('dialog:openFolder', { title: 'Add a project folder' });
      if (!pick.ok) {
        set({ libraryError: pick.error });
        return;
      }
      if (!pick.value.path) return;
      const added = await bridge.call('library:add', { path: pick.value.path });
      if (!added.ok) {
        set({ libraryError: added.error });
        return;
      }
      if (!added.value.ok) {
        set({ libraryError: added.value.error });
        return;
      }
      await get().loadLibrary();
    },

    chooseDataRoot: async () => {
      const pick = await bridge.call('dialog:openFolder', { title: 'Choose the data folder' });
      if (!pick.ok) {
        set({ settingsError: pick.error });
        return;
      }
      if (!pick.value.path) return;
      const err = await get().updateSettings({ dataRoot: pick.value.path });
      if (!err) await get().loadLibrary();
    },

    setPalette: (paletteOpen) => {
      set({ paletteOpen });
    },
    setStageMode: (stageMode) => {
      set({ stageMode });
    },
    toggleRight: () => {
      set({ rightCollapsed: !get().rightCollapsed });
    },
    setVideoDocked: (videoDocked) => {
      set({ videoDocked });
    },
    setVideoHidden: (videoHidden) => {
      set({ videoHidden });
    },
    dismissOpenError: () => {
      set({ openError: null });
    },
  }));
}

let shellStore: StoreApi<Shell> | null = null;

/** The app-wide shell store, bound to window.aio and the app workspace. */
export function getShell(workspace: StoreApi<Workspace>): StoreApi<Shell> {
  shellStore ??= createShellStore(createBridge(window.aio), workspace);
  return shellStore;
}

export function useShellStore<T>(store: StoreApi<Shell>, selector: (s: Shell) => T): T {
  return useStore(store, selector);
}
