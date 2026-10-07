import { sealOp } from '@aio/journal';
import { sha256 as writerSha256 } from '@aio/project/import';
import { openZip, writeZip } from '@aio/project/package';
import {
  HUB_PATHS,
  MISSING_BLOB_HEADER,
  blobPath,
  parseMissingBlobHeader,
  type BlobRef,
  type IpcEvent,
  type ProjectManifestInput,
} from '@aio/schema';
import { hashFile } from '@aio/sync/blobs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveBlobSource, createBlobService, registerBlobsIpc, type BlobService } from './blobs';
import { collectHandlers } from './notYet';
import { createAioHandler } from './protocol/handler';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (n: number, seed = 7) => new Uint8Array(n).map((_, i) => (i * seed + 1) % 256);
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEV = `d_${'b'.repeat(52)}`;
const CHAIN = `${DEV}.r_${'c'.repeat(16)}`;
const TEAM = `t_${'d'.repeat(26)}`;

/** Synthetic files: a small model present everywhere, a big one only on the hub. */
const MODEL = bytes(3000, 3);
const BIG = bytes(200_000, 5);

function manifest(): ProjectManifestInput {
  return {
    schema: 'aio.project/1',
    id: 'synthetic-blobs',
    name: 'Synthetic blobs',
    customer: 'Example',
    site: 'Example site',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'mesh',
        id: 'model',
        name: 'Model',
        src: { path: 'models/model.glb' },
        transform: I4,
      },
      {
        kind: 'mesh',
        id: 'big',
        name: 'Big model',
        src: { path: 'models/big.glb' },
        transform: I4,
      },
      { kind: 'basemap', id: 'base', name: 'Base', pack: 'world', style: 'dark' },
    ],
    severityModels: [],
    classCatalogues: [],
  };
}

function blobOps(refs: BlobRef[]): string {
  let prev: string | null = null;
  return refs
    .map((ref, i) => {
      const op = sealOp(
        {
          v: 1,
          chain: CHAIN,
          dev: DEV,
          act: `a_${'e'.repeat(26)}`,
          seq: i + 1,
          hlc: `${String(1790000000000 + i)}.0000.${DEV}`,
          prev,
          kind: 'blob.add',
          target: { rec: 'blob', id: ref.sha256 },
        },
        ref,
      );
      prev = op.id;
      return `${JSON.stringify(op)}\n`;
    })
    .join('');
}

let base: string;
let root: string;
let userData: string;
let hubBlobs: string;
let events: IpcEvent<'blobs:progress'>[];
let registered: BlobRef[][];

async function putHub(data: Uint8Array) {
  const file = join(hubBlobs, blobPath(sha(data)).slice('blobs/'.length));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function writeTeam(fetch: Record<string, string> = {}) {
  await mkdir(join(userData, 'team'), { recursive: true });
  await writeFile(
    join(userData, 'team', 'projects.json'),
    JSON.stringify({
      schema: 'aio.team-config/1',
      projects: [
        {
          root,
          replicaId: `r_${'f'.repeat(16)}`,
          mode: 'hub',
          teamProjectId: TEAM,
          hubPath: join(base, 'hub'),
          fetch,
        },
      ],
    }),
  );
}

function service(o: { cap?: number } = {}): BlobService {
  return createBlobService({
    userData,
    projectRoot: (id) => (id === 'p' ? root : undefined),
    capBytes: () => o.cap ?? 1e12,
    emit: (e) => events.push(e),
    register: (_id, _root, refs) => {
      registered.push(refs);
      return Promise.resolve();
    },
  });
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-blobs-main-'));
  root = join(base, 'project');
  userData = join(base, 'user');
  hubBlobs = join(base, 'hub', HUB_PATHS.blobs(TEAM));
  events = [];
  registered = [];
  await mkdir(join(root, 'models'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest()));
  await writeFile(join(root, 'models', 'model.glb'), MODEL);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const refOf = (data: Uint8Array, path: string, layer: string): BlobRef => ({
  sha256: sha(data),
  size: data.length,
  path,
  role: 'source',
  layer,
});

async function sharedCopy() {
  await mkdir(join(root, 'journal', 'ops', CHAIN), { recursive: true });
  await writeFile(
    join(root, 'journal', 'ops', CHAIN, '000001.jsonl'),
    blobOps([refOf(MODEL, 'models/model.glb', 'model'), refOf(BIG, 'models/big.glb', 'big')]),
  );
  await putHub(BIG);
  await writeTeam();
}

describe('blobs IPC', () => {
  it('registers every blobs channel and answers plainly without a service', async () => {
    const ipc = collectHandlers((handle) => {
      registerBlobsIpc({ handle });
    });
    expect(ipc.channels()).toEqual([
      'blobs:cancel',
      'blobs:fetch',
      'blobs:index',
      'blobs:policy',
      'blobs:status',
    ]);
    expect(await ipc.call('blobs:status', { projectId: 'p' })).toMatchObject({ ok: false });
    expect(await ipc.call('blobs:cancel', { jobId: 'j1' })).toEqual({ ok: false });
  });

  it('answers status, policy and fetch through the validated contract', async () => {
    await sharedCopy();
    const svc = service();
    const ipc = collectHandlers((handle) => {
      registerBlobsIpc({ handle, service: svc });
    });
    const s = await ipc.call('blobs:status', { projectId: 'p' });
    expect(s).toMatchObject({ ok: true, cache: { bytes: 0, capBytes: 1e12 } });
    expect(
      await ipc.call('blobs:policy', { projectId: 'p', layer: 'big', policy: 'stream' }),
    ).toEqual({ ok: true });
    expect(await ipc.call('blobs:fetch', { jobId: 'j', projectId: 'p', layer: 'big' })).toEqual({
      ok: true,
    });
    expect(await ipc.call('blobs:status', { projectId: 'nope' })).toMatchObject({
      ok: true,
      layers: [],
    });
  });
});

describe('a project that is never shared', () => {
  it('works as before: files stay put, nothing is hashed until asked', async () => {
    const svc = service();
    const s = await svc.status('p');
    expect(s?.layers).toEqual([
      { layer: 'model', state: 'present', policy: 'always', files: 1, bytes: 3000, have: 3000 },
      { layer: 'big', state: 'missing', policy: 'always', files: 1, bytes: 0, have: 0 },
    ]);
    expect(await readdir(root)).toEqual(['manifest.json', 'models']);
    expect(await readdir(userData).catch(() => [])).toEqual([]);
    expect(await svc.lookup('p', 'models/big.glb')).toBeNull();
  });

  it('indexes lazily and incrementally, cached by size, mtime and inode', async () => {
    const svc = service();
    expect(await svc.index('i1', 'p')).toEqual({ ok: true });
    expect(registered).toEqual([[refOf(MODEL, 'models/model.glb', 'model')]]);
    expect(events.at(-1)).toMatchObject({ jobId: 'i1', state: 'done', done: 3000, total: 3000 });
    // nothing changed: no new registration
    expect(await svc.index('i2', 'p')).toEqual({ ok: true });
    expect(registered).toHaveLength(1);
    // the file changes: registered again, and the layer reads as changed until then
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(join(root, 'models', 'model.glb'), bytes(3001, 9));
    expect((await svc.status('p'))?.layers[0]?.state).toBe('stale');
    await svc.index('i3', 'p');
    expect(registered.at(-1)?.[0]?.sha256).toBe(sha(bytes(3001, 9)));
    expect((await svc.status('p'))?.layers[0]?.state).toBe('present');
    // the project folder is never written
    expect(await readdir(root)).toEqual(['manifest.json', 'models']);
  });

  it('hashes like the package writer', async () => {
    const out = await hashFile(join(root, 'models', 'model.glb'));
    expect(out.sha256).toBe(writerSha256(MODEL));
  });

  it('cancels an index job', async () => {
    await writeFile(join(root, 'models', 'big.glb'), bytes(2_000_000));
    const svc = createBlobService({
      userData,
      projectRoot: () => root,
      capBytes: () => 1e12,
      indexBytesPerSecond: 1_000_000,
    });
    const run = svc.index('slow', 'p');
    await new Promise((r) => setTimeout(r, 100));
    expect(svc.cancel('slow')).toBe(true);
    expect(await run).toEqual({ ok: false, error: 'Indexing cancelled.' });
  });
});

describe('a working copy whose binaries live on a hub', () => {
  it('opens before the binaries arrive: missing with its size, and aio:// says so', async () => {
    await sharedCopy();
    await writeTeam({ big: 'on-demand' });
    const svc = service();
    const s = await svc.status('p');
    expect(s?.layers.find((l) => l.layer === 'big')).toEqual({
      layer: 'big',
      state: 'missing',
      policy: 'on-demand',
      files: 1,
      bytes: BIG.length,
      have: 0,
    });
    const handler = createAioHandler({
      projectRoot: (id) => (id === 'p' ? root : undefined),
      packsDir: () => base,
      blob: (id, rel) => svc.lookup(id, rel),
    });
    const res = await handler(new Request('aio://project/p/models/big.glb'));
    expect(res.status).toBe(404);
    expect(parseMissingBlobHeader(res.headers.get(MISSING_BLOB_HEADER) ?? '')).toEqual({
      sha256: sha(BIG),
      size: BIG.length,
    });
    // an unknown file stays a plain 404
    const plain = await handler(new Request('aio://project/p/models/none.glb'));
    expect(plain.status).toBe(404);
    expect(plain.headers.get(MISSING_BLOB_HEADER)).toBeNull();
    // a hash ref that is not here is missing too
    const byHash = await svc.lookup('p', `assets/sha256/${'9'.repeat(64)}`);
    expect(byHash).toEqual({ kind: 'missing', sha256: '9'.repeat(64), size: 0 });

    // Download: progress, then the layer is present and served from the cache
    expect(await svc.fetch({ jobId: 'd1', projectId: 'p', layer: 'big' })).toEqual({ ok: true });
    expect(events.filter((e) => e.jobId === 'd1').at(-1)).toMatchObject({
      state: 'done',
      layer: 'big',
      done: BIG.length,
      total: BIG.length,
    });
    expect((await svc.status('p'))?.layers.find((l) => l.layer === 'big')?.state).toBe('present');
    const ok = await handler(
      new Request('aio://project/p/models/big.glb', { headers: { range: 'bytes=0-9' } }),
    );
    expect(ok.status).toBe(206);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(BIG.slice(0, 10));
  });

  it('fetches always and on-open layers without a click', async () => {
    await sharedCopy();
    const svc = service();
    await svc.status('p'); // big defaults to always (small file)
    await expect
      .poll(async () => (await svc.status('p'))?.layers.find((l) => l.layer === 'big')?.state)
      .toBe('present');
  });

  it('streams from the shared folder without copying', async () => {
    await sharedCopy();
    await writeTeam({ big: 'stream' });
    const svc = service();
    expect((await svc.status('p'))?.layers.find((l) => l.layer === 'big')?.state).toBe('streaming');
    const found = await svc.lookup('p', 'models/big.glb');
    expect(found).toMatchObject({ kind: 'file', streaming: true });
    expect(await readdir(join(userData, 'blobs')).catch(() => [])).toEqual([]);
  });

  it('a person can set a layer to stream from this machine', async () => {
    await sharedCopy();
    await writeTeam({ big: 'on-demand' });
    const svc = service();
    expect(await svc.setPolicy('p', 'big', 'stream')).toBe(true);
    expect((await svc.status('p'))?.layers.find((l) => l.layer === 'big')).toMatchObject({
      policy: 'stream',
      state: 'streaming',
    });
    expect(await svc.setPolicy('nope', 'big', 'stream')).toBe(false);
  });

  it('finds a damaged download and fetches it again', async () => {
    await sharedCopy();
    await writeTeam({ big: 'on-demand' });
    const svc = service();
    await svc.fetch({ jobId: 'd', projectId: 'p', layer: 'big' });
    const cached = svc.store.path(sha(BIG));
    const bad = Buffer.from(BIG);
    bad[5] = (bad[5] ?? 0) ^ 0xff;
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(cached, bad);
    expect((await svc.status('p'))?.layers.find((l) => l.layer === 'big')?.state).toBe('stale');
    expect(await svc.lookup('p', 'models/big.glb')).toMatchObject({ kind: 'missing' });
    expect(await svc.fetch({ jobId: 'd2', projectId: 'p', layer: 'big' })).toEqual({ ok: true });
    expect(sha(await readFile(cached))).toBe(sha(BIG));
    expect(await readdir(join(userData, 'blobs', 'quarantine'))).toHaveLength(1);
  });

  it('quarantines a hub copy that does not match and says so', async () => {
    await sharedCopy();
    await writeTeam({ big: 'on-demand' });
    const file = join(hubBlobs, blobPath(sha(BIG)).slice('blobs/'.length));
    await writeFile(file, bytes(BIG.length, 13));
    const svc = service();
    const out = await svc.fetch({ jobId: 'd', projectId: 'p', layer: 'big' });
    expect(out).toEqual({ ok: false, error: 'The copy does not match its fingerprint.' });
    expect(events.at(-1)).toMatchObject({ jobId: 'd', state: 'failed' });
    expect(await readdir(join(userData, 'blobs', 'quarantine'))).toHaveLength(2);
  });

  it('refuses a download beyond the cache size and frees only what is elsewhere', async () => {
    await sharedCopy();
    await writeTeam({ big: 'on-demand' });
    const small = service({ cap: 1000 });
    expect(await small.fetch({ jobId: 'd', projectId: 'p', layer: 'big' })).toEqual({
      ok: false,
      error: 'There is not enough room in the download cache. Free space or raise the limit.',
    });
    const svc = service();
    await svc.fetch({ jobId: 'd', projectId: 'p', layer: 'big' });
    // two more cached blobs no open project uses: one also on the hub, one held nowhere else
    const put = async (data: Uint8Array) => {
      await mkdir(dirname(svc.store.partPath(sha(data))), { recursive: true });
      await writeFile(svc.store.partPath(sha(data)), data);
      await svc.store.commit(sha(data), data.length);
    };
    const onHub = bytes(500, 17);
    const onlyHere = bytes(700, 19);
    await putHub(onHub);
    await put(onHub);
    await put(onlyHere);
    expect(await svc.freeSpace()).toEqual({ removed: 1, freed: 500 });
    expect(await svc.store.check(sha(onHub), 500)).toBe('absent');
    expect(await svc.store.check(sha(onlyHere), 700)).toBe('ok');
    expect(await svc.store.check(sha(BIG), BIG.length)).toBe('ok');
  });

  it('says when there is nowhere to download from', async () => {
    await sharedCopy();
    await rm(join(userData, 'team'), { recursive: true });
    const svc = service();
    expect(await svc.fetch({ jobId: 'd', projectId: 'p', layer: 'big' })).toEqual({
      ok: false,
      error: 'This project has no shared folder or server to download from.',
    });
  });

  it('takes the blobs a bundle carries', async () => {
    await sharedCopy();
    await rm(join(userData, 'team'), { recursive: true });
    const bundle = join(base, 'x.aiosync');
    await writeZip(bundle, [{ name: blobPath(sha(BIG)), data: BIG }]);
    const archive = await openZip(bundle);
    const src = archiveBlobSource(archive);
    expect(await src.hasBlobs([sha(BIG), sha(MODEL)])).toEqual(new Set([sha(BIG)]));
    const svc = service();
    expect(await svc.ingest('b', 'p', src)).toEqual({ ok: true, fetched: 1 });
    expect((await svc.status('p'))?.layers.find((l) => l.layer === 'big')?.state).toBe('present');
  });
});
