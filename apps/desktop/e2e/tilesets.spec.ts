/**
 * 3D Tiles in the site view (M10 G7): a synthetic mesh in the tiny project becomes a tileset with
 * the `tiles.mesh` pipeline (development pipeline Python), and the site view streams it through
 * 3DTilesRendererJS: tiles load, the tileset is picked by the stage's raycaster, and the cutaway's
 * section planes cut it. The same tiles, copied out as another program's export, come back in
 * through **Import 3D Tiles** (palette): checked, copied into `tiles/<id>/`, placed by their own
 * ECEF root and streamed. History records the import and a later edit of the 3D Tiles list.
 * Zero network, as every test (the fixture asserts it).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { cp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test } from './fixtures';
import { gridGlb } from './gridGlb';

test.use({ appEnv: PIPELINE_ENV });
test.setTimeout(180_000);

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
      onFrame(cb: () => void): () => void;
      requestRender(): void;
      clippingPlanes: unknown[];
    } | null;
  };
}

/** Loaded tiles of a tileset group (0 while none). */
const loadedTiles = (win: Page, id = 'site-tiles') =>
  win.evaluate(
    (name) =>
      (window as unknown as Probe).__stratlas.stage()?.scene.getObjectByName(name)?.children
        .length ?? 0,
    `tileset:${id}`,
  );

/**
 * Wait until the stage has drawn a frame asked for now. Switching the cutaway changes the shader
 * program of every material it cuts. Their first use inside a frame used to hold the renderer for
 * seconds on a software GPU: about as long as the first tile's frame, 3.9 s on the CI runner
 * (run 38049437845). The stage now makes those programs ahead of the frame and, on a software GPU,
 * sends no frame until the graphics process has caught up (engine `stage/programWarmup.ts`;
 * `shader-compile.spec.ts` asserts it), so the frame waited for here is the first one with the
 * cut. It no longer waits for the programs, but the stage still draws on a later animation frame,
 * not when the change is made: without this the draw lands in whatever step comes next.
 */
const stageDrew = (win: Page) =>
  win.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const stage = (window as unknown as Probe).__stratlas.stage();
        if (!stage) {
          resolve();
          return;
        }
        // called as the draw starts: the animation frame after it comes once the draw has ended
        const off = stage.onFrame(() => {
          off();
          requestAnimationFrame(() => {
            resolve();
          });
        });
        stage.requestRender();
      }),
  );

async function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
  }, path);
}

test('a mesh becomes 3D Tiles that stream, pick and cut in the site view, and import back', async ({
  app,
  win,
  dataRoot,
}) => {
  test.skip(!hasPipelinePython(), 'no development pipeline Python (python/.venv)');
  await writeFile(join(dataRoot.projectDir, 'models', 'site.glb'), gridGlb());

  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

  // tiles.mesh through the app's job runner (the job runner's channel)
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
  // the cut is drawn before the palette and the import card are used: its first frame must not
  // land in a step that has the default 5 s
  await stageDrew(win);

  // Import 3D Tiles: the tiles copied out as another program's export come back in
  const exported = join(dataRoot.base, 'Bentley export');
  await cp(join(dataRoot.projectDir, 'tiles', 'site-tiles'), exported, { recursive: true });
  await answerOpenDialog(app, join(exported, 'tileset.json'));
  await win.keyboard.press('Control+K');
  await expect(win.getByRole('dialog', { name: 'Command search' })).toBeVisible();
  await win.keyboard.type('Import 3D Tiles');
  await win.keyboard.press('Enter');
  const card = win.getByTestId('tileset-import');
  await expect(card.getByRole('textbox', { name: 'Tileset name' })).toHaveValue('Bentley export');
  await card.getByRole('textbox', { name: 'Credit line' }).fill('E2E export');
  await card.getByRole('button', { name: 'Import' }).click();
  // The result shows once main has checked and copied the folder and the renderer gets a turn.
  // The import's end also makes the site view load the new tileset, and its first tile's frame
  // compiles a shader like the first tileset's did: when that frame comes before this check, the
  // check waits for it, so it gets the time the tile polls get.
  await expect(card).toContainText('Imported Bentley export', { timeout: 60_000 });
  await expect(card.getByRole('status')).toContainText('placed by its own georeference');
  expect((await readdir(join(dataRoot.projectDir, 'tiles'))).sort()).toEqual([
    'Bentley-export',
    'site-tiles',
  ]);
  const after = (await win.evaluate(async () => {
    const w = window as unknown as Probe & {
      __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
    };
    const id = w.__stratlas.workspace.getState().project?.id;
    return w.aio.invoke('tilesets:list', { projectId: id });
  })) as { ok: boolean; file: { entries: Record<string, unknown>[] } };
  expect(after.file.entries[1]).toEqual({
    id: 'Bentley-export',
    name: 'Bentley export',
    kind: 'imported',
    src: 'tiles/Bentley-export/tileset.json',
    visible: true,
    attribution: 'E2E export',
  });
  // placed by its own ECEF root, it streams in the site view beside the original
  await expect
    .poll(() => loadedTiles(win, 'Bentley-export'), { timeout: 60_000 })
    .toBeGreaterThan(0);

  // History (the Audit trail) records the import under the tileset's name
  await expect
    .poll(() => auditLabels(win), { timeout: 30_000 })
    .toContain('Imported 3D Tiles "Bentley export"');

  // renaming the imported tileset is recorded as an edit of the 3D Tiles list
  const renamed = (await win.evaluate(async () => {
    const w = window as unknown as Probe & {
      __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
    };
    const projectId = w.__stratlas.workspace.getState().project?.id;
    const r = (await w.aio.invoke('tilesets:list', { projectId })) as {
      file: { schema: string; entries: { id: string; name: string }[] };
    };
    const entries = r.file.entries.map((e) =>
      e.id === 'Bentley-export' ? { ...e, name: 'Bridge as built' } : e,
    );
    return w.aio.invoke('tilesets:write', { projectId, file: { ...r.file, entries } });
  })) as { ok: boolean; error?: string };
  expect(renamed.error).toBeUndefined();
  expect(renamed.ok).toBe(true);
  await expect.poll(() => auditLabels(win), { timeout: 30_000 }).toContain('3D Tiles list edited');
});

/**
 * The labels of the open project's History on the Audit trail, read afresh: Reports is left and
 * opened again, so the trail loads the journal as it is now.
 */
async function auditLabels(win: Page): Promise<string[]> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
  await win.getByTestId('open-audit-trail').click();
  const screen = win.getByTestId('audit-screen');
  await expect(screen).toBeVisible();
  await expect(screen.getByTestId('audit-entry').first()).toBeVisible({ timeout: 10_000 });
  return screen.locator('.aud-label').allInnerTexts();
}
