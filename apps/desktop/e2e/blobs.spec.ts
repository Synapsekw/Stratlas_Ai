/**
 * Files on demand (M9 T6) on a synthetic working copy (no client data): the project's big model
 * is registered by a `blob.add` op and lives only in a synthetic hub folder. The project opens
 * before the file arrives, the layer shows "Not on this computer", `aio://` answers the
 * missing-blob 404, and Download fetches it with progress, cancel and resume (the transfer rate is
 * capped by QUADRION_E2E_BLOB_RATE so each step is visible), after which the model renders.
 * Stream from shared folder reads the hub in place without copying. A project that is never
 * shared shows nothing new.
 */
import { sealOp } from '@aio/journal';
import { HUB_PATHS, ProjectManifest, blobPath, type BlobRef } from '@aio/schema';
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, tinyGlb, tinyManifest, type DataRoot } from './fixtures';

const TEAM = `t_${'e'.repeat(26)}`;
const DEV = `d_${'q'.repeat(52)}`;
const CHAIN = `${DEV}.r_${'s'.repeat(16)}`;
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** 2 MB/s: the 6 MB model takes about three seconds, long enough to cancel and resume. */
const RATE = String(2 * 1024 * 1024);
const BIG_PAD = 6 * 1024 * 1024;

/** The tiny quad moved 10 m east, with `pad` unused bytes in its buffer (a big, valid GLB). */
function bigGlb(pad: number): Buffer {
  const glb = tinyGlb();
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen)) as {
    buffers: { byteLength: number }[];
    accessors: { min?: number[]; max?: number[] }[];
  };
  const binStart = 20 + jsonLen + 8;
  const bin = Buffer.from(glb.subarray(binStart));
  for (let i = 0; i < 4; i++) bin.writeFloatLE(bin.readFloatLE(i * 12) + 10, i * 12);
  const body = Buffer.concat([bin, Buffer.alloc(pad)]);
  const first = json.buffers[0];
  const acc = json.accessors[0];
  if (!first || !acc) throw new Error('unexpected GLB');
  first.byteLength = body.length;
  acc.min = [10, 0, -1];
  acc.max = [11, 0, 0];
  const pad4 = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad4(body, 0);
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(jsonChunk, 0x4e4f534a), chunk(binChunk, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}

const BIG = bigGlb(BIG_PAD);
const BIG_SHA = createHash('sha256').update(BIG).digest('hex');

/** A working copy of a hub project: the big model registered, on the hub, not in the folder. */
async function sharedCopy(dataRoot: DataRoot): Promise<void> {
  const manifest = tinyManifest();
  manifest.layers.push({
    kind: 'mesh',
    id: 'big',
    name: 'Big synthetic model',
    visible: true,
    src: { path: 'models/big.glb' },
    transform: I4,
  });
  await writeFile(
    join(dataRoot.projectDir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(manifest), null, 2),
  );
  const ref: BlobRef = {
    sha256: BIG_SHA,
    size: BIG.length,
    path: 'models/big.glb',
    role: 'source',
    layer: 'big',
  };
  const op = sealOp(
    {
      v: 1,
      chain: CHAIN,
      dev: DEV,
      act: `a_${'r'.repeat(26)}`,
      seq: 1,
      hlc: `1790000000000.0000.${DEV}`,
      prev: null,
      kind: 'blob.add',
      target: { rec: 'blob', id: BIG_SHA },
    },
    ref,
  );
  const ops = join(dataRoot.projectDir, 'journal', 'ops', CHAIN);
  await mkdir(ops, { recursive: true });
  await writeFile(join(ops, '000001.jsonl'), `${JSON.stringify(op)}\n`);

  const hub = join(dataRoot.base, 'hub');
  const blob = join(hub, HUB_PATHS.blobs(TEAM), blobPath(BIG_SHA).slice('blobs/'.length));
  await mkdir(dirname(blob), { recursive: true });
  await writeFile(blob, BIG);
  await mkdir(join(dataRoot.userData, 'team'), { recursive: true });
  await writeFile(
    join(dataRoot.userData, 'team', 'projects.json'),
    JSON.stringify({
      schema: 'aio.team-config/1',
      projects: [
        {
          root: dataRoot.projectDir,
          replicaId: `r_${'s'.repeat(16)}`,
          mode: 'hub',
          teamProjectId: TEAM,
          hubPath: hub,
          fetch: { big: 'on-demand' },
        },
      ],
    }),
  );
}

interface Probe {
  __stratlas: { stage(): { contentBounds(): { max: { x: number } } | null } | null };
}

/** East edge of what the scene shows: 1 with the quad only, 11 once the big model renders. */
const eastEdge = (win: Page) =>
  win.evaluate(
    () => (window as unknown as Probe).__stratlas.stage()?.contentBounds()?.max.x ?? null,
  );

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
}

/** Downloaded blobs in userData (the `<aa>` folders of the cache). */
async function cachedBlobs(userData: string): Promise<string[]> {
  const dir = join(userData, 'blobs');
  const tops = (await readdir(dir).catch(() => [] as string[])).filter((t) =>
    /^[a-f0-9]{2}$/.test(t),
  );
  const out: string[] = [];
  for (const t of tops) out.push(...(await readdir(join(dir, t))));
  return out;
}

test.describe('a working copy whose binaries live on a hub', () => {
  test.use({ appEnv: { QUADRION_E2E_BLOB_RATE: RATE } });
  test.beforeEach(async ({ dataRoot }) => {
    await sharedCopy(dataRoot);
  });

  test('opens before the model arrives; Download shows progress, cancels, resumes and renders', async ({
    win,
    dataRoot,
  }) => {
    await openTiny(win);
    const card = win.getByTestId('layer-placeholder');
    await expect(card).toContainText('1 layer is not on this computer');
    const row = card.locator('[data-testid="files-row"][data-layer="big"]');
    await expect(row).toContainText('Big synthetic model');
    await expect(row.getByTestId('files-state')).toHaveText('Not on this computer (6.0 MB)');
    await expect.poll(() => eastEdge(win)).toBe(1);

    // aio:// says what is missing instead of failing blindly
    const answer = await win.evaluate(async (id) => {
      const r = await fetch(`aio://project/${id}/models/big.glb`);
      return { status: r.status, header: r.headers.get('x-aio-blob') };
    }, dataRoot.projectId);
    expect(answer).toEqual({ status: 404, header: `missing ${BIG_SHA} ${String(BIG.length)}` });

    await row.getByRole('button', { name: 'Download' }).click();
    await expect(row.getByTestId('files-state')).toContainText('Downloading');
    await expect(row.locator('progress')).toBeVisible();
    await expect
      .poll(() => row.locator('progress').evaluate((p) => (p as HTMLProgressElement).value))
      .toBeGreaterThan(0.1);
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByTestId('files-state')).toContainText('Paused at');
    const partial = await readdir(join(dataRoot.userData, 'blobs', 'partial'));
    expect(partial).toEqual([`${BIG_SHA}.part`]);

    await row.getByRole('button', { name: 'Resume' }).click();
    await expect(card).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => eastEdge(win), { timeout: 30_000 }).toBe(11);
    expect(await cachedBlobs(dataRoot.userData)).toEqual([BIG_SHA]);
  });

  test('Stream from shared folder shows the model without copying it', async ({
    win,
    dataRoot,
  }) => {
    await openTiny(win);
    const card = win.getByTestId('layer-placeholder');
    await card.getByRole('button', { name: 'Files' }).click();
    const panel = win.getByTestId('files-panel');
    const row = panel.locator('[data-testid="files-row"][data-layer="big"]');
    await row.getByTestId('files-policy').selectOption('stream');
    await expect(row.getByTestId('files-state')).toHaveText('Streaming from the shared folder');
    await expect.poll(() => eastEdge(win), { timeout: 30_000 }).toBe(11);
    expect(await cachedBlobs(dataRoot.userData)).toEqual([]);
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
  });
});

test('a project that is never shared shows nothing new', async ({ win, dataRoot }) => {
  await openTiny(win);
  const status = await win.evaluate(
    (projectId) => window.aio.invoke('blobs:status', { projectId }),
    dataRoot.projectId,
  );
  expect(status).toMatchObject({
    ok: true,
    layers: [{ layer: 'quad', state: 'present', policy: 'always', files: 1 }],
  });
  await expect.poll(() => eastEdge(win)).toBe(1);
  await expect(win.getByTestId('layer-placeholder')).toHaveCount(0);
  expect(await cachedBlobs(dataRoot.userData)).toEqual([]);
});
