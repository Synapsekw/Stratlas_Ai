import type { IpcChannel, LibraryEntry, ProjectManifest, Settings } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import type { Bridge, Res } from './bridge';
import { createShellStore, DEFAULT_SETTINGS, isSidebarFolded } from './store';

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

  // agent-local e2e, flaky on Windows CI: the startup settings came back after the library (the
  // demo copies are slow) and undid a local model chosen meanwhile; Test then probed localhost:11434.
  it("keeps a change made while it starts: init's settings are older than the change", async () => {
    let libraryDone: (v: unknown) => void = () => undefined;
    const bridge: Bridge = {
      call: (channel, req) => {
        if (channel === 'settings:get')
          return Promise.resolve({ ok: true, value: DEFAULT_SETTINGS } as Res<never>);
        if (channel === 'library:list')
          return new Promise((done) => {
            libraryDone = () => {
              done({ ok: true, value: [] } as Res<never>);
            };
          });
        if (channel === 'settings:set')
          return Promise.resolve({
            ok: true,
            value: { ...DEFAULT_SETTINGS, ...(req as Partial<Settings>) },
          } as Res<never>);
        return Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>);
      },
    };
    const s = createShellStore(bridge, createWorkspace());
    const starting = s.getState().init();
    await s.getState().updateSettings({ cloudAi: true });
    libraryDone(undefined);
    await starting;
    expect(s.getState().settings.cloudAi).toBe(true);
  });

  it("keeps the newest change when an older change's answer comes back last", async () => {
    const answers: ((v: Settings) => void)[] = [];
    const bridge: Bridge = {
      call: (channel) =>
        channel === 'settings:set'
          ? new Promise((done) => {
              answers.push((v) => {
                done({ ok: true, value: v } as Res<never>);
              });
            })
          : Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>),
    };
    const s = createShellStore(bridge, createWorkspace());
    const older = s.getState().updateSettings({ theme: 'light' });
    const newer = s.getState().updateSettings({ sidebarCollapsed: true });
    // main writes them in order: the newer answer holds both
    answers[1]?.({ ...DEFAULT_SETTINGS, theme: 'light', sidebarCollapsed: true });
    await newer;
    answers[0]?.({ ...DEFAULT_SETTINGS, theme: 'light' });
    await older;
    expect(s.getState().settings).toMatchObject({ theme: 'light', sidebarCollapsed: true });
  });

  it('keeps a change made while another call that answers with settings (a logo) runs', async () => {
    let logoDone: (v: Settings) => void = () => undefined;
    const bridge: Bridge = {
      call: (channel, req) =>
        channel === 'settings:set'
          ? Promise.resolve({
              ok: true,
              value: { ...DEFAULT_SETTINGS, ...(req as Partial<Settings>) },
            } as Res<never>)
          : Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>),
    };
    const s = createShellStore(bridge, createWorkspace());
    const logo = s.getState().settingsCall(
      () =>
        new Promise<Settings>((done) => {
          logoDone = done;
        }),
      (v) => v,
    );
    await s.getState().updateSettings({ cloudAi: true });
    // the logo's answer was read before the newer change was written
    logoDone({ ...DEFAULT_SETTINGS, reportBranding: { logo: 'logo.png' } });
    expect(await logo).toMatchObject({ reportBranding: { logo: 'logo.png' } });
    expect(s.getState().settings.cloudAi).toBe(true);
  });

  it('takes the settings a call answers with when nothing changed meanwhile', async () => {
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace());
    const next = { ...DEFAULT_SETTINGS, reportBranding: { logo: 'logo.png' } };
    await s.getState().settingsCall(
      () => Promise.resolve({ ok: true as const, settings: next }),
      (r) => r.settings,
    );
    expect(s.getState().settings.reportBranding).toEqual({ logo: 'logo.png' });
  });

  it('defaults to offline: cloud AI off', () => {
    expect(DEFAULT_SETTINGS.cloudAi).toBe(false);
  });

  it('opens Settings with a field to focus, cleared once focused', () => {
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace());
    s.getState().openSettings('anthropic-workspace');
    expect(s.getState().screen).toBe('settings');
    expect(s.getState().settingsFocus).toBe('anthropic-workspace');
    s.getState().clearSettingsFocus();
    expect(s.getState().settingsFocus).toBeNull();
    s.getState().openSettings();
    expect(s.getState().settingsFocus).toBeNull();
  });

  it('opens Settings on a page asked for from outside, until a page is picked or Settings is left', () => {
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace());
    expect(s.getState().settingsPage).toBeNull();
    s.getState().openSettingsPage('maps');
    expect(s.getState()).toMatchObject({ screen: 'settings', settingsPage: 'maps' });
    // the Settings entry of the sidebar while it is open keeps the page
    s.getState().go('settings');
    expect(s.getState().settingsPage).toBe('maps');
    s.getState().clearSettingsPage();
    expect(s.getState().settingsPage).toBeNull();
    s.getState().openSettingsPage('privacy');
    s.getState().go('projects');
    expect(s.getState().settingsPage).toBeNull();
    // a field to focus lives on AI providers
    s.getState().openSettingsPage('maps');
    s.getState().openSettings('anthropic-workspace');
    expect(s.getState().settingsPage).toBe('ai');
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

  it('reopens a sidebar the window folded without touching the setting, and remembers it', async () => {
    const { bridge, calls } = fakeBridge({
      'settings:set': (req) => ({ ...DEFAULT_SETTINGS, ...(req as Partial<Settings>) }),
    });
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    const s = createShellStore(bridge, createWorkspace(), { storage, autoFold: true });
    s.getState().setWindowWidth(1100);
    s.setState({ screen: 'scene' });
    expect(isSidebarFolded(s.getState())).toBe(true);
    // Ctrl+B on the folded rail opens it, as a remembered choice of this machine
    await s.getState().toggleSidebar();
    expect(isSidebarFolded(s.getState())).toBe(false);
    expect(s.getState().settings.sidebarCollapsed).toBe(false);
    expect(calls.some((c) => c.channel === 'settings:set')).toBe(false);
    expect(JSON.parse(data['quadrion.panels'] ?? '{}')).toMatchObject({ sidebarReopened: true });
    expect(
      createShellStore(bridge, createWorkspace(), { storage }).getState().sidebarReopened,
    ).toBe(true);
    // Ctrl+B again folds it as the person's own choice, as it always did
    await s.getState().toggleSidebar();
    expect(s.getState().settings.sidebarCollapsed).toBe(true);
    expect(calls).toContainEqual({ channel: 'settings:set', req: { sidebarCollapsed: true } });
  });

  it('folds the sidebar on its own only with the flag, in a narrow window, on a data screen', () => {
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace(), { autoFold: false });
    s.getState().setWindowWidth(1100);
    s.setState({ screen: 'scene' });
    expect(isSidebarFolded(s.getState())).toBe(false);
    s.setState({ autoFold: true });
    expect(isSidebarFolded(s.getState())).toBe(true);
    s.setState({ screen: 'settings' });
    expect(isSidebarFolded(s.getState())).toBe(false);
    s.setState({ screen: 'inspect' });
    s.getState().setWindowWidth(1440);
    expect(isSidebarFolded(s.getState())).toBe(false);
  });

  it('keeps a local sidebar state when persisting fails', async () => {
    const { bridge } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().toggleSidebar();
    expect(s.getState().settings.sidebarCollapsed).toBe(true);
  });

  it('shows the right panel until told otherwise, and remembers that it was folded', () => {
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    const { bridge, calls } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace(), { storage });
    expect(s.getState().rightCollapsed).toBe(false);
    s.getState().toggleRight();
    expect(s.getState().rightCollapsed).toBe(true);
    expect(data['quadrion.panels']).toBe(
      '{"rightCollapsed":true,"agentDockCollapsed":true,"sidebarReopened":false}',
    );
    // the choice belongs to this workstation: it is not a setting
    expect(calls).toEqual([]);
    // the next start of the app begins folded
    const again = createShellStore(bridge, createWorkspace(), { storage });
    expect(again.getState().rightCollapsed).toBe(true);
    again.getState().toggleRight();
    expect(again.getState().rightCollapsed).toBe(false);
    expect(data['quadrion.panels']).toBe(
      '{"rightCollapsed":false,"agentDockCollapsed":true,"sidebarReopened":false}',
    );
  });

  it('keeps the agent column folded until asked for, and remembers that it was opened', () => {
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    const { bridge, calls } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace(), { storage });
    expect(s.getState().agentDockCollapsed).toBe(true);
    s.getState().toggleAgentDock();
    expect(s.getState().agentDockCollapsed).toBe(false);
    expect(data['quadrion.panels']).toBe(
      '{"rightCollapsed":false,"agentDockCollapsed":false,"sidebarReopened":false}',
    );
    expect(calls).toEqual([]);
    // the next start of the app begins with the column open
    const again = createShellStore(bridge, createWorkspace(), { storage });
    expect(again.getState().agentDockCollapsed).toBe(false);
    again.getState().toggleAgentDock();
    expect(again.getState().agentDockCollapsed).toBe(true);
    expect(data['quadrion.panels']).toBe(
      '{"rightCollapsed":false,"agentDockCollapsed":true,"sidebarReopened":false}',
    );
  });

  it('remembers each of the two panels when the other one changes', () => {
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace(), { storage });
    s.getState().setAgentDock(false);
    s.getState().setRight(true);
    expect(data['quadrion.panels']).toBe(
      '{"rightCollapsed":true,"agentDockCollapsed":false,"sidebarReopened":false}',
    );
    s.getState().setAgentDock(true);
    expect(data['quadrion.panels']).toBe(
      '{"rightCollapsed":true,"agentDockCollapsed":true,"sidebarReopened":false}',
    );
    const again = createShellStore(fakeBridge({}).bridge, createWorkspace(), { storage });
    expect(again.getState()).toMatchObject({ rightCollapsed: true, agentDockCollapsed: true });
  });

  it('leaves an agent column alone that is already as asked', () => {
    const writes: string[] = [];
    const storage = {
      getItem: () => '{"rightCollapsed":true}',
      setItem: (_k: string, v: string) => {
        writes.push(v);
      },
    };
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace(), { storage });
    // a value stored before the column existed: the right panel as stored, the column folded
    expect(s.getState()).toMatchObject({ rightCollapsed: true, agentDockCollapsed: true });
    s.getState().setAgentDock(true);
    expect(writes).toEqual([]);
    s.getState().setAgentDock(false);
    s.getState().setAgentDock(false);
    expect(writes).toEqual([
      '{"rightCollapsed":true,"agentDockCollapsed":false,"sidebarReopened":false}',
    ]);
  });

  it('folds the agent column without storage (blocked, or none)', () => {
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace(), { storage: null });
    expect(s.getState().agentDockCollapsed).toBe(true);
    s.getState().toggleAgentDock();
    expect(s.getState().agentDockCollapsed).toBe(false);
  });

  it('unfolds the right panel for an action that needs it and leaves a shown one alone', () => {
    const writes: string[] = [];
    const storage = {
      getItem: () => '{"rightCollapsed":true}',
      setItem: (_k: string, v: string) => {
        writes.push(v);
      },
    };
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace(), { storage });
    expect(s.getState().rightCollapsed).toBe(true);
    s.getState().setRight(false);
    expect(s.getState().rightCollapsed).toBe(false);
    s.getState().setRight(false);
    expect(s.getState().rightCollapsed).toBe(false);
    expect(writes).toEqual([
      '{"rightCollapsed":false,"agentDockCollapsed":true,"sidebarReopened":false}',
    ]);
  });

  it('folds the right panel without storage (blocked, or none)', () => {
    const s = createShellStore(fakeBridge({}).bridge, createWorkspace(), { storage: null });
    expect(s.getState().rightCollapsed).toBe(false);
    s.getState().toggleRight();
    expect(s.getState().rightCollapsed).toBe(true);
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

  it('reads the library again before a demo opened as its working copy counts as open', async () => {
    const bundled = 'C:\\app\\resources\\demo\\yard';
    const copy = 'C:\\data\\demo\\yard';
    const { bridge } = fakeBridge({
      'project:open': () => ({ ok: true, id: 'yard', root: copy, manifest, issues: [] }),
      'library:list': () => [{ ...entry, id: 'yard', path: copy, demo: { primary: true, copy } }],
      'library:folders': () => ({ ok: true, folders: [] }),
    });
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    // the card read before the open still names the bundled folder
    s.setState({ library: [{ ...entry, id: 'yard', path: bundled, demo: { primary: true } }] });
    let listedWhenOpen: string[] | undefined;
    ws.subscribe((w) => {
      if (w.project && listedWhenOpen === undefined)
        listedWhenOpen = (s.getState().library ?? []).map((e) => e.path);
    });
    await s.getState().openProject(bundled);
    // the open project's card is the working copy from the moment it is open (its menu holds Delete)
    expect(listedWhenOpen).toEqual([copy]);
  });

  it('keeps a screen picked while the project was still opening', async () => {
    let answer: (v: unknown) => void = () => undefined;
    const bridge: Bridge = {
      call: (channel) =>
        channel === 'project:open'
          ? (new Promise((resolve) => {
              answer = resolve;
            }) as never)
          : Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>),
    };
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    const opening = s.getState().openProject(entry.path);
    s.getState().go('reports');
    answer({ ok: true, value: { ok: true, id: 'hcl', root: entry.path, manifest, issues: [] } });
    await opening;
    expect(ws.getState().project?.id).toBe('hcl');
    expect(s.getState().screen).toBe('reports');
  });

  it('opens a project that only holds a retired viewer on Scene', async () => {
    const legacyOnly: ProjectManifest = {
      ...manifest,
      layers: [
        {
          kind: 'legacy',
          id: 'viewer',
          name: 'Stockpile review',
          viewer: 'volumetric',
          entry: { path: 'legacy/Stockpile Review.html' },
          visible: true,
        },
      ],
    };
    const { bridge } = fakeBridge({
      'project:open': () => ({
        ok: true,
        id: 'yard',
        root: 'E:\\m',
        manifest: legacyOnly,
        issues: [],
      }),
    });
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    await s.getState().openProject('E:\\m');
    expect(s.getState().screen).toBe('scene');
    expect(s.getState().openError).toBeNull();
    // the manifest is kept whole: saving it must not drop the entry on disk
    expect(ws.getState().project?.manifest.layers).toEqual(legacyOnly.layers);
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
      'library:folders',
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

  it('renames a project by its library id and reads the library again', async () => {
    const renamed = { ...entry, name: 'Tank farm' };
    const { bridge, calls } = fakeBridge({
      'library:rename': () => ({ ok: true, name: 'Tank farm' }),
      'library:list': () => [renamed],
    });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().renameProject(entry, 'Tank farm')).toBeNull();
    expect(calls[0]).toEqual({
      channel: 'library:rename',
      req: { projectId: entry.id, name: 'Tank farm' },
    });
    expect(s.getState().library).toEqual([renamed]);
  });

  it('shows the new name of the open project at once', async () => {
    const { bridge } = fakeBridge({
      'project:open': () => ({ ok: true, id: entry.id, root: entry.path, manifest, issues: [] }),
      'library:rename': () => ({ ok: true, name: 'Tank farm' }),
      'library:list': () => [],
    });
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    await s.getState().openProject(entry.path);
    await s.getState().renameProject(entry, 'Tank farm');
    expect(ws.getState().project?.manifest.name).toBe('Tank farm');
    // another project renamed while this one is open leaves it alone
    await s.getState().renameProject({ ...entry, id: 'other', path: 'E:\\data\\projects\\o' }, 'X');
    expect(ws.getState().project?.manifest.name).toBe('Tank farm');
  });

  it('answers why a rename did not work and keeps the library as it is', async () => {
    const { bridge, calls } = fakeBridge({
      'library:rename': () => ({ ok: false, error: 'manifest.json is read-only' }),
    });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().renameProject(entry, 'Tank farm')).toBe('manifest.json is read-only');
    expect(calls.map((c) => c.channel)).toEqual(['library:rename']);
  });

  it('deletes a project and reads the library again', async () => {
    const { bridge, calls } = fakeBridge({
      'library:delete': () => ({ ok: true }),
      'library:list': () => [],
    });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().deleteProject(entry)).toBeNull();
    expect(calls).toEqual([
      { channel: 'library:delete', req: { projectId: entry.id } },
      { channel: 'library:list', req: {} },
      { channel: 'library:folders', req: {} },
    ]);
    expect(s.getState().library).toEqual([]);
  });

  it('keeps a project in the list when the recycle bin refused it', async () => {
    const { bridge } = fakeBridge({
      'library:delete': () => ({ ok: false, error: 'The item is in use.' }),
      'library:list': () => [entry],
    });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().deleteProject(entry)).toBe('The item is in use.');
    expect(s.getState().library).toEqual([entry]);
  });

  it('fills the folders with the library', async () => {
    const folders = [{ id: 'f_abcdefghij', name: 'Site A' }];
    const { bridge } = fakeBridge({
      'library:list': () => [entry],
      'library:folders': () => ({ ok: true, folders }),
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().loadLibrary();
    expect(s.getState().folders).toEqual(folders);
  });

  it('keeps the library and says why when the folders cannot be read', async () => {
    const { bridge } = fakeBridge({
      'library:list': () => [entry],
      'library:folders': () => ({ ok: false, error: 'folders.json is broken' }),
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().loadLibrary();
    expect(s.getState().library).toEqual([entry]);
    expect(s.getState().libraryError).toBe('folders.json is broken');
  });

  it('removes a package by its id, reads the library again and sets the notice', async () => {
    const pkg: LibraryEntry = {
      ...entry,
      path: 'E:\\data\\handover.aio',
      package: { encrypted: false, readOnly: true },
    };
    const { bridge, calls } = fakeBridge({
      'library:remove': () => ({ ok: true }),
      'library:list': () => [],
      'library:folders': () => ({ ok: true, folders: [] }),
    });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().removeProject(pkg)).toBeNull();
    expect(calls[0]).toEqual({ channel: 'library:remove', req: { projectId: pkg.id } });
    expect(calls.map((c) => c.channel)).toContain('library:list');
    expect(s.getState().library).toEqual([]);
    expect(s.getState().libraryNotice).toBe(
      `${pkg.name} was removed from the library. The file stays in ${pkg.path}. Open package brings it back.`,
    );
    s.getState().dismissLibraryNotice();
    expect(s.getState().libraryNotice).toBeNull();
  });

  it('sets no notice when the removal failed', async () => {
    const { bridge } = fakeBridge({ 'library:remove': () => ({ ok: false, error: 'No.' }) });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().removeProject(entry)).toBe('No.');
    expect(s.getState().libraryNotice).toBeNull();
  });

  it('moves a project out of its folder with folderId null', async () => {
    const { bridge, calls } = fakeBridge({ 'library:move': () => ({ ok: true }) });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().moveToFolder(entry, null)).toBeNull();
    expect(calls[0]).toEqual({
      channel: 'library:move',
      req: { projectId: entry.id, folderId: null },
    });
    expect(calls.map((c) => c.channel)).toContain('library:folders');
  });

  it('answers why a folder or thumbnail change did not work', async () => {
    const { bridge } = fakeBridge({
      'library:createFolder': () => ({ ok: false, error: 'That name is taken.' }),
      'library:setThumbnail': () => ({ ok: true, thumbnail: null }),
    });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().createFolder('Site A')).toBe('That name is taken.');
    expect(await s.getState().setThumbnail(entry.id, null)).toBeNull();
  });

  it('never asks main to delete the open project', async () => {
    const { bridge, calls } = fakeBridge({
      'project:open': () => ({ ok: true, id: entry.id, root: entry.path, manifest, issues: [] }),
      'library:delete': () => ({ ok: true }),
    });
    const ws = createWorkspace();
    const s = createShellStore(bridge, ws);
    await s.getState().openProject(entry.path);
    expect(await s.getState().deleteProject(entry)).toContain('Close it first');
    expect(calls.map((c) => c.channel)).not.toContain('library:delete');
    expect(ws.getState().project).not.toBeNull();
  });

  it('knows the open project whatever case or slashes its path is written in', async () => {
    const { bridge, calls } = fakeBridge({
      'project:open': () => ({
        ok: true,
        id: entry.id,
        root: 'e:/DATA/projects/HCL/',
        manifest,
        issues: [],
      }),
      'library:delete': () => ({ ok: true }),
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().openProject(entry.path);
    expect(await s.getState().deleteProject(entry)).toContain('Close it first');
    expect(calls.map((c) => c.channel)).not.toContain('library:delete');
  });

  it('drops a library answer that comes back after a newer one', async () => {
    const waiting: ((v: LibraryEntry[]) => void)[] = [];
    const bridge: Bridge = {
      call: (channel) => {
        if (channel === 'library:list')
          return new Promise((done) => {
            waiting.push((value) => {
              done({ ok: true, value } as Res<never>);
            });
          });
        if (channel === 'library:folders')
          return Promise.resolve({ ok: true, value: { ok: true, folders: [] } } as Res<never>);
        return Promise.resolve({ ok: false, error: `no ${channel}` } as Res<never>);
      },
    };
    const s = createShellStore(bridge, createWorkspace());
    const first = s.getState().loadLibrary();
    const second = s.getState().loadLibrary();
    const renamed = { ...entry, name: 'Renamed' };
    waiting[1]?.([renamed]);
    await second;
    waiting[0]?.([entry]);
    await first;
    expect(s.getState().library).toEqual([renamed]);
  });

  it('shows a project in its folder, and says so in the library when that fails', async () => {
    const answers = [{ ok: true }, { ok: false, error: 'Not found: the project folder.' }];
    const { bridge, calls } = fakeBridge({ 'library:reveal': () => answers.shift() });
    const s = createShellStore(bridge, createWorkspace());
    expect(await s.getState().revealProject(entry)).toBeNull();
    expect(calls[0]).toEqual({ channel: 'library:reveal', req: { projectId: entry.id } });
    expect(s.getState().libraryError).toBeNull();
    expect(await s.getState().revealProject(entry)).toContain('Not found');
    expect(s.getState().libraryError).toContain('Not found');
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

  it('keeps a picture of the last 3D view per project, in memory', () => {
    const { bridge } = fakeBridge({});
    const s = createShellStore(bridge, createWorkspace());
    expect(s.getState().lastViews).toEqual({});
    const a = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    const b = new Uint8Array([0xff, 0xd8, 0xff, 2]);
    s.getState().setLastView('hcl', a);
    s.getState().setLastView('river', a);
    s.getState().setLastView('hcl', b);
    expect(s.getState().lastViews).toEqual({ hcl: b, river: a });
  });

  it('asks for a picture of the 3D view whenever the scene of an open project is left', async () => {
    const other = { ...manifest, id: 'river', name: 'River Bridge' };
    const { bridge } = fakeBridge({
      'project:open': (req) =>
        (req as { path: string }).path === 'E:/river'
          ? { ok: true, id: 'river', root: 'E:/river', manifest: other, issues: [] }
          : { ok: true, id: 'hcl', root: entry.path, manifest, issues: [] },
    });
    const left: string[] = [];
    const s = createShellStore(bridge, createWorkspace(), {
      storage: null,
      onLeaveView: (id) => {
        left.push(id);
      },
    });
    // no project open: nothing to take
    s.getState().go('scene');
    s.getState().go('projects');
    expect(left).toEqual([]);
    await s.getState().openProject(entry.path);
    expect(s.getState().screen).toBe('scene');
    expect(left).toEqual([]);
    s.getState().go('scene'); // staying is not leaving
    s.getState().go('projects');
    expect(left).toEqual(['hcl']);
    s.getState().go('issues'); // not from the scene
    expect(left).toEqual(['hcl']);
    s.getState().go('scene');
    s.getState().openSettings();
    s.getState().go('scene');
    s.getState().openSettingsPage('maps');
    expect(left).toEqual(['hcl', 'hcl', 'hcl']);
    // another project opened from the scene: the one on screen until now
    s.getState().go('scene');
    await s.getState().openProject('E:/river');
    expect(left).toEqual(['hcl', 'hcl', 'hcl', 'hcl']);
    s.getState().closeProject();
    expect(left).toEqual(['hcl', 'hcl', 'hcl', 'hcl', 'river']);
  });

  it('ends annotating when another project opens, not when the same one opens again', async () => {
    const other = { ...manifest, id: 'river', name: 'River Bridge' };
    const { bridge } = fakeBridge({
      'project:open': (req) =>
        (req as { path: string }).path === 'E:/river'
          ? { ok: true, id: 'river', root: 'E:/river', manifest: other, issues: [] }
          : { ok: true, id: 'hcl', root: entry.path, manifest, issues: [] },
    });
    const s = createShellStore(bridge, createWorkspace(), { storage: null });
    await s.getState().openProject(entry.path);
    s.getState().setAnnotating(true);
    await s.getState().openProject(entry.path);
    expect(s.getState().annotating).toBe(true);
    await s.getState().openProject('E:/river');
    expect(s.getState().annotating).toBe(false);
  });

  it('leaves the scene even when taking the picture throws', async () => {
    const { bridge } = fakeBridge({
      'project:open': () => ({ ok: true, id: 'hcl', root: entry.path, manifest, issues: [] }),
    });
    const s = createShellStore(bridge, createWorkspace(), {
      storage: null,
      onLeaveView: () => {
        throw new Error('lost context');
      },
    });
    await s.getState().openProject(entry.path);
    s.getState().go('projects');
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
  it('opens a video-first project with the 3D view and the map side by side', async () => {
    const clip = {
      kind: 'video',
      id: 'clip-1',
      name: 'Clip 1',
      visible: true,
      src: { path: 'video/clip-1.mp4' },
      flight: { src: { path: 'flights/clip-1.json' }, startUtcMs: 0 },
      lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.7778 },
      offsetMs: 0,
    } as const;
    const videoOnly = { ...manifest, id: 'site', layers: [clip] } as ProjectManifest;
    let open = videoOnly;
    const { bridge } = fakeBridge({
      'project:open': () => ({
        ok: true,
        id: open.id,
        root: entry.path,
        manifest: open,
        issues: [],
      }),
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().openProject(entry.path);
    expect(s.getState().stageMode).toBe('split');
    // a project with nothing placed (no video) goes back to the 3D view it was chosen for
    open = manifest;
    await s.getState().openProject(entry.path);
    expect(s.getState().stageMode).toBe('3d');
    // a mode the person picks stays
    open = videoOnly;
    await s.getState().openProject(entry.path);
    s.getState().setStageMode('map');
    open = manifest;
    await s.getState().openProject(entry.path);
    expect(s.getState().stageMode).toBe('map');
  });

  it('does not count a retired viewer as 3D content of a video-first project', async () => {
    const withViewer = {
      ...manifest,
      id: 'site',
      layers: [
        {
          kind: 'video',
          id: 'clip-1',
          name: 'Clip 1',
          visible: true,
          src: { path: 'video/clip-1.mp4' },
          flight: { src: { path: 'flights/clip-1.json' }, startUtcMs: 0 },
          lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.7778 },
          offsetMs: 0,
        },
        {
          kind: 'legacy',
          id: 'viewer',
          name: 'Old viewer',
          viewer: 'aik',
          entry: { path: 'legacy/index.html' },
          visible: true,
        },
      ],
    } as ProjectManifest;
    const { bridge } = fakeBridge({
      'project:open': () => ({
        ok: true,
        id: withViewer.id,
        root: entry.path,
        manifest: withViewer,
        issues: [],
      }),
    });
    const s = createShellStore(bridge, createWorkspace());
    await s.getState().openProject(entry.path);
    expect(s.getState().stageMode).toBe('split');
  });
});
