import { cameraQuatFromGimbal } from '@aio/geo';
import { Issue, ProjectManifest } from '@aio/schema';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test as base, tinyManifest, type DataRoot } from './fixtures';

const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 255]);
const test = base.extend<{ dataRoot: DataRoot }>({
  dataRoot: async ({ dataRoot }, use) => {
    const manifest = tinyManifest();
    manifest.layers.push({
      kind: 'photos',
      id: 'photos',
      name: 'Rotation photos',
      visible: true,
      items: [
        {
          id: 'p1',
          src: { path: 'rotation.png' },
          pos: [0, 2, 0],
          q: cameraQuatFromGimbal(38, -24, 17),
          lens: { model: 'pinhole', hfovDeg: 60, aspect: 2 / 3 },
        },
      ],
    });
    manifest.severityModels = [
      {
        id: 'review',
        name: 'Review',
        levels: [{ value: 1, label: 'Review', color: '#ff8800', criteria: '' }],
      },
    ];
    manifest.classCatalogues = [
      {
        id: 'marks',
        name: 'Marks',
        assetType: 'test',
        classes: [{ id: 'mark', label: 'Mark', color: '#ff8800', severityModel: 'review' }],
      },
    ];
    const issue = Issue.parse({
      id: 'mark',
      code: 'F01',
      classId: 'mark',
      severityModelId: 'review',
      severity: 1,
      status: 'draft',
      title: 'Rotation mark',
      note: '',
      author: 'test',
      createdAt: '2026-10-16T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
      sightings: [
        { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'point', x: 0.5, y: 0.5 } },
      ],
      source: 'human',
    });
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(
      join(dataRoot.projectDir, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: [issue] }),
    );
    await sharp(rgb, { raw: { width: 2, height: 3, channels: 3 } })
      .png()
      .toFile(join(dataRoot.projectDir, 'rotation.png'));
    await use(dataRoot);
  },
});

test('Rotate turns native pixels clockwise and keeps the displayed and saved mark aligned', async ({
  win,
  dataRoot,
}) => {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await win.locator('.nav-item', { hasText: 'Media' }).first().click();
  const tile = win.locator('.media [data-photo="p1"]');
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  const viewer = win.getByTestId('photo-viewer').first();
  const image = viewer.locator('img.ann-img').first();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([2, 3]);
  await viewer.getByRole('button', { name: 'Rotate', exact: true }).click();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight]))
    .toEqual([3, 2]);
  await expect(viewer.getByRole('button', { name: 'Rotate', exact: true })).toBeEnabled();
  const expected = Buffer.concat(
    [4, 2, 0, 5, 3, 1].map((index) => rgb.subarray(index * 3, index * 3 + 3)),
  );
  const disk = await sharp(join(dataRoot.projectDir, 'rotation.png'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([disk.info.width, disk.info.height]).toEqual([3, 2]);
  expect(disk.data).toEqual(expected);
  // The image served back to the viewer also contains the changed pixels, not a stale protocol cache.
  const displayed = await image.evaluate(async (img: HTMLImageElement) => {
    // aio images are cross-origin to file://. Decode their fetched bytes into an origin-clean
    // bitmap so pixel inspection does not depend on disabling Chromium's canvas protection.
    const bitmap = await createImageBitmap(await (await fetch(img.currentSrc)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data).filter(
      (_, i) => i % 4 !== 3,
    );
  });
  expect(displayed).toEqual([...expected]);
  const saved: unknown = JSON.parse(
    await readFile(join(dataRoot.projectDir, 'issues.json'), 'utf8'),
  );
  expect(saved).toMatchObject({
    issues: [{ sightings: [{ geom: { type: 'point', x: 2.5, y: 0.5 } }] }],
  });
  // Read the visible SVG against the rendered image instead of reaching into the workspace store.
  await expect
    .poll(() =>
      viewer.evaluate((el) => {
        const img = el.querySelector<HTMLImageElement>('img.ann-img');
        const mark = el.querySelector<SVGCircleElement>('svg.ann-draw circle.shape');
        if (!img || !mark) return null;
        const box = img.getBoundingClientRect(),
          svg = mark.ownerSVGElement?.getBoundingClientRect();
        if (!svg) return null;
        return [
          Math.round(
            ((Number(mark.getAttribute('cx')) + svg.left - box.left) / box.width) *
              img.naturalWidth *
              100,
          ) / 100,
          Math.round(
            ((Number(mark.getAttribute('cy')) + svg.top - box.top) / box.height) *
              img.naturalHeight *
              100,
          ) / 100,
        ];
      }),
    )
    .toEqual([2.5, 0.5]);
  const manifest = ProjectManifest.parse(
    JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')),
  );
  const layer = manifest.layers.find((l) => l.id === 'photos');
  const q = layer?.kind === 'photos' ? layer.items[0]?.q : undefined;
  expect(q).toBeDefined();
  const expectedQ = cameraQuatFromGimbal(38, -24, -73);
  q?.forEach((value, axis) => {
    expect(value).toBeCloseTo(expectedQ[axis] ?? 0, 10);
  });
});
