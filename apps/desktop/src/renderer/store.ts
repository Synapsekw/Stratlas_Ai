import { defaultRoutes } from '@aio/ai';
import { setAnnotateReadOnly } from '@aio/annotate';
import type { LabelMode, SavedView } from '@aio/engine';
import type { LibraryEntry, PackageInfo, Settings } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createBridge, type Bridge } from './bridge';
import { landingScreen } from './legacy';
import { isPlayer } from './player';

export type Screen =
  'projects' | 'welcome' | 'scene' | 'review' | 'issues' | 'media' | 'reports' | 'settings';
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
  /** Component callouts in 3D: off, one per group, or all. */
  labelMode: LabelMode;
  /** Annotation tools shown under the stage toolbar. */
  annotating: boolean;
  /** Last 3D view per project id, so leaving and returning to Scene keeps the camera. */
  views: Record<string, SavedView>;
  /** The point cloud panel (colour, size, budget, EDL) under the stage toolbar is open. */
  cloudPanelOpen: boolean;
  /** The open project came from a `.aio` package (never written to). */
  pkg: PackageInfo | null;
  /** An encrypted package waits for its passphrase. */
  unlock: { path: string; error: string } | null;
  /** The package export dialog is open for this project id. */
  exportFor: string | null;
}

export interface ShellActions {
  init: () => Promise<void>;
  go: (screen: Screen) => void;
  loadLibrary: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<string | null>;
  toggleSidebar: () => Promise<void>;
  openProject: (path: string, passphrase?: string) => Promise<void>;
  cancelUnlock: () => void;
  /** Pick a `.aio` file and open it. */
  openPackageFile: () => Promise<void>;
  setExportFor: (projectId: string | null) => void;
  closeProject: () => void;
  addProjectFolder: () => Promise<void>;
  chooseDataRoot: () => Promise<void>;
  setPalette: (open: boolean) => void;
  setStageMode: (mode: StageMode) => void;
  toggleRight: () => void;
  setVideoDocked: (docked: boolean) => void;
  setVideoHidden: (hidden: boolean) => void;
  setLabelMode: (mode: LabelMode) => void;
  setAnnotating: (on: boolean) => void;
  saveView: (projectId: string, view: SavedView) => void;
  setCloudPanel: (open: boolean) => void;
  /** Show the point cloud panel from anywhere: the scene, in a mode with the 3D view. */
  openCloudPanel: () => void;
  dismissOpenError: () => void;
}

export type Shell = ShellState & ShellActions;

export interface ShellOptions {
  /** Player mode on or off (annotation read-only); called on every project open and close. */
  onReadOnly?: (on: boolean) => void;
}

export function createShellStore(
  bridge: Bridge,
  workspace: StoreApi<Workspace>,
  options: ShellOptions = {},
): StoreApi<Shell> {
  const setReadOnly = (on: boolean) => {
    options.onReadOnly?.(on);
  };
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
    labelMode: 'key',
    annotating: false,
    views: {},
    cloudPanelOpen: false,
    pkg: null,
    unlock: null,
    exportFor: null,

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

    openProject: async (path, passphrase) => {
      set({ opening: path, openError: null });
      const r = await bridge.call(
        'project:open',
        passphrase === undefined ? { path } : { path, passphrase },
      );
      if (!r.ok) {
        set({ opening: null, openError: r.error });
        return;
      }
      if (!r.value.ok) {
        if (r.value.needsPassphrase) set({ opening: null, unlock: { path, error: r.value.error } });
        else set({ opening: null, openError: r.value.error, unlock: null });
        return;
      }
      const { id, root, manifest, issues } = r.value;
      const pkg = r.value.package ?? null;
      const player = isPlayer(pkg);
      // Every package is opened in place and never written: no annotation, no issue edits.
      setReadOnly(pkg !== null);
      workspace.getState().openProject({ id, root, manifest }, issues);
      set({
        opening: null,
        unlock: null,
        pkg,
        annotating: pkg ? false : get().annotating,
        screen: player ? 'welcome' : landingScreen(manifest),
      });
      if (pkg) void get().loadLibrary();
    },

    cancelUnlock: () => {
      set({ unlock: null });
    },

    openPackageFile: async () => {
      const pick = await bridge.call('dialog:openFile', {
        title: 'Open a project package',
        filters: [{ name: 'Project package', extensions: ['aio'] }],
      });
      if (!pick.ok) {
        set({ openError: pick.error });
        return;
      }
      if (pick.value.path) await get().openProject(pick.value.path);
    },

    setExportFor: (exportFor) => {
      set({ exportFor });
    },

    closeProject: () => {
      workspace.getState().closeProject();
      setReadOnly(false);
      set({ screen: 'projects', pkg: null });
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
    setLabelMode: (labelMode) => {
      set({ labelMode });
    },
    setAnnotating: (annotating) => {
      // A package is never annotated.
      set({ annotating: annotating && get().pkg === null });
    },
    saveView: (projectId, view) => {
      set({ views: { ...get().views, [projectId]: view } });
    },
    setCloudPanel: (cloudPanelOpen) => {
      set({ cloudPanelOpen });
    },
    openCloudPanel: () => {
      const { stageMode } = get();
      set({
        screen: 'scene',
        stageMode: stageMode === 'map' ? '3d' : stageMode,
        cloudPanelOpen: true,
      });
    },
    dismissOpenError: () => {
      set({ openError: null });
    },
  }));
}

let shellStore: StoreApi<Shell> | null = null;

/** The app-wide shell store, bound to window.aio and the app workspace. */
export function getShell(workspace: StoreApi<Workspace>): StoreApi<Shell> {
  shellStore ??= createShellStore(createBridge(window.aio), workspace, {
    onReadOnly: setAnnotateReadOnly,
  });
  return shellStore;
}

export function useShellStore<T>(store: StoreApi<Shell>, selector: (s: Shell) => T): T {
  return useStore(store, selector);
}
