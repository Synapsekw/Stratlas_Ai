import { defaultRoutes } from '@aio/ai';
import { setAnnotateReadOnly } from '@aio/annotate';
import { volumetric } from '@aio/volumetric';
import type { LabelMode, SavedView } from '@aio/engine';
import {
  type LibraryEntry,
  type PackageInfo,
  type PackageOrigin,
  type Settings,
} from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createBridge, type Bridge } from './bridge';
import { landingScreen } from './legacy';
import { browserStorage, readPanelPrefs, writePanelPrefs, type PanelStorage } from './panelPrefs';
import { isPlayer } from './player';
import { videoFirst } from './stageDefault';

export type Screen =
  | 'projects'
  | 'welcome'
  | 'scene'
  | 'review'
  | 'issues'
  | 'media'
  | 'detections'
  | 'reports'
  | 'jobs'
  | 'settings'
  | 'globe';
export type StageMode = '3d' | 'map' | 'split';

/** Used until main answers settings:get. Offline first: cloud AI is off. */
export const DEFAULT_SETTINGS: Settings = {
  cloudAi: false,
  theme: 'dark',
  sidebarCollapsed: false,
  dataRoot: '',
  routes: defaultRoutes(),
  direction: 'ltr',
  offlineOnly: false,
  updateCheck: false,
  updateUrl: '',
};

/** A Settings field to focus when Settings opens (the agent panel's "Open AI settings"). */
export type SettingsFocus = 'anthropic-workspace';

/** The pages of the Settings screen. */
export type SettingsPage =
  | 'ai'
  | 'usage'
  | 'privacy'
  | 'identity'
  | 'data'
  | 'maps'
  | 'severity'
  | 'branding'
  | 'graphics'
  | 'appearance'
  | 'keyboard'
  | 'about';

export interface ShellState {
  screen: Screen;
  /** Focus this field when Settings opens; cleared once focused. */
  settingsFocus: SettingsFocus | null;
  /**
   * The Settings page something outside Settings asked for (the title bar's Download maps); null
   * once the person picks a page there or leaves Settings, which opens on AI providers.
   */
  settingsPage: SettingsPage | null;
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
  /**
   * The stage mode was chosen by opening a video-first project (3D and map side by side), not by
   * the person: the next project that is not video-first goes back to the 3D view.
   */
  stageAuto: boolean;
  /** The right panel of the Scene is folded away (remembered on this machine, panelPrefs.ts). */
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
  /** The open folder project was extracted from a package (`package-origin.json`). */
  origin: PackageOrigin | null;
}

export interface ShellActions {
  init: () => Promise<void>;
  go: (screen: Screen) => void;
  /** Open Settings (AI providers) and focus a field there. */
  openSettings: (focus?: SettingsFocus) => void;
  clearSettingsFocus: () => void;
  /** Open Settings on this page. */
  openSettingsPage: (page: SettingsPage) => void;
  /** The person picked a page in Settings: the page asked for from outside no longer holds. */
  clearSettingsPage: () => void;
  loadLibrary: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<string | null>;
  /**
   * Run a call that changes settings in main and answers with them (the report logo): its
   * settings replace the local ones only if no other change started meanwhile, as for
   * `updateSettings`. Returns the call's answer.
   */
  settingsCall: <T>(
    start: () => Promise<T>,
    settingsOf: (answer: T) => Settings | null,
  ) => Promise<T>;
  toggleSidebar: () => Promise<void>;
  openProject: (path: string, passphrase?: string) => Promise<void>;
  cancelUnlock: () => void;
  /** Pick a `.aio` file and open it. */
  openPackageFile: () => Promise<void>;
  setExportFor: (projectId: string | null) => void;
  closeProject: () => void;
  addProjectFolder: () => Promise<void>;
  /**
   * The menu of one project on the Projects screen. Each answers null when it worked, else the
   * sentence to show; the library is read again after a rename or a delete.
   */
  revealProject: (entry: LibraryEntry) => Promise<string | null>;
  renameProject: (entry: LibraryEntry, name: string) => Promise<string | null>;
  /** Moves the project folder to the recycle bin; refused while the project is open. */
  deleteProject: (entry: LibraryEntry) => Promise<string | null>;
  chooseDataRoot: () => Promise<void>;
  setPalette: (open: boolean) => void;
  setStageMode: (mode: StageMode) => void;
  toggleRight: () => void;
  /**
   * Fold the right panel away or bring it back. `setRight(false)` is what an action that needs
   * the panel calls (a picked issue's card, Show changes); a selection that merely changes never
   * unfolds it.
   */
  setRight: (collapsed: boolean) => void;
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
  /** Where the right panel's folded state is kept; the window's local storage by default. */
  storage?: PanelStorage | null;
}

export function createShellStore(
  bridge: Bridge,
  workspace: StoreApi<Workspace>,
  options: ShellOptions = {},
): StoreApi<Shell> {
  /**
   * Counts settings changes started here. A whole settings object from main replaces the local
   * one only when no change started after it was asked for: the startup read (which waits for the
   * library, slow with the demo copies) and the answer to an older change must not undo a newer
   * one (a local model chosen meanwhile went back to the default address, localhost:11434).
   */
  let settingsRev = 0;
  const setReadOnly = (on: boolean) => {
    options.onReadOnly?.(on);
  };
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  return createStore<Shell>()((set, get) => ({
    screen: 'projects',
    settingsFocus: null,
    settingsPage: null,
    settings: DEFAULT_SETTINGS,
    settingsError: null,
    library: null,
    libraryError: null,
    opening: null,
    openError: null,
    paletteOpen: false,
    stageMode: '3d',
    stageAuto: false,
    rightCollapsed: readPanelPrefs(storage).rightCollapsed,
    videoDocked: false,
    videoHidden: false,
    labelMode: 'key',
    annotating: false,
    views: {},
    cloudPanelOpen: false,
    pkg: null,
    unlock: null,
    exportFor: null,
    origin: null,

    init: async () => {
      const rev = settingsRev;
      const [settings] = await Promise.all([bridge.call('settings:get', {}), get().loadLibrary()]);
      if (!settings.ok) set({ settingsError: settings.error });
      else if (rev === settingsRev) set({ settings: settings.value, settingsError: null });
    },

    go: (screen) => {
      // leaving Settings forgets the page asked for: it opens on AI providers next time
      set(screen === 'settings' ? { screen } : { screen, settingsPage: null });
    },

    openSettings: (focus) => {
      set({ screen: 'settings', settingsFocus: focus ?? null, settingsPage: focus ? 'ai' : null });
    },

    openSettingsPage: (page) => {
      set({ screen: 'settings', settingsPage: page });
    },

    clearSettingsPage: () => {
      if (get().settingsPage) set({ settingsPage: null });
    },

    clearSettingsFocus: () => {
      if (get().settingsFocus) set({ settingsFocus: null });
    },

    loadLibrary: async () => {
      const r = await bridge.call('library:list', {});
      if (r.ok) set({ library: r.value, libraryError: null });
      else set({ library: get().library ?? [], libraryError: r.error });
    },

    updateSettings: async (patch) => {
      const rev = ++settingsRev;
      const before = get().settings;
      set({ settings: { ...before, ...patch } });
      const r = await bridge.call('settings:set', patch);
      if (r.ok) {
        // main writes changes in order, so the newest answer holds every one of them
        if (rev === settingsRev) set({ settings: r.value, settingsError: null });
        return null;
      }
      // Keep the local change so the app stays usable; report the failure.
      set({ settingsError: r.error });
      return r.error;
    },

    settingsCall: async (start, settingsOf) => {
      const rev = ++settingsRev;
      const answer = await start();
      const next = settingsOf(answer);
      if (next && rev === settingsRev) set({ settings: next, settingsError: null });
      return answer;
    },

    toggleSidebar: async () => {
      await get().updateSettings({ sidebarCollapsed: !get().settings.sidebarCollapsed });
    },

    openProject: async (path, passphrase) => {
      // A screen picked while the project is still opening (a card, then Reports) is kept.
      const from = get().screen;
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
      // drone video first, nothing 3D yet: the flights on the map beside the 3D view
      const first = videoFirst(manifest);
      const { stageAuto, stageMode } = get();
      set({
        stageMode: first ? 'split' : stageAuto ? '3d' : stageMode,
        stageAuto: first,
        opening: null,
        unlock: null,
        pkg,
        // A project extracted from a package says where it came from.
        origin: pkg ? null : (r.value.origin ?? null),
        annotating: pkg ? false : get().annotating,
        screen: get().screen !== from ? get().screen : player ? 'welcome' : landingScreen(manifest),
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
      set({ screen: 'projects', pkg: null, origin: null });
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

    revealProject: async (entry) => {
      const r = await bridge.call('library:reveal', { projectId: entry.id });
      const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
      // no dialog is open for this one: the library's own notice says it
      if (error) set({ libraryError: error });
      return error;
    },

    renameProject: async (entry, name) => {
      const r = await bridge.call('library:rename', { projectId: entry.id, name });
      if (!r.ok) return r.error;
      if (!r.value.ok) return r.value.error;
      // the open project shows its new name at once (sidebar, title bar)
      const open = workspace.getState().project;
      if (open?.root === entry.path)
        workspace.getState().replaceManifest({ ...open.manifest, name: r.value.name });
      await get().loadLibrary();
      return null;
    },

    deleteProject: async (entry) => {
      if (workspace.getState().project?.root === entry.path)
        return 'This project is open. Close it first, then delete it.';
      const r = await bridge.call('library:delete', { projectId: entry.id });
      // read the folder again either way: what is still on disk stays in the list
      await get().loadLibrary();
      if (!r.ok) return r.error;
      return r.value.ok ? null : r.value.error;
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
      set({ stageMode, stageAuto: false });
    },
    toggleRight: () => {
      get().setRight(!get().rightCollapsed);
    },
    setRight: (rightCollapsed) => {
      if (get().rightCollapsed === rightCollapsed) return;
      set({ rightCollapsed });
      writePanelPrefs(storage, { rightCollapsed });
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
    onReadOnly: (on) => {
      setAnnotateReadOnly(on);
      volumetric.getState().setReadOnly(on);
    },
  });
  return shellStore;
}

export function useShellStore<T>(store: StoreApi<Shell>, selector: (s: Shell) => T): T {
  return useStore(store, selector);
}
