import { fromWgs84, toWgs84 } from '@aio/geo';
import { withExif } from '@aio/project/builder/testing';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

/** A Pix4D folder layout: a 10 m tall Z-up quad with a spaced texture name and its offset file. */
async function writePix4dExport(base: string, name: string, offset: number[]): Promise<string> {
  const mesh = join(base, name, '2_densification', '3d_mesh');
  const params = join(base, name, '1_initial', 'params');
  await mkdir(mesh, { recursive: true });
  await mkdir(params, { recursive: true });
  await writeFile(join(params, `${name}_offset.xyz`), `${offset.join(' ')}\n`);
  const tex = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#b06030' } })
    .jpeg()
    .toBuffer();
  await writeFile(join(mesh, `${name} stack_texture.jpg`), tex);
  await writeFile(
    join(mesh, `${name}.mtl`),
    `newmtl a\nKd 1 1 1\nmap_Kd ${name} stack_texture.jpg\n`,
  );
  const obj = join(mesh, `${name}.obj`);
  await writeFile(
    obj,
    `mtllib ${name}.mtl\nusemtl a\nv -2 0 0\nv 2 0 0\nv 2 0 10\nv -2 0 10\n` +
      'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n',
  );
  return obj;
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
  await expect(panel).toContainText('Needs processing tools');
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

test('a Pix4D export stands up with its texture, and a far one offers to re-centre', async ({
  app,
  win,
  dataRoot,
}) => {
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Tower e2e');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('29.0276, 48.1352, 30');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Create project' }).click();
  await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
  const root = join(dataRoot.root, 'projects', 'tower-e2e');
  const o = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { origin: number[] };
  const [oe = 0, on = 0, oh = 0] = o.origin;
  // the export's offset lies 30 km east of the origin
  const offset: [number, number, number] = [Math.round(oe) + 30_000, Math.round(on), 12];
  const obj = await writePix4dExport(dataRoot.base, 'tower', offset);

  await nextOpenDialog(app, [obj]);
  await win.getByRole('button', { name: 'Import files' }).click();
  const panel = win.getByTestId('import-panel');
  await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 30_000 });
  await expect(panel).toContainText('stood upright (Z up)');
  await expect(panel).not.toContainText('was not found');
  interface M {
    origin: number[];
    layers: { id: string; kind: string; transform?: number[]; src?: { path: string } }[];
  }
  const read = async () => JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as M;
  const mesh = (m: M) => m.layers.find((l) => l.kind === 'mesh');
  const t = mesh(await read())?.transform ?? [];
  expect(t.slice(0, 12)).toEqual([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0]);
  expect(t[12]).toBeCloseTo(offset[0] - oe, 3);
  expect(t[13]).toBeCloseTo(12 - oh, 3);
  // the texture is inside the GLB
  const glb = await readFile(join(root, mesh(await read())?.src?.path ?? ''));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
    images?: unknown[];
  };
  expect(json.images).toHaveLength(1);
  await panel.getByRole('button', { name: 'Close' }).click();

  // far from the origin: the notice offers to move it
  const notice = win.getByTestId('far-content-notice');
  await expect(notice).toContainText('lies 30.0 km from the project origin', { timeout: 30_000 });
  await notice.getByRole('button', { name: 'Re-centre project here' }).click();
  await expect(notice).toContainText('Re-centred');
  const after = await read();
  expect(after.origin[0]).toBe(offset[0]);
  expect(after.origin[1]).toBe(offset[1]);
  expect(Math.abs(mesh(after)?.transform?.[12] ?? NaN)).toBeLessThan(5);
  expect(Math.abs(mesh(after)?.transform?.[14] ?? NaN)).toBeLessThan(5);
  // the project reloaded and the tower is in view at its new place
  const meshId = mesh(after)?.id ?? '';
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas.workspace.getState().flyTo({ kind: 'home' });
  });
  await expect
    .poll(() => layerHits(win, meshId).then((h) => h.length), { timeout: 30_000 })
    .toBeGreaterThan(5);

  // the person flips the up axis in Georeference model, and back
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Georeference');
  await win.keyboard.press('Enter');
  const align = win.getByTestId('align-model');
  await expect(align.getByRole('button', { name: 'Z up' })).toHaveAttribute('aria-pressed', 'true');
  await align.getByRole('button', { name: 'Y up' }).click();
  await expect(align).toContainText('Saved.');
  expect(mesh(await read())?.transform?.[5]).toBeCloseTo(1, 6);
  await align.getByRole('button', { name: 'Z up' }).click();
  await expect
    .poll(async () => (mesh(await read())?.transform?.[9] ?? 0) > 0.99, { timeout: 15_000 })
    .toBe(true);
  await expect(align.getByRole('button', { name: 'Z up' })).toHaveAttribute('aria-pressed', 'true');

  // a Level fit shifts the tower 2 m east, 3 m north and 1 m up, and it stays upright
  await expect
    .poll(() => layerHits(win, meshId).then((h) => h.length), { timeout: 30_000 })
    .toBeGreaterThan(5);
  const cur = mesh(await read())?.transform ?? [];
  const worldOf = (s: number[]) => {
    const [x = 0, y = 0, z = 0] = s;
    return [
      (cur[0] ?? 0) * x + (cur[4] ?? 0) * y + (cur[8] ?? 0) * z + (cur[12] ?? 0),
      (cur[1] ?? 0) * x + (cur[5] ?? 0) * y + (cur[9] ?? 0) * z + (cur[13] ?? 0),
      (cur[2] ?? 0) * x + (cur[6] ?? 0) * y + (cur[10] ?? 0) * z + (cur[14] ?? 0),
    ];
  };
  const [ne = 0, nn = 0, nh = 0] = after.origin;
  for (const h of spread(await layerHits(win, meshId))) {
    await align.getByTestId('pick-model').click();
    await win.mouse.click(h.x, h.y);
    const text = (await align.getByTestId('align-pending').textContent()) ?? '';
    const src = text.replace('Model point', '').trim().split(/\s+/).map(Number);
    const [wx = 0, wy = 0, wz = 0] = worldOf(src);
    const target = [ne + wx + 2, nn - wz + 3, nh + wy + 1];
    await align.getByRole('button', { name: 'Typed' }).click();
    await align.getByLabel('Target coordinate').fill(target.map((v) => v.toFixed(3)).join(' '));
    await align.getByLabel('Target coordinate').press('Enter');
  }
  await expect(align.getByTestId('align-stats')).toContainText('Scale');
  await align.getByTestId('align-save').click();
  await expect(align).toContainText('Saved.');
  const fit = mesh(await read())?.transform ?? [];
  // still Z up: the model's own z axis points up, not along the scene's z
  expect(fit[9] ?? 0).toBeGreaterThan(Math.max(fit[5] ?? 0, 0));
  expect(fit[12]).toBeCloseTo((cur[12] ?? 0) + 2, 1);
  expect(fit[13]).toBeCloseTo((cur[13] ?? 0) + 1, 1);
  expect(fit[14]).toBeCloseTo((cur[14] ?? 0) - 3, 1);
  await expect(align.getByRole('button', { name: 'Z up' })).toHaveAttribute('aria-pressed', 'true');
});

test('camera heights: relative altitude asks for the take-off height, proposed from the model', async ({
  app,
  win,
  dataRoot,
}) => {
  // a DJI photo 3.5 m above its take-off point, over the tiny project's 1 m quad (at y 0)
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#808080' },
  })
    .jpeg()
    .toBuffer();
  const ll = toWgs84([500000.5, 3200000.5, 0], 32639);
  const photo = join(dataRoot.base, 'DJI_0100.JPG');
  await writeFile(
    photo,
    withExif(
      {
        make: 'DJI',
        lat: ll[1],
        lon: ll[0],
        alt: 45.4,
        focal35: 24,
        width: 64,
        height: 48,
        dji: {
          GimbalYawDegree: '+0',
          GimbalPitchDegree: '-90',
          GimbalRollDegree: '0',
          AbsoluteAltitude: '+45.40',
          RelativeAltitude: '+3.50',
        },
      },
      jpeg,
    ),
  );
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas.workspace.getState().flyTo({ kind: 'home' });
  });
  await expect
    .poll(() => layerHits(win, 'quad').then((h) => h.length), { timeout: 30_000 })
    .toBeGreaterThan(0);

  await nextOpenDialog(app, [photo]);
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Import raw data');
  await win.keyboard.press('Enter');
  const card = win.getByTestId('import-heights');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Model height under the take-off point');
  await expect(card.getByRole('spinbutton', { name: 'Take-off height' })).toHaveValue('0.0');
  // the absolute option proposes the offset that agrees with that take-off height
  await card.getByText('Absolute altitude + datum offset').click();
  await expect(card.getByRole('spinbutton', { name: 'Datum offset' })).toHaveValue('-41.90');
  await card.getByText('Relative altitude + take-off height').click();
  await card.getByRole('spinbutton', { name: 'Take-off height' }).fill('7.5');
  await card.getByRole('button', { name: 'Import' }).click();

  const panel = win.getByTestId('import-panel');
  await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 30_000 });
  await expect(panel.getByTestId('import-heights-line')).toHaveText(
    'Heights: relative altitude + take-off at H 7.5 m (typed at import).',
  );
  const m = JSON.parse(
    await readFile(join(dataRoot.root, 'projects', 'e2e-tiny', 'manifest.json'), 'utf8'),
  ) as { layers: { kind: string; items?: { pos?: number[] }[] }[] };
  const pos = m.layers.find((l) => l.kind === 'photos')?.items?.[0]?.pos ?? [];
  // H = 7.5 + 3.5, origin H 0
  expect(pos[1]).toBeCloseTo(11, 3);
});

test('camera photos far from the survey data can drop their GPS', async ({
  app,
  win,
  dataRoot,
}) => {
  await win.getByTestId('new-project').first().click();
  const wiz = win.getByTestId('new-project-wizard');
  await wiz.getByLabel('Project name').fill('Tower photos e2e');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Typed coordinate' }).click();
  await wiz.getByLabel('Origin coordinate').fill('29.0276, 48.1352, 30');
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Next' }).click();
  await wiz.getByRole('button', { name: 'Create project' }).click();
  await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
  const root = join(dataRoot.root, 'projects', 'tower-photos-e2e');
  const o = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { origin: number[] };
  const [oe = 0, on = 0] = o.origin;

  // a handheld camera photo whose GPS puts it 40 km east, and the Pix4D export at the origin
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#808080' },
  })
    .jpeg()
    .toBuffer();
  const photo = join(dataRoot.base, 'DSC00001.JPG');
  const far = toWgs84([oe + 40_000, on, 30], 32639);
  await writeFile(
    photo,
    withExif(
      { make: 'SONY', lat: far[1], lon: far[0], alt: 30, focal35: 35, width: 64, height: 48 },
      jpeg,
    ),
  );
  const obj = await writePix4dExport(dataRoot.base, 'tower', [Math.round(oe), Math.round(on), 12]);

  // the model first (older, near the origin: no notice), then the photo (fresh, far)
  const panel = win.getByTestId('import-panel');
  await nextOpenDialog(app, [obj]);
  await win.getByRole('button', { name: 'Import files' }).click();
  await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Close' }).click();
  await nextOpenDialog(app, [photo]);
  await win.keyboard.press('Control+K');
  await win.keyboard.type('Import raw data');
  await win.keyboard.press('Enter');
  await expect(panel).toContainText('Imported 1 of 1 files', { timeout: 30_000 });
  await panel.getByRole('button', { name: 'Close' }).click();

  const notice = win.getByTestId('far-content-notice');
  await expect(notice).toContainText("a camera's GPS can be kilometres out", { timeout: 30_000 });
  await expect(notice.getByRole('button', { name: 'Re-centre project here' })).toHaveCount(0);
  await notice.getByRole('button', { name: 'Ignore their GPS' }).click();
  await expect(notice).toContainText('stay in Inspect');
  const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
    origin: number[];
    layers: { kind: string; items?: { pos?: number[] }[] }[];
  };
  const photos = m.layers.find((l) => l.kind === 'photos');
  expect(photos?.items).toHaveLength(1);
  expect(photos?.items?.every((p) => !p.pos)).toBe(true);
  expect(m.origin[0]).toBe(oe);
});
