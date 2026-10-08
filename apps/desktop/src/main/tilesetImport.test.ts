import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from './notYet';
import { ecefRoot, insideUri, isInside, tilesetIdFrom } from './tilesetImport';
import { registerTilesetsIpc, type PackageMembers } from './tilesets';

let base: string;
let project: string;
let src: string;
const packages = new Map<string, PackageMembers>();

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-tileset-import-'));
  project = join(base, 'project');
  src = join(base, 'Site export 2026');
  await mkdir(project, { recursive: true });
  await mkdir(src, { recursive: true });
  packages.clear();
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const ipc = collectHandlers((handle) => {
  registerTilesetsIpc({
    handle,
    projectRoot: (id) => (id === 'p' ? project : undefined),
    projectPackage: (id) => packages.get(id),
  });
});

/** An ECEF root transform near the tiny project's site (lon 51, lat 28.9). */
const ECEF = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3519453.2, 4346282.1, 3065740.9, 1];

const tile = (over: Record<string, unknown> = {}) => ({
  boundingVolume: { box: [0, 0, 0, 50, 0, 0, 0, 50, 0, 0, 0, 20] },
  geometricError: 0,
  ...over,
});

const tileset = (root: Record<string, unknown>, version = '1.1') => ({
  asset: { version, generator: 'Other program' },
  geometricError: 100,
  root: { geometricError: 50, refine: 'REPLACE', ...root },
});

async function put(rel: string, data: unknown): Promise<void> {
  const p = join(src, ...rel.split('/'));
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, typeof data === 'string' ? data : JSON.stringify(data));
}

/** A valid export: an ECEF root, two levels, an external tileset in a sub folder. */
async function validExport(rootOver: Record<string, unknown> = { transform: ECEF }) {
  await put(
    'tileset.json',
    tileset({
      ...tile(),
      ...rootOver,
      content: { uri: 'Data/root%20tile.glb' },
      children: [tile({ content: { uri: 'Data/sub/tileset.json' } })],
    }),
  );
  await put('Data/root tile.glb', 'glb');
  await put('Data/sub/tileset.json', tileset({ ...tile(), content: { uri: 'leaf.b3dm' } }, '1.0'));
  await put('Data/sub/leaf.b3dm', 'b3dm');
}

const tree = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) =>
      join(d.parentPath, d.name)
        .slice(dir.length + 1)
        .replace(/\\/g, '/'),
    )
    .sort();

const listed = async () => {
  const r = await ipc.call('tilesets:list', { projectId: 'p' });
  return r.ok ? r.file.entries : null;
};

describe('tilesets:import', () => {
  it('registers the import channel with the others', () => {
    expect(ipc.channels()).toEqual(['tilesets:import', 'tilesets:list', 'tilesets:write']);
  });

  it('copies a georeferenced export into tiles/<id>/ and lists it visible', async () => {
    await validExport();
    const r = await ipc.call('tilesets:import', {
      projectId: 'p',
      path: join(src, 'tileset.json'),
      attribution: '© Survey Co',
    });
    expect(r).toEqual({
      ok: true,
      entry: {
        id: 'Site-export-2026',
        name: 'Site export 2026',
        kind: 'imported',
        src: 'tiles/Site-export-2026/tileset.json',
        visible: true,
        attribution: '© Survey Co',
      },
    });
    expect(await tree(join(project, 'tiles', 'Site-export-2026'))).toEqual([
      'Data/root tile.glb',
      'Data/sub/leaf.b3dm',
      'Data/sub/tileset.json',
      'tileset.json',
    ]);
    // nothing left over from the copy, and the list is saved
    expect(await readdir(join(project, 'tiles'))).toEqual(['Site-export-2026']);
    expect((await listed())?.map((e) => e.id)).toEqual(['Site-export-2026']);
  });

  it('lists a tileset in a local frame hidden until it is placed, under a unique id', async () => {
    await validExport({ transform: undefined });
    const first = await ipc.call('tilesets:import', {
      projectId: 'p',
      path: join(src, 'tileset.json'),
      name: 'Tank farm',
    });
    expect(first).toMatchObject({ ok: true, entry: { id: 'Tank-farm', visible: false } });
    const again = await ipc.call('tilesets:import', {
      projectId: 'p',
      path: join(src, 'tileset.json'),
      name: 'tank farm',
    });
    expect(again).toMatchObject({ ok: true, entry: { id: 'tank-farm-2' } });
    expect((await listed())?.map((e) => e.id)).toEqual(['Tank-farm', 'tank-farm-2']);
    // the second write kept the first list as the .bak
    const bak = JSON.parse(await readFile(join(project, 'tilesets.json.bak'), 'utf8')) as {
      entries: unknown[];
    };
    expect(bak.entries).toHaveLength(1);
  });

  const refused = async (message: RegExp) => {
    const r = await ipc.call('tilesets:import', {
      projectId: 'p',
      path: join(src, 'tileset.json'),
    });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(message);
    // nothing copied, nothing listed
    expect(await readdir(join(project, 'tiles')).catch(() => [])).toEqual([]);
    expect(await listed()).toEqual([]);
  };

  it.each([
    ['../secret.glb', /outside the tileset folder/],
    ['Data/../../secret.glb', /outside the tileset folder/],
    ['%2e%2e/secret.glb', /outside the tileset folder/],
    ['..%5csecret.glb', /outside the tileset folder/],
    ['C:/Windows/win.ini', /outside the tileset folder/],
    ['/etc/passwd', /outside the tileset folder/],
    ['\\\\server\\share\\a.glb', /outside the tileset folder/],
    ['http://example.com/a.glb', /outside the tileset folder/],
    ['file:///C:/a.glb', /outside the tileset folder/],
    ['data:application/octet-stream;base64,AAAA', /outside the tileset folder/],
    ['Data/missing.glb', /not in the tileset folder/],
  ])('refuses content URI %s', async (uri, message) => {
    await put('../secret.glb', 'outside');
    await put('tileset.json', tileset({ ...tile(), content: { uri } }));
    await refused(message);
  });

  it('refuses a traversal inside an external tileset, checked from its own folder', async () => {
    await put('tileset.json', tileset({ ...tile(), content: { uri: 'a/tileset.json' } }));
    await put('a/tileset.json', tileset({ ...tile(), content: { uri: '../../x.glb' } }));
    await refused(/a\/tileset\.json .*outside the tileset folder/);
  });

  it('checks implicit tiling templates for their path only', async () => {
    const implicit = (uri: string, subtrees: string) =>
      tileset({
        ...tile(),
        transform: ECEF,
        content: { uri },
        implicitTiling: {
          subdivisionScheme: 'QUADTREE',
          subtreeLevels: 2,
          availableLevels: 2,
          subtrees: { uri: subtrees },
        },
      });
    await put('tileset.json', implicit('content/{level}/{x}/{y}.glb', 'subtrees/{level}.subtree'));
    await put('content/0/0/0.glb', 'glb');
    const ok = await ipc.call('tilesets:import', {
      projectId: 'p',
      path: join(src, 'tileset.json'),
    });
    expect(ok).toMatchObject({ ok: true, entry: { visible: true } });
    await rm(join(project, 'tiles'), { recursive: true });
    await rm(join(project, 'tilesets.json'));
    await rm(join(project, 'tilesets.json.bak'), { force: true });
    await put('tileset.json', implicit('../{level}/{x}/{y}.glb', 'subtrees/{level}.subtree'));
    await refused(/outside the tileset folder/);
  });

  it.each([
    ['not json', /not a JSON file/],
    [JSON.stringify({ asset: { version: '0.0' }, root: tile() }), /version "0.0"; 1.0 and 1.1/],
    [JSON.stringify({ asset: { version: '1.1' } }), /no root tile/],
    [JSON.stringify({ hello: 1 }), /not a 3D Tiles tileset/],
    [
      JSON.stringify(tileset({ geometricError: 1, children: [{ geometricError: 1 }] })),
      /without a bounding volume/,
    ],
  ])('refuses a root that is not 3D Tiles 1.0 or 1.1 (%#)', async (text, message) => {
    await put('tileset.json', text);
    await refused(message);
  });

  it('refuses a folder holding a link', async () => {
    await validExport();
    const outside = join(base, 'elsewhere');
    await mkdir(outside);
    try {
      await symlink(outside, join(src, 'Data', 'linked'), 'junction');
    } catch {
      return; // links not allowed here: nothing to check
    }
    await refused(/holds a link/);
  });

  it('refuses the project folder itself and packages', async () => {
    await writeFile(join(project, 'tileset.json'), JSON.stringify(tileset(tile())));
    const r = await ipc.call('tilesets:import', {
      projectId: 'p',
      path: join(project, 'tileset.json'),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/holds this project/);
    packages.set('pkg', { entries: new Map(), read: () => Promise.resolve(Buffer.alloc(0)) });
    expect(
      await ipc.call('tilesets:import', { projectId: 'pkg', path: join(src, 'tileset.json') }),
    ).toMatchObject({ ok: false, code: 'read-only' });
    expect(
      await ipc.call('tilesets:import', { projectId: 'nope', path: join(src, 'tileset.json') }),
    ).toMatchObject({ ok: false });
  });
});

describe('tileset import helpers', () => {
  it('resolves URIs relative to the tileset that names them', () => {
    expect(insideUri('b/c.glb', 'a', 'x')).toBe('a/b/c.glb');
    expect(insideUri('../c.glb?v=2#frag', 'a', 'x')).toBe('c.glb');
    expect(() => insideUri('../c.glb', '', 'x')).toThrow(/outside/);
    expect(() => insideUri('', '', 'x')).toThrow(/empty/);
    expect(() => insideUri(42, '', 'x')).toThrow(/empty/);
    expect(() => insideUri('%E0%A4%A', '', 'x')).toThrow(/not valid/);
  });

  it('knows an Earth centred root', () => {
    expect(ecefRoot({ transform: ECEF })).toBe(true);
    expect(ecefRoot({ transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1] })).toBe(false);
    expect(
      ecefRoot({ boundingVolume: { box: [3519453, 4346282, 3065740, 9, 0, 0, 0, 9, 0, 0, 0, 9] } }),
    ).toBe(true);
    expect(ecefRoot({ boundingVolume: { region: [0.89, 0.5, 0.9, 0.51, 0, 100] } })).toBe(false);
    expect(ecefRoot(null)).toBe(false);
  });

  it('makes file-name safe, unique ids', () => {
    expect(tilesetIdFrom('Tank farm (North)', new Set())).toBe('Tank-farm-North');
    expect(tilesetIdFrom('Café', new Set(['cafe']))).toBe('Cafe-2');
    expect(tilesetIdFrom('موقع', new Set())).toBe('tileset');
    expect(tilesetIdFrom('..', new Set())).toBe('tileset');
  });

  it('knows when a folder is inside another', () => {
    expect(isInside(join(base, 'a', 'b'), base)).toBe(true);
    expect(isInside(base, base)).toBe(true);
    expect(isInside(join(base, '..'), base)).toBe(false);
  });
});
