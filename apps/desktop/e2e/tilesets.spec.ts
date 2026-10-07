/**
 * 3D Tiles in the site view (M10 G7): a synthetic mesh in the tiny project becomes a tileset with
 * the `tiles.mesh` pipeline (development pipeline Python), and the site view streams it through
 * 3DTilesRendererJS: tiles load, the tileset is picked by the stage's raycaster, and the cutaway's
 * section planes cut it. Zero network, as every test (the fixture asserts it).
 */
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test } from './fixtures';

test.use({ appEnv: PIPELINE_ENV });
test.setTimeout(180_000);

const GRID = 81; // 80 x 80 quads, 12 800 triangles
const SPAN = 60; // metres, centred on the project origin

/** A grid surface 2 m above the ground, in the project local frame (y up), as a GLB. */
function gridGlb(): Buffer {
  const pos = new Float32Array(GRID * GRID * 3);
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const k = (j * GRID + i) * 3;
      const x = -SPAN / 2 + (SPAN * i) / (GRID - 1);
      const z = -SPAN / 2 + (SPAN * j) / (GRID - 1);
      pos[k] = x;
      pos[k + 1] = 2 + 0.3 * Math.sin(x / 7) * Math.cos(z / 9);
      pos[k + 2] = z;
    }
  const idx = new Uint32Array((GRID - 1) * (GRID - 1) * 6);
  let p = 0;
  for (let j = 0; j < GRID - 1; j++)
    for (let i = 0; i < GRID - 1; i++) {
      const a = j * GRID + i;
      idx.set([a, a + GRID, a + 1, a + 1, a + GRID, a + GRID + 1], p);
      p += 6;
    }
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    min = min.map((m, a) => Math.min(m, pos[i + a] ?? 0));
    max = max.map((m, a) => Math.max(m, pos[i + a] ?? 0));
  }
  const gltf = {
    asset: { version: '2.0', generator: 'aio e2e tilesets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'grid' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: GRID * GRID, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
  };
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const body = pad(bin, 0);
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(json, 0x4e4f534a), chunk(body, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}

interface Probe {
  aio: { invoke(channel: string, req: unknown): Promise<unknown> };
  __stratlas: {
    stage(): {
      scene: {
        getObjectByName(n: string): {
          children: unknown[];
          userData: Record<string, unknown>;
          traverse(cb: (o: { material?: { clippingPlanes?: unknown[] | null } }) => void): void;
        } | null;
      };
      raycast(x: number, y: number): { object: { userData: Record<string, unknown> } } | null;
      setSection(p: object): void;
      setViewPreset(p: string): void;
      clippingPlanes: unknown[];
    } | null;
  };
}

/** Loaded tiles of the tileset group (0 while none). */
const loadedTiles = (win: Page) =>
  win.evaluate(
    () =>
      (window as unknown as Probe).__stratlas.stage()?.scene.getObjectByName('tileset:site-tiles')
        ?.children.length ?? 0,
  );

test('a mesh becomes 3D Tiles that stream, pick and cut in the site view', async ({
  win,
  dataRoot,
}) => {
  test.skip(!hasPipelinePython(), 'no development pipeline Python (python/.venv)');
  await writeFile(join(dataRoot.projectDir, 'models', 'site.glb'), gridGlb());

  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

  // tiles.mesh through the app's job runner (the Jobs panel's channel)
  const started = (await win.evaluate(
    ({ project }) =>
      (window as unknown as Probe).aio.invoke('jobs:start', {
        pipeline: 'tiles.mesh',
        project,
        params: { src: 'models/site.glb', name: 'Site grid', maxTrianglesPerTile: 3000 },
      }),
    { project: dataRoot.projectDir },
  )) as { ok: boolean; job?: { id: string }; error?: string };
  expect(started.error).toBeUndefined();
  const jobId = started.job?.id ?? '';
  await expect
    .poll(
      async () => {
        const r = (await win.evaluate(() =>
          (window as unknown as Probe).aio.invoke('jobs:list', {}),
        )) as { jobs: { id: string; status: string; error?: string }[] };
        const j = r.jobs.find((x) => x.id === jobId);
        return j?.status === 'failed' ? `failed: ${j.error ?? ''}` : j?.status;
      },
      { timeout: 120_000 },
    )
    .toBe('done');

  // listed in tilesets.json
  const listed = (await win.evaluate(async () => {
    const w = window as unknown as Probe & {
      __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
    };
    const id = w.__stratlas.workspace.getState().project?.id;
    return w.aio.invoke('tilesets:list', { projectId: id });
  })) as { ok: boolean; file: { entries: { id: string; kind: string }[] } };
  expect(listed.file.entries).toEqual([
    expect.objectContaining({ id: 'site-tiles', kind: 'mesh', name: 'Site grid' }),
  ]);

  // the site view streams it (the job's end refreshes the list)
  await win.evaluate(() => (window as unknown as Probe).__stratlas.stage()?.setViewPreset('top'));
  await expect.poll(() => loadedTiles(win), { timeout: 60_000 }).toBeGreaterThan(0);

  // the stage's raycaster picks the tileset in the middle of the view
  const hit = await win.evaluate(() => {
    const h = (window as unknown as Probe).__stratlas.stage()?.raycast(0, 0);
    return h ? String(h.object.userData.layerId) : null;
  });
  expect(hit).toBe('tileset:site-tiles');

  // the cutaway's planes cut the tiles
  const cut = await win.evaluate(() => {
    const stage = (window as unknown as Probe).__stratlas.stage();
    stage?.setSection({ enabled: true, mode: 'vertical', bearingDeg: 90, offset: 0 });
    let shared = 0;
    stage?.scene.getObjectByName('tileset:site-tiles')?.traverse((o) => {
      if (o.material?.clippingPlanes === stage.clippingPlanes) shared += 1;
    });
    return { shared, planes: stage?.clippingPlanes.length ?? 0 };
  });
  expect(cut.shared).toBeGreaterThan(0);
  expect(cut.planes).toBeGreaterThan(0);
});
