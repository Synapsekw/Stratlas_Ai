import { fromWgs84 } from '@aio/geo';
import { withExif } from '@aio/project/builder/testing';
import type { ElectronApplication, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test, tinyGlb } from './fixtures';

/** Make the next native open dialog return these files (Electron main process). */
async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}

interface Inspect {
  __stratlas: {
    workspace: { getState: () => { flyTo: (t: { kind: 'home' }) => void } };
    stage: () => {
      raycast: (
        x: number,
        y: number,
      ) => {
        point: { x: number; y: number; z: number };
        object: { userData: Record<string, unknown>; parent: unknown };
      } | null;
    } | null;
  };
}

/** Screen points whose ray hits the given layer. */
async function layerHits(win: Page, layerId: string) {
  return win.evaluate((id) => {
    const st = (window as unknown as Inspect).__stratlas.stage();
    const canvas = document.querySelector('[data-scene-view] canvas');
    if (!st || !canvas) return [];
    const r = canvas.getBoundingClientRect();
    const out: { x: number; y: number; p: [number, number, number] }[] = [];
    for (let i = 6; i < 58; i += 2)
      for (let j = 12; j < 52; j += 2) {
        const nx = (i / 64) * 2 - 1;
        const ny = -((j / 62) * 2 - 1);
        const hit = st.raycast(nx, ny);
        if (!hit) continue;
        let o = hit.object as { userData: Record<string, unknown>; parent: unknown } | null;
        let lid: unknown = null;
        while (o && lid === null) {
          lid = o.userData.layerId ?? null;
          o = o.parent as typeof o;
        }
        if (lid === id)
          out.push({
            x: r.left + ((nx + 1) / 2) * r.width,
            y: r.top + ((1 - ny) / 2) * r.height,
            p: [hit.point.x, hit.point.y, hit.point.z],
          });
      }
    return out;
  }, layerId);
}

/** Three hits far apart in plan. */
function spread<T extends { p: [number, number, number] }>(hits: T[]): T[] {
  const first = hits[0];
  if (!first) return [];
  const out = [first];
  while (out.length < 3) {
    let best: T | undefined;
    let bd = -1;
    for (const h of hits) {
      const d = Math.min(...out.map((o) => Math.hypot(o.p[0] - h.p[0], o.p[2] - h.p[2])));
      if (d > bd) {
        bd = d;
        best = h;
      }
    }
    if (!best) break;
    out.push(best);
  }
  return out;
}

test('a new project from the wizard, raw photos and a model, georeferenced by typed points', async ({
  app,
  win,
  dataRoot,
}) => {
  // raw inputs: two geotagged JPEGs (one DJI with gimbal angles) and a 1 m quad GLB
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#808080' },
  })
    .jpeg()
    .toBuffer();
  const photoA = join(dataRoot.base, 'IMG_0001.JPG');
  const photoB = join(dataRoot.base, 'DJI_0002.JPG');
  await writeFile(
    photoA,
    withExif(
      {
        lat: 29.0276,
        lon: 48.1352,
        alt: 40,
        focal35: 24,
        width: 64,
        height: 48,
        dateTimeOriginal: '2026:01:02 10:00:00',
      },
      jpeg,
    ),
  );
  await writeFile(
    photoB,
    withExif(
      {
        make: 'DJI',
        lat: 29.02765,
        lon: 48.13525,
        alt: 45,
        focal35: 24,
        width: 64,
        height: 48,
        dji: { GimbalYawDegree: '+90', GimbalPitchDegree: '-45', GimbalRollDegree: '0' },
      },
      jpeg,
    ),
  );
  const glb = join(dataRoot.base, 'pad.glb');
  await writeFile(glb, tinyGlb());

  // 1. wizard with a typed origin
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Builder e2e');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('29.0276, 48.1352, 30');
  await expect(wiz.getByTestId('origin-readout')).toContainText('E 2');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Create project' }).click();
  await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
  const root = join(dataRoot.root, 'projects', 'builder-e2e');
  const created = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    origin: [number, number, number];
    crs: { epsg: number };
  };
  expect(created.crs.epsg).toBe(32639);
  const o = fromWgs84([48.1352, 29.0276, 30], 32639);
  expect(created.origin[0]).toBeCloseTo(o[0], 3);

  // 2. import
  await nextOpenDialog(app, [photoA, photoB, glb, join(dataRoot.base, 'notes.las')]);
  await writeFile(join(dataRoot.base, 'notes.las'), 'not a cloud');
  await win.getByRole('button', { name: 'Import files' }).click();
  const panel = win.getByTestId('import-panel');
  await expect(panel).toContainText('Imported 3 of 4 files', { timeout: 30_000 });
  await expect(panel).toContainText('Needs pipeline pack');
  const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    layers: { kind: string; id: string; items?: { pos?: number[]; q?: number[] }[] }[];
  };
  const photos = m.layers.find((l) => l.kind === 'photos');
  expect(photos?.items?.map((p) => [Boolean(p.pos), Boolean(p.q)])).toEqual([
    [true, false],
    [true, true],
  ]);
  await panel.getByRole('button', { name: 'Close' }).click();

  // 3. georeference the pad: turned 30 deg, scaled 2, shifted 5 m east and 3 m north, 1 m up
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas.workspace.getState().flyTo({ kind: 'home' });
  });
  await expect
    .poll(() => layerHits(win, 'mesh-pad').then((h) => h.length), { timeout: 30_000 })
    .toBeGreaterThan(5);
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Georeference');
  await win.keyboard.press('Enter');
  const align = win.getByTestId('align-model');
  const a = (30 * Math.PI) / 180;
  const truth = (s: number[]) => {
    const [x = 0, y = 0, z = 0] = s;
    const lx = 2 * (Math.cos(a) * x + Math.sin(a) * z) + 5;
    const lz = 2 * (-Math.sin(a) * x + Math.cos(a) * z) - 3;
    return [o[0] + lx, o[1] - lz, 30 + 2 * y + 1];
  };
  for (const h of spread(await layerHits(win, 'mesh-pad'))) {
    await align.getByTestId('pick-model').click();
    await win.mouse.click(h.x, h.y);
    const text = (await align.getByTestId('align-pending').textContent()) ?? '';
    const src = text.replace('Model point', '').trim().split(/\s+/).map(Number);
    const t = truth(src);
    await align.getByRole('button', { name: 'Typed' }).click();
    await align.getByLabel('Target coordinate').fill(t.map((v) => v.toFixed(3)).join(' '));
    await align.getByLabel('Target coordinate').press('Enter');
  }
  await expect(align.getByTestId('align-stats')).toContainText('Scale');
  await align.getByTestId('align-save').click();
  await expect(align).toContainText('Saved.');
  const after = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    layers: { id: string; transform?: number[] }[];
  };
  const tr = after.layers.find((l) => l.id === 'mesh-pad')?.transform ?? [];
  expect(Math.hypot(tr[0] ?? 0, tr[2] ?? 0)).toBeCloseTo(2, 1);
  expect(tr[12]).toBeCloseTo(5, 0);
  expect(tr[14]).toBeCloseTo(-3, 0);
});
