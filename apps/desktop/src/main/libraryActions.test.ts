import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteProject,
  managedProjectFolder,
  registerLibraryActionsIpc,
  renameProject,
  type LibraryActionsDeps,
} from './libraryActions';
import { collectHandlers } from './notYet';
import { ProjectRegistry } from './project';
import {
  installRealDataGuard,
  realDataRefusals,
  setRealDataRoot,
  uninstallRealDataGuard,
} from './realDataGuard';
import { sampleManifest, writeProject } from './testing';

let base: string;
let dataRoot: string;
let projects: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-library-actions-'));
  dataRoot = join(base, 'data');
  projects = join(dataRoot, 'projects');
  await mkdir(projects, { recursive: true });
  realDataRefusals().splice(0);
});
afterEach(async () => {
  uninstallRealDataGuard();
  realDataRefusals().splice(0);
  await rm(base, { recursive: true, force: true });
});

const manifestOf = async (root: string) =>
  JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const yard = () =>
  writeProject(join(projects, 'north-yard'), sampleManifest({ name: 'North yard' }));
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? '' : (r.error ?? ''));

describe('managedProjectFolder', () => {
  it('accepts a project folder directly inside <dataRoot>/projects', async () => {
    const root = await yard();
    expect(await managedProjectFolder(dataRoot, root)).toEqual({ ok: true, root });
    // the data folder written with a trailing separator or another case of slash
    expect(await managedProjectFolder(`${dataRoot}/`, root)).toEqual({ ok: true, root });
  });

  it('never accepts the data folder itself or its projects folder', async () => {
    await writeFile(join(dataRoot, 'manifest.json'), JSON.stringify(sampleManifest()));
    await writeFile(join(projects, 'manifest.json'), JSON.stringify(sampleManifest()));
    for (const p of [dataRoot, projects, `${projects}${sep}.`, `${projects}${sep}x${sep}..`]) {
      const r = await managedProjectFolder(dataRoot, p);
      expect(r.ok, p).toBe(false);
      expect(errorOf(r)).toContain('is not a project folder inside');
    }
  });

  it('refuses a path that leaves the projects folder through ..', async () => {
    const outside = await writeProject(join(base, 'elsewhere'), sampleManifest());
    // written out, not normalised: the names a careless caller could pass
    const sneaky = `${projects}${sep}..${sep}..${sep}elsewhere`;
    const viaChild = `${projects}${sep}north-yard${sep}..${sep}..${sep}..${sep}elsewhere`;
    const root = await yard();
    for (const p of [sneaky, viaChild, outside])
      expect((await managedProjectFolder(dataRoot, p)).ok, p).toBe(false);
    // a name that ends inside projects again is judged by where it ends
    const round = `${projects}${sep}x${sep}..${sep}north-yard`;
    expect(await managedProjectFolder(dataRoot, round)).toEqual({ ok: true, root });
  });

  it('refuses a folder deeper down, beside the data folder, or in a look-alike folder', async () => {
    const deep = await writeProject(join(projects, 'group', 'inner'), sampleManifest());
    const packs = await writeProject(join(dataRoot, 'packs', 'p'), sampleManifest());
    const alike = await writeProject(join(`${dataRoot}-old`, 'projects', 'p'), sampleManifest());
    for (const p of [deep, packs, alike])
      expect((await managedProjectFolder(dataRoot, p)).ok, p).toBe(false);
  });

  it('refuses when no data folder is set', async () => {
    const root = await yard();
    const r = await managedProjectFolder('', root);
    expect(errorOf(r)).toContain('No data folder is set');
  });

  it('refuses a missing folder, a file and a folder without a manifest', async () => {
    expect(errorOf(await managedProjectFolder(dataRoot, join(projects, 'gone')))).toContain(
      'Folder not found',
    );
    await writeFile(join(projects, 'notes.txt'), 'x');
    expect(errorOf(await managedProjectFolder(dataRoot, join(projects, 'notes.txt')))).toContain(
      'is not a folder',
    );
    await mkdir(join(projects, 'empty'));
    expect(errorOf(await managedProjectFolder(dataRoot, join(projects, 'empty')))).toContain(
      'holds no manifest.json',
    );
  });

  it('refuses a link that only looks like a folder in projects', async () => {
    const target = await writeProject(join(base, 'elsewhere', 'real'), sampleManifest());
    const link = join(projects, 'linked');
    // a directory junction needs no privilege on Windows; a symlink elsewhere
    fs.symlinkSync(target, link, 'junction');
    const r = await managedProjectFolder(dataRoot, link);
    expect(errorOf(r)).toContain('is a link to a folder somewhere else');
  });

  it.runIf(process.platform === 'win32')('ignores case on Windows', async () => {
    const root = await yard();
    expect((await managedProjectFolder(dataRoot.toUpperCase(), root)).ok).toBe(true);
  });
});

describe('renameProject', () => {
  it('changes the name in manifest.json and nothing else, keeping a backup', async () => {
    const root = await yard();
    const before = await manifestOf(root);
    expect(await renameProject(root, '  North yard, phase 2  ')).toEqual({
      ok: true,
      name: 'North yard, phase 2',
    });
    const after = await manifestOf(root);
    expect(after).toEqual({ ...before, name: 'North yard, phase 2' });
    expect(after.id).toBe(before.id);
    // the folder keeps its name; the previous manifest is beside the new one
    expect(fs.existsSync(root)).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'manifest.json.bak'), 'utf8'))).toEqual(before);
  });

  it('keeps what this build does not know: extra keys and layers of a newer kind', async () => {
    const root = join(projects, 'north-yard');
    const future = { kind: 'hologram', id: 'holo', name: 'From a newer build', beam: 7 };
    const raw = {
      ...sampleManifest({ name: 'North yard' }),
      aiPolicy: 'forbid',
      somethingNew: { a: 1 },
    };
    await writeProject(root, { ...raw, layers: [...raw.layers, future] });
    expect((await renameProject(root, 'South yard')).ok).toBe(true);
    const after = await manifestOf(root);
    expect(after.name).toBe('South yard');
    expect(after.aiPolicy).toBe('forbid');
    expect(after.somethingNew).toEqual({ a: 1 });
    expect(after.layers).toContainEqual(future);
  });

  it('writes nothing when the name is the same', async () => {
    const root = await yard();
    expect(await renameProject(root, 'North yard')).toEqual({ ok: true, name: 'North yard' });
    expect(fs.existsSync(join(root, 'manifest.json.bak'))).toBe(false);
  });

  it('refuses an empty name, a broken manifest and one from a newer version, untouched', async () => {
    const root = await yard();
    expect(errorOf(await renameProject(root, '   '))).toContain('needs a name');

    await writeFile(join(root, 'manifest.json'), '{ not json');
    expect(errorOf(await renameProject(root, 'X'))).toContain('Could not read');
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe('{ not json');

    const newer = JSON.stringify({ ...sampleManifest(), schema: 'aio.project/2' });
    await writeFile(join(root, 'manifest.json'), newer);
    expect(errorOf(await renameProject(root, 'X'))).toContain('newer version');
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe(newer);
  });

  it('is refused under the e2e guard when the project is in the real data', async () => {
    const root = await yard();
    installRealDataGuard({ QUADRION_E2E: '1', QUADRION_REAL_DATA_ROOT: dataRoot });
    const r = await renameProject(root, 'Renamed by a test');
    expect(errorOf(r)).toContain('E2E real-data guard');
    uninstallRealDataGuard();
    expect((await manifestOf(root)).name).toBe('North yard');
    expect(realDataRefusals().length).toBeGreaterThan(0);
  });
});

describe('deleteProject', () => {
  /** A stand-in recycle bin: the folder is moved, never removed. */
  const bin = () => {
    const dir = join(base, 'bin');
    return {
      dir,
      trash: vi.fn(async (p: string) => {
        await mkdir(dir, { recursive: true });
        await rename(p, join(dir, 'north-yard'));
      }),
    };
  };

  it('releases the folder, moves it to the recycle bin, then forgets it', async () => {
    const root = await yard();
    const order: string[] = [];
    const { dir, trash } = bin();
    const r = await deleteProject(root, {
      release: (p) => {
        order.push(`release ${p}`);
        return Promise.resolve();
      },
      trash: async (p) => {
        order.push(`trash ${p}`);
        await trash(p);
      },
      forget: (p) => {
        order.push(`forget ${p}`);
        return Promise.resolve();
      },
    });
    expect(r).toEqual({ ok: true });
    expect(order).toEqual([`release ${root}`, `trash ${root}`, `forget ${root}`]);
    expect(fs.existsSync(root)).toBe(false);
    // moved whole, not erased
    expect((await manifestOf(join(dir, 'north-yard'))).name).toBe('North yard');
  });

  it('leaves the project where it is when the recycle bin refuses', async () => {
    const root = await yard();
    const forget = vi.fn(() => Promise.resolve());
    const r = await deleteProject(root, {
      trash: () => Promise.reject(new Error('The item is in use')),
      forget,
    });
    expect(errorOf(r)).toContain('could not be moved to the recycle bin: The item is in use');
    expect(errorOf(r)).toContain('Nothing was deleted');
    expect((await manifestOf(root)).name).toBe('North yard');
    expect(forget).not.toHaveBeenCalled();
  });

  it('does not report a delete when the folder is still there afterwards', async () => {
    const root = await yard();
    const forget = vi.fn(() => Promise.resolve());
    const r = await deleteProject(root, { trash: () => Promise.resolve(), forget });
    expect(errorOf(r)).toContain('the recycle bin did not take it');
    expect(forget).not.toHaveBeenCalled();
  });

  it('never removes anything itself: no trash, no delete', async () => {
    const root = await yard();
    const r = await deleteProject(root, {
      trash: () => Promise.reject(new Error('The recycle bin is not available')),
    });
    expect(r.ok).toBe(false);
    expect(fs.existsSync(join(root, 'manifest.json'))).toBe(true);
  });

  it('is refused under the e2e guard when the project is in the real data', async () => {
    const root = await yard();
    const { trash } = bin();
    setRealDataRoot(dataRoot);
    const r = await deleteProject(root, { trash });
    setRealDataRoot(null);
    expect(errorOf(r)).toContain('E2E real-data guard');
    expect(trash).not.toHaveBeenCalled();
    expect(fs.existsSync(root)).toBe(true);
    expect(realDataRefusals().join('\n')).toContain('move to the recycle bin');
  });
});

describe('library action channels', () => {
  function setup(over: Partial<LibraryActionsDeps> = {}) {
    const registry = new ProjectRegistry();
    const reveal = vi.fn();
    const renamed = vi.fn();
    const trash = vi.fn(async (p: string) => {
      await mkdir(join(base, 'bin'), { recursive: true });
      await rename(p, join(base, 'bin', 'gone'));
    });
    const ipc = collectHandlers((handle) => {
      registerLibraryActionsIpc({
        handle,
        projects: registry,
        dataRoot: () => dataRoot,
        reveal,
        renamed,
        trash,
        ...over,
      });
    });
    return { registry, ipc, reveal, renamed, trash };
  }

  it('registers the three channels', () => {
    expect(setup().ipc.channels()).toEqual(['library:delete', 'library:rename', 'library:reveal']);
  });

  it('renames a project by its library id and says so to main', async () => {
    const root = await yard();
    const { registry, ipc, renamed } = setup();
    const id = registry.register(root);
    expect(await ipc.call('library:rename', { projectId: id, name: ' West yard ' })).toEqual({
      ok: true,
      name: 'West yard',
    });
    expect((await manifestOf(root)).name).toBe('West yard');
    expect(renamed).toHaveBeenCalledWith(id, 'West yard');
  });

  it('rejects a request without a usable name before any handler runs', async () => {
    const root = await yard();
    const { registry, ipc } = setup();
    const id = registry.register(root);
    await expect(ipc.call('library:rename', { projectId: id, name: '   ' })).rejects.toThrow(
      'Invalid request on library:rename',
    );
    await expect(
      ipc.call('library:rename', { projectId: id, name: 'x'.repeat(121) }),
    ).rejects.toThrow('Invalid request on library:rename');
    // a path is not part of the contract: the renderer names the project, main finds the folder
    await expect(
      ipc.call('library:delete', { projectId: id, path: dataRoot } as never),
    ).rejects.toThrow('Invalid request on library:delete');
  });

  it('refuses an id the library does not know', async () => {
    const { ipc, trash } = setup();
    for (const channel of ['library:reveal', 'library:delete'] as const) {
      const r = await ipc.call(channel, { projectId: 'nope' });
      expect(errorOf(r)).toContain('There is no project "nope" in the library');
    }
    expect(trash).not.toHaveBeenCalled();
  });

  it('refuses to rename or delete a package, a demo project and a folder added from elsewhere', async () => {
    const pkg = join(projects, 'handover.aio');
    await writeFile(pkg, 'zip');
    const demo = await writeProject(join(base, 'demo', 'sample'), sampleManifest());
    const added = await writeProject(join(base, 'elsewhere', 'added'), sampleManifest());
    const { registry, ipc, trash } = setup({ isDemo: (p) => Promise.resolve(p === demo) });
    const cases: [string, string][] = [
      [registry.register(pkg), 'is a package'],
      [registry.register(demo), 'demo project that ships with the app'],
      [registry.register(added), 'is not a project folder inside'],
    ];
    for (const [id, why] of cases) {
      expect(errorOf(await ipc.call('library:rename', { projectId: id, name: 'X' }))).toContain(
        why,
      );
      expect(errorOf(await ipc.call('library:delete', { projectId: id }))).toContain(why);
    }
    expect(trash).not.toHaveBeenCalled();
    expect(fs.existsSync(pkg)).toBe(true);
    expect((await manifestOf(added)).name).not.toBe('X');
  });

  it('moves a project to the recycle bin by its library id', async () => {
    const root = await yard();
    const release = vi.fn(() => Promise.resolve());
    const forget = vi.fn(() => Promise.resolve());
    const { registry, ipc, trash } = setup({ release, forget });
    const id = registry.register(root);
    expect(await ipc.call('library:delete', { projectId: id })).toEqual({ ok: true });
    expect(trash).toHaveBeenCalledWith(root);
    expect(release).toHaveBeenCalledWith(root);
    expect(forget).toHaveBeenCalledWith(root);
    expect(fs.existsSync(root)).toBe(false);
    // only that folder went: the data folder and its projects folder are still there
    expect(fs.existsSync(projects)).toBe(true);
  });

  it('does not delete while a job runs in the project', async () => {
    const root = await yard();
    const { registry, ipc, trash } = setup({ jobRunningIn: (p) => p === root });
    const r = await ipc.call('library:delete', { projectId: registry.register(root) });
    expect(errorOf(r)).toContain('A job is running in this project');
    expect(trash).not.toHaveBeenCalled();
    expect(fs.existsSync(root)).toBe(true);
  });

  it('shows a project folder or a package file in the file manager', async () => {
    const root = await yard();
    const pkg = join(projects, 'handover.aio');
    await writeFile(pkg, 'zip');
    const { registry, ipc, reveal } = setup();
    expect(await ipc.call('library:reveal', { projectId: registry.register(root) })).toEqual({
      ok: true,
    });
    expect(await ipc.call('library:reveal', { projectId: registry.register(pkg) })).toEqual({
      ok: true,
    });
    expect(reveal.mock.calls).toEqual([[root], [pkg]]);

    await rm(root, { recursive: true });
    const gone = await ipc.call('library:reveal', { projectId: 'north-yard' });
    expect(errorOf(gone)).toContain('Not found');
    expect(reveal).toHaveBeenCalledTimes(2);
  });
});
