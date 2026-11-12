import type { AddonCatalogueEntry, AddonManifest, AddonProgress } from '@aio/schema';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import type { FetchLike } from '../update/download';
import { fakeAddonArchive, fakeCatalogue, fakeCatalogueEntry, type FakeAddon } from './addon.fakes';
import { addonBaseUrl, archiveUrl, parseCatalogue, readCatalogue } from './catalogue';
import { installAddonArchive, readInstalledAddon } from './install';
import { archiveNameId, progressThrottle, registerAddonsIpc } from './ipc';

let base: string;
let dataRoot: string;
let server: Server;
let url: string;
/** What the fake server answers, by path. */
let routes: Map<string, Buffer | string>;
let requests: string[];
/** Paths the fake server answers with a 302 to another address. */
let redirects: Map<string, string>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-addons-ipc-'));
  dataRoot = join(base, 'data');
  routes = new Map();
  redirects = new Map();
  requests = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const to = redirects.get(req.url ?? '');
    if (to !== undefined) {
      res.statusCode = 302;
      res.setHeader('location', to);
      res.end();
      return;
    }
    const body = routes.get(req.url ?? '');
    if (body === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-length', String(Buffer.byteLength(body)));
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/addons/`;
});
afterEach(async () => {
  await new Promise<void>((r) =>
    server.close(() => {
      r();
    }),
  );
  await rm(base, { recursive: true, force: true });
});

const fetchLike: FetchLike = (u, init) => fetch(u, init);

function serve(addons: readonly FakeAddon[], tweak?: (e: AddonCatalogueEntry) => void) {
  const entries = addons.map((a) => {
    const e = fakeCatalogueEntry(a);
    tweak?.(e);
    routes.set(`/addons/${a.fileName}`, a.bytes);
    return e;
  });
  routes.set('/addons/catalogue.json', JSON.stringify(fakeCatalogue(entries)));
}

function setup(
  o: {
    offline?: boolean;
    baseUrl?: string;
    pack?: string | null;
    confirm?: (m: AddonManifest) => Promise<boolean>;
    free?: number;
  } = {},
) {
  const progress: AddonProgress[] = [];
  const picked = { path: null as string | null };
  let ipc: ReturnType<typeof registerAddonsIpc> | null = null;
  const h = collectHandlers((handle) => {
    ipc = registerAddonsIpc({
      handle,
      dataRoot: () => dataRoot,
      env: {},
      settings: () => ({ offlineOnly: o.offline ?? false, baseUrl: o.baseUrl ?? url }),
      fetch: fetchLike,
      chooseFile: () => Promise.resolve(picked.path),
      emit: (p) => progress.push(p),
      packVersion: () => Promise.resolve(o.pack === undefined ? '0.35.0' : o.pack),
      ...(o.confirm ? { confirmUnlisted: o.confirm } : {}),
      ...(o.free !== undefined ? { freeBytes: () => Promise.resolve(o.free ?? null) } : {}),
    });
  });
  return { ...h, progress, picked, ipc };
}

const road = (version = '1.0.0', extra: Partial<Parameters<typeof fakeAddonArchive>[0]> = {}) =>
  fakeAddonArchive({
    id: 'road-defects',
    kind: 'detector',
    version,
    name: 'Road defects',
    ...extra,
  });

describe('catalogue', () => {
  it('takes the address from the environment, then Settings, and only https or loopback', () => {
    expect(
      addonBaseUrl({ QUADRION_ADDONS_URL: 'https://a.example/x' }, 'https://b.example'),
    ).toEqual({ url: 'https://a.example/x/' });
    expect(addonBaseUrl({}, 'https://b.example/addons/')).toEqual({
      url: 'https://b.example/addons/',
    });
    expect(addonBaseUrl({}, undefined)).toEqual({ url: null });
    expect(addonBaseUrl({}, 'http://b.example/')).toMatchObject({ url: null, error: /https/ });
    expect(addonBaseUrl({}, 'http://localhost:8080')).toEqual({ url: 'http://localhost:8080/' });
  });

  it('takes a literal 127.x.y.z address as this computer, never a name that starts so', () => {
    expect(addonBaseUrl({}, 'http://127.0.0.2:9000/a')).toEqual({
      url: 'http://127.0.0.2:9000/a/',
    });
    expect(addonBaseUrl({}, 'http://127.evil.example/')).toMatchObject({ url: null });
    expect(addonBaseUrl({}, 'http://127.0.0.1.example.com/')).toMatchObject({ url: null });
  });

  it('refuses a catalogue or an archive the server sends on to an address it may not read', async () => {
    const a = road();
    serve([a]);
    const port = new URL(url).port;
    routes.set('/addons/real.json', routes.get('/addons/catalogue.json') ?? '');
    // the catalogue: every hop is checked before it is asked, never only the last one
    redirects.set('/addons/catalogue.json', `http://[::ffff:7f00:1]:${port}/addons/real.json`);
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /sends the app on to http:\/\/\[::ffff:7f00:1\]:\d+, which the app does not read/,
    });
    expect(requests).not.toContain('/addons/real.json');
    // a plain-http hop on this computer that sends the request on to https elsewhere
    redirects.set('/addons/catalogue.json', `http://localhost:${port}/addons/hop`);
    redirects.set('/addons/hop', `http://[::ffff:7f00:1]:${port}/addons/real.json`);
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /which the app does not read add-ons from/,
    });
    expect(requests).toContain('/addons/hop');
    expect(requests).not.toContain('/addons/real.json');
    // a redirect that stays on this computer is fine
    redirects.set('/addons/hop', `http://localhost:${port}/addons/real.json`);
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({ ok: true });
    // a loop gives up
    redirects.set('/addons/hop', `http://localhost:${port}/addons/catalogue.json`);
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /too many times/,
    });
    // a fetch that followed a redirect anyway, or hides where it leads, is refused
    const followed: FetchLike = () => {
      const res = new Response('{}', { status: 200 });
      Object.defineProperty(res, 'redirected', { value: true });
      return Promise.resolve(res);
    };
    expect(await readCatalogue({ base: url, fetch: followed })).toMatchObject({
      ok: false,
      error: /somewhere it could not check/,
    });
    redirects.delete('/addons/catalogue.json');
    // the archive: the same
    redirects.set(`/addons/${a.fileName}`, `http://[::ffff:7f00:1]:${port}/addons/x.aioaddon`);
    routes.set('/addons/x.aioaddon', a.bytes);
    const r = await setup().call('addons:install', { id: 'road-defects' });
    expect(r).toMatchObject({ ok: false, code: 'network', error: /not https/ });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
  });

  it('refuses a catalogue larger than 1 MB, also without a length', async () => {
    const huge = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) });
    routes.set('/addons/catalogue.json', huge);
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /too large/,
    });
    const chunked: FetchLike = () =>
      Promise.resolve(new Response(new Blob([huge]).stream(), { status: 200 }));
    expect(await readCatalogue({ base: url, fetch: chunked })).toMatchObject({
      ok: false,
      error: /too large/,
    });
  });

  it('resolves archive addresses against the base and refuses plain http elsewhere', () => {
    const e = fakeCatalogueEntry(road());
    expect(archiveUrl('https://a.example/addons/', e)).toEqual({
      ok: true,
      url: 'https://a.example/addons/road-defects-1.0.0.aioaddon',
    });
    expect(
      archiveUrl('https://a.example/addons/', {
        ...e,
        archive: { ...e.archive, url: 'http://evil.example/x.aioaddon' },
      }),
    ).toMatchObject({ ok: false });
  });

  it('says why a catalogue is not one', async () => {
    expect(parseCatalogue({ schema: 'x' })).toMatchObject({ ok: false });
    const e = fakeCatalogueEntry(road());
    expect(parseCatalogue(fakeCatalogue([e, e]))).toMatchObject({
      ok: false,
      error: /twice/,
    });
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /HTTP 404/,
    });
    routes.set('/addons/catalogue.json', 'not json');
    expect(await readCatalogue({ base: url, fetch: fetchLike })).toMatchObject({
      ok: false,
      error: /not JSON/,
    });
  });
});

describe('addons:list', () => {
  it('lists the known add-ons with the catalogue, an update and a pack problem', async () => {
    serve([road('1.1.0', { minPipelinePack: '0.36.0' })]);
    const old = road('1.0.0');
    await writeFile(join(base, old.fileName), old.bytes);
    await installAddonArchive(join(base, old.fileName), { dataRoot });
    const { call } = setup();
    const r = await call('addons:list', {});
    expect(r.catalogueError).toBeUndefined();
    expect(r.baseUrl).toBe(url);
    expect(r.addons.map((a) => a.id)).toEqual([
      'road-defects',
      'segmentation',
      'ground-classifier',
    ]);
    const row = r.addons[0];
    expect(row).toMatchObject({
      installed: { manifest: { version: '1.0.0' } },
      available: { manifest: { version: '1.1.0' } },
      update: true,
      problem:
        'Road defects needs processing tools 0.36.0 or later (these are 0.35.0). Update them in Settings, Processing tools.',
    });
    expect(r.addons[1]).toMatchObject({ installed: null, available: null, update: false });
  });

  it('never reads the catalogue offline, and says so', async () => {
    serve([road()]);
    const { call } = setup({ offline: true });
    const r = await call('addons:list', {});
    expect(r.catalogueError).toMatch(/Offline only/);
    expect(requests).toEqual([]);
    const none = await setup({ baseUrl: '' }).call('addons:list', {});
    expect(none).toMatchObject({ baseUrl: null, catalogueError: /No add-on address/ });
  });
});

describe('addons:install', () => {
  it('downloads, checks and installs, with progress', async () => {
    serve([road()]);
    const { call, progress } = setup();
    const r = await call('addons:install', { id: 'road-defects' });
    expect(r).toMatchObject({ ok: true, manifest: { id: 'road-defects' } });
    expect(progress.some((p) => p.phase === 'download')).toBe(true);
    expect(progress.at(-1)).toMatchObject({ id: 'road-defects', phase: 'done' });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).not.toBeNull();
    // the download is gone once installed
    expect(await readdir(join(dataRoot, 'runtime', 'addons', '.download'))).toEqual([]);
  });

  it('refuses a size or SHA-256 that does not match the catalogue', async () => {
    serve([road()], (e) => {
      e.archive.sizeBytes -= 10;
    });
    const short = await setup().call('addons:install', { id: 'road-defects' });
    expect(short).toMatchObject({
      ok: false,
      code: 'network',
      error: /larger than the add-on list says/,
    });
    serve([road()], (e) => {
      e.archive.sha256 = 'd'.repeat(64);
    });
    const { call, progress } = setup();
    const bad = await call('addons:install', { id: 'road-defects' });
    expect(bad).toMatchObject({ ok: false, error: /does not match the add-on list \(SHA-256\)/ });
    expect(progress.at(-1)).toMatchObject({ phase: 'failed' });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
  });

  it('refuses a tampered archive the catalogue vouches for', async () => {
    const tampered = road('1.0.0', { override: { 'model.onnx': 'not the model' } });
    serve([tampered]);
    const r = await setup().call('addons:install', { id: 'road-defects' });
    expect(r).toMatchObject({ ok: false, code: 'refused' });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
  });

  it('refuses offline, an unknown id, an old pack and a second install at once', async () => {
    serve([road('1.0.0', { minPipelinePack: '0.40.0' })]);
    expect(
      await setup({ offline: true }).call('addons:install', { id: 'road-defects' }),
    ).toMatchObject({ ok: false, code: 'offline' });
    expect(requests).toEqual([]);
    expect(await setup().call('addons:install', { id: 'segmentation' })).toMatchObject({
      ok: false,
      error: /does not offer "segmentation"/,
    });
    expect(
      await setup({ pack: null }).call('addons:install', { id: 'road-defects' }),
    ).toMatchObject({
      ok: false,
      error: /needs processing tools 0.40.0 or later. Install them/,
    });
    serve([road()]);
    const { call } = setup();
    const [a, b] = await Promise.all([
      call('addons:install', { id: 'road-defects' }),
      call('addons:install', { id: 'road-defects' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ code: 'busy' });
  });
});

describe('addons:installFile and addons:remove', () => {
  it('installs only a file main picked, offline too', async () => {
    const a = road();
    const path = join(base, a.fileName);
    await writeFile(path, a.bytes);
    const { call, picked, progress } = setup({ offline: true });
    expect(await call('addons:installFile', { path })).toMatchObject({
      ok: false,
      error: /Choose file first/,
    });
    picked.path = path;
    expect(await call('addons:choose', {})).toEqual({ path });
    expect(await call('addons:installFile', { path })).toMatchObject({ ok: true });
    expect(progress.at(-1)).toMatchObject({ id: 'road-defects', phase: 'done' });
    expect(await call('addons:remove', { id: 'road-defects' })).toEqual({ ok: true });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
    expect(await call('addons:remove', { id: 'road-defects' })).toMatchObject({ ok: false });
  });

  it('compares a chosen file with the catalogue when it lists that version', async () => {
    const listed = road();
    serve([listed]);
    const other = road('1.0.0', { name: 'Road defects (rebuilt)' });
    const path = join(base, other.fileName);
    await writeFile(path, other.bytes);
    const { call, picked } = setup();
    picked.path = path;
    await call('addons:choose', {});
    expect(await call('addons:installFile', { path })).toMatchObject({
      ok: false,
      error: /the add-on catalogue lists \(SHA-256\)/,
    });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
  });

  it('asks before a chosen file the catalogue does not list, never for one it does', async () => {
    const a = road();
    const path = join(base, a.fileName);
    await writeFile(path, a.bytes);
    const asked: string[] = [];
    const answer = { value: false };
    const { call, picked } = setup({
      offline: true,
      confirm: (m) => {
        asked.push(m.id);
        return Promise.resolve(answer.value);
      },
    });
    picked.path = path;
    await call('addons:choose', {});
    expect(await call('addons:installFile', { path })).toMatchObject({
      ok: false,
      code: 'refused',
    });
    expect(await readInstalledAddon(dataRoot, 'road-defects')).toBeNull();
    answer.value = true;
    expect(await call('addons:installFile', { path })).toMatchObject({ ok: true });
    expect(asked).toEqual(['road-defects', 'road-defects']);
    // the catalogue lists this very file: no question
    serve([a]);
    const listed = setup({ confirm: () => Promise.reject(new Error('asked')) });
    listed.picked.path = path;
    await listed.call('addons:choose', {});
    expect(await listed.call('addons:installFile', { path })).toMatchObject({ ok: true });
  });

  it('refuses a chosen add-on the pipeline pack is too old for', async () => {
    const a = road('1.0.0', { minPipelinePack: '0.40.0' });
    const path = join(base, a.fileName);
    await writeFile(path, a.bytes);
    const { call, picked } = setup({ offline: true });
    picked.path = path;
    await call('addons:choose', {});
    expect(await call('addons:installFile', { path })).toMatchObject({
      ok: false,
      error: /Road defects needs processing tools 0.40.0 or later \(these are 0.35.0\)/,
    });
  });

  it('checks the disk has room for the download and the add-on before downloading', async () => {
    serve([road()]);
    const r = await setup({ free: 1024 }).call('addons:install', { id: 'road-defects' });
    expect(r).toMatchObject({ ok: false, code: 'refused', error: /needs .* free .* to download/ });
    expect(requests.filter((p) => p.endsWith('.aioaddon'))).toEqual([]);
  });

  it('puts back an old version an interrupted swap left aside when it starts', async () => {
    const a = road();
    await writeFile(join(base, a.fileName), a.bytes);
    await installAddonArchive(join(base, a.fileName), { dataRoot });
    const root = join(dataRoot, 'runtime', 'addons');
    await rename(join(root, 'road-defects'), join(root, '.replaced-0123.tmp'));
    const r = await setup({ offline: true }).call('addons:list', {});
    expect(r.addons[0]).toMatchObject({
      id: 'road-defects',
      installed: { manifest: { version: '1.0.0' } },
    });
  });
});

describe('helpers', () => {
  it('reads the id from an archive name', () => {
    expect(archiveNameId('road-defects-1.2.0.aioaddon')).toBe('road-defects');
    expect(archiveNameId('road-defects-1.2.0 (1).aioaddon')).toBe('road-defects');
    expect(archiveNameId('road.zip')).toBeNull();
  });

  it('throttles progress but keeps phase changes and the end', () => {
    const out: AddonProgress[] = [];
    let t = 0;
    const p = progressThrottle(
      'x',
      (e) => out.push(e),
      () => t,
    );
    p({ phase: 'download', bytesDone: 0, bytesTotal: 10 });
    t = 10;
    p({ phase: 'download', bytesDone: 5, bytesTotal: 10 });
    t = 20;
    p({ phase: 'download', bytesDone: 10, bytesTotal: 10 });
    p({ phase: 'unpack', bytesDone: 0, bytesTotal: 10 });
    expect(out.map((e) => `${e.phase}:${String(e.bytesDone)}`)).toEqual([
      'download:0',
      'download:10',
      'unpack:0',
    ]);
  });
});
