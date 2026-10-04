import type { IpcChannel, LibraryEntry, ProjectManifest, Settings } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Bridge, Res } from './bridge';
import { createShellStore, DEFAULT_SETTINGS } from './store';

type Handlers = Partial<Record<IpcChannel, (req: unknown) => unknown>>;

function fakeBridge(handlers: Handlers) {
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: Bridge = {
    call: (channel, req) => {
      calls.push({ channel, req });
      const h = handlers[channel];
      if (!h) return Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>);
      try {
        return Promise.resolve({ ok: true, value: h(req) } as Res<never>);
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e) } as Res<never>);
      }
    },
  };
  return { bridge, calls };
}

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'hcl',
  name: 'HCl Tank',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [],
  classCatalogues: [],
};

const entry: LibraryEntry = {
  id: 'hcl',
  name: 'HCl Tank',
  path: 'E:\\data\\projects\\hcl',
  kind: 'native',
};

describe('shell store', () => {
  it('loads settings and the library on init', async () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      dataRoot: 'E:\\Stratlas Data',
      sidebarCollapsed: true,
    };
    const { bridge } = fakeBridge({
      'settings:get': () => settings,
      'library:list': () => [entry],
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().init();
    expect(s.getState().settings).toEqual(settings);
    expect(s.getState().library).toEqual([entry]);
    expect(s.getState().settingsError).toBeNull();
  });

  it('keeps defaults and records the error when settings cannot load', async () => {
    const { bridge } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().init();
    expect(s.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(s.getState().settingsError).toContain('settings:get');
    expect(s.getState().library).toEqual([]);
    expect(s.getState().libraryError).toContain('library:list');
  });

  it('defaults to offline: cloud AI off', () => {
    expect(DEFAULT_SETTINGS.cloudAi).toBe(false);
  });

  it('toggles the sidebar optimistically and persists it', async () => {
    const { bridge, calls } = fakeBridge({
      'settings:set': (req) => ({ ...DEFAULT_SETTINGS, ...(req as Partial<Settings>) }),
    });
    const s = createShellStore(bridge, createWorkspace());
    const p = s.getState().toggleSidebar();
    expect(s.getState().settings.sidebarCollapsed).toBe(true);
    await p;
    expect(calls).toContainEqual({ channel: 'settings:set', req: { sidebarCollapsed: true } });
    expect(s.getState().settings.sidebarCollapsed).toBe(true);
  });

  it('keeps a local sidebar state when persisting fails', async () => {
    const { bridge } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().toggleSidebar();
    expect(s.getState().settings.sidebarCollapsed).toBe(true);
  });

  it('opens a project into the workspace and shows the scene', async () => {
    const issues = [] as never[];
    const { bridge } = fakeBridge({
      'project:open': () => ({ ok: true, id: 'hcl', root: entry.path, manifest, issues }),
    });
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    s.getState().go('settings');
    await s.getState().openProject(entry.path);
    expect(ws.getState().project?.manifest.name).toBe('HCl Tank');
    expect(s.getState().screen).toBe('scene');
    expect(s.getState().openError).toBeNull();
    expect(s.getState().opening).toBeNull();
  });

  it('opens a project that only has an original review straight into the review', async () => {
    const legacyOnly: ProjectManifest = {
      ...manifest,
      layers: [
        {
          kind: 'legacy',
          id: 'review',
          name: 'Masafi review',
          viewer: 'volumetric',
          entry: { path: 'legacy/Masafi Stockpile Review.html' },
          visible: true,
        },
      ],
    };
    const { bridge } = fakeBridge({
      'project:open': () => ({
        ok: true,
        id: 'masafi',
        root: 'E:\\m',
        manifest: legacyOnly,
        issues: [],
      }),
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().openProject('E:\\m');
    expect(s.getState().screen).toBe('review');
  });

  it('reports a project that fails to open and stays put', async () => {
    const { bridge } = fakeBridge({
      'project:open': () => ({ ok: false, error: 'Project manifest is invalid' }),
    });
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    await s.getState().openProject(entry.path);
    expect(ws.getState().project).toBeNull();
    expect(s.getState().screen).toBe('projects');
    expect(s.getState().openError).toBe('Project manifest is invalid');
  });

  it('adds a project folder chosen in the dialog and refreshes the library', async () => {
    const list = vi.fn(() => [entry]);
    const { bridge, calls } = fakeBridge({
      'dialog:openFolder': () => ({ path: entry.path }),
      'library:add': () => ({ ok: true, entry }),
      'library:list': list,
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().addProjectFolder();
    expect(calls.map((c) => c.channel)).toEqual([
      'dialog:openFolder',
      'library:add',
      'library:list',
    ]);
    expect(s.getState().library).toEqual([entry]);
  });

  it('does nothing when the folder dialog is cancelled', async () => {
    const { bridge, calls } = fakeBridge({ 'dialog:openFolder': () => ({ path: null }) });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().addProjectFolder();
    expect(calls.map((c) => c.channel)).toEqual(['dialog:openFolder']);
    expect(s.getState().libraryError).toBeNull();
  });

  it('closing the project returns to the library', async () => {
    const { bridge } = fakeBridge({
      'project:open': () => ({ ok: true, id: 'hcl', root: entry.path, manifest, issues: [] }),
    });
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    await s.getState().openProject(entry.path);
    s.getState().closeProject();
    expect(ws.getState().project).toBeNull();
    expect(s.getState().screen).toBe('projects');
  });

  it('keeps the last 3D view per project and starts with key labels and no annotation tools', () => {
    const { bridge } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace());
    expect(s.getState().labelMode).toBe('key');
    expect(s.getState().annotating).toBe(false);
    const a = {
      position: [1, 2, 3] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    };
    const b = {
      position: [9, 9, 9] as [number, number, number],
      target: [1, 1, 1] as [number, number, number],
    };
    s.getState().saveView('hcl', a);
    s.getState().saveView('alzour', b);
    s.getState().saveView('hcl', b);
    expect(s.getState().views).toEqual({ hcl: b, alzour: b });
  });

  it('opens the point cloud panel from the sidebar or the palette onto the scene', () => {
    const { bridge } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace());
    expect(s.getState().cloudPanelOpen).toBe(false);
    s.getState().openCloudPanel();
    expect(s.getState().cloudPanelOpen).toBe(true);
    expect(s.getState().screen).toBe('scene');
    expect(s.getState().stageMode).toBe('3d');
    s.getState().setCloudPanel(false);
    expect(s.getState().cloudPanelOpen).toBe(false);
  });
});
