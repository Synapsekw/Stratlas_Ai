/**
 * Align to: a photo set 91 km off (a phone GPS) is aligned to the unit quad from its row menu.
 * The photos land on the quad's centre in plan, the manifest (GPS) is unchanged, Undo restores
 * the exact previous corrections (none), Redo applies again, Ctrl+Z works while the notice shows.
 * Synthetic data; off-screen; zero network.
 */
import { glbBounds } from '@aio/project/builder';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test as base, tinyGlb, tinyManifest } from './fixtures';

/** A 1 x 1 grey JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////' +
    '////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
interface Orient {
  photos: Record<string, Record<string, { offsetM?: number[] }>>;
}
const PHOTOS: { id: string; src: { path: string }; pos: [number, number, number] }[] = [
  { id: 'a', src: { path: 'photos/far/a.jpg' }, pos: [91000, 50, -2000] },
  { id: 'b', src: { path: 'photos/far/b.jpg' }, pos: [91000.2, 50.5, -2000.2] },
  { id: 'c', src: { path: 'photos/far/c.jpg' }, pos: [91000.4, 51, -2000.4] },
];

const test = base.extend<{ farPhotos: { id: string; dir: string } }>({
  farPhotos: async ({ dataRoot }, use) => {
    const m = tinyManifest();
    const manifest = {
      ...m,
      layers: [
        ...m.layers,
        {
          kind: 'photos',
          id: 'far',
          name: 'Phone photos',
          visible: true,
          capture: 'capture-1',
          items: PHOTOS,
        },
      ],
    };
    await mkdir(join(dataRoot.projectDir, 'photos', 'far'), { recursive: true });
    for (const p of PHOTOS) await writeFile(join(dataRoot.projectDir, p.src.path), JPEG);
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await use({ id: dataRoot.projectId, dir: dataRoot.projectDir });
  },
});

/** The quad's box from the GLB's own accessors. */
function quadCentre(): [number, number] {
  const glb = tinyGlb();
  const len = glb.readUInt32LE(12);
  const b = glbBounds(JSON.parse(glb.subarray(20, 20 + len).toString('utf8')) as unknown);
  if (!b) throw new Error('no quad bounds');
  return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
}

const orientation = async (dir: string): Promise<Orient> => {
  try {
    return JSON.parse(await readFile(join(dir, 'orientation.json'), 'utf8')) as Orient;
  } catch {
    return { photos: {} };
  }
};

// `farPhotos` is listed before `win`, so the manifest is written before the app starts
test('a far photo set lands on the target; GPS unchanged; Undo and Redo exact', async ({
  farPhotos,
  win,
}) => {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect
    .poll(async () => (await openProject(win)).id, { timeout: 30_000 })
    .toBe(farPhotos.id);
  await win.locator('canvas').first().waitFor();
  const manifestBefore = await readFile(join(farPhotos.dir, 'manifest.json'), 'utf8');

  // the photo set sits in the date folder's Photos group, closed at first
  const folder = win.getByTestId('date-folder-capture-1');
  if ((await folder.getAttribute('aria-expanded')) !== 'true')
    await win.getByTestId('date-name-capture-1').click();
  const photos = folder.getByTestId('tree-group-toggle-photos');
  if ((await photos.getAttribute('aria-expanded')) !== 'true') await photos.click();
  const row = win.getByTestId('tree-row-far');
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await win.getByTestId('ctx-item-photos.alignTo').click();
  await win.getByTestId('align-to-quad').click();
  await expect(win.getByTestId('align-to-text')).toContainText(
    'Aligned 3 photos to Unit quad (moved 91.0 km)',
  );

  const o = await orientation(farPhotos.dir);
  const [cx, cz] = quadCentre();
  const at = PHOTOS.map((p) => {
    const off = o.photos.far?.[p.id]?.offsetM ?? [0, 0, 0];
    return p.pos.map((v, i) => v + (off[i] ?? 0));
  });
  const midX = (Math.min(...at.map((p) => p[0] ?? 0)) + Math.max(...at.map((p) => p[0] ?? 0))) / 2;
  const midZ = (Math.min(...at.map((p) => p[2] ?? 0)) + Math.max(...at.map((p) => p[2] ?? 0))) / 2;
  expect(midX).toBeCloseTo(cx, 2);
  expect(midZ).toBeCloseTo(cz, 2);
  expect(at.map((p) => p[1])).toEqual([50, 50.5, 51]); // plausible heights kept
  expect(await readFile(join(farPhotos.dir, 'manifest.json'), 'utf8')).toBe(manifestBefore);

  await win.getByTestId('align-to-undo').click();
  await expect(win.getByTestId('align-to-text')).toHaveText('Alignment undone.');
  await expect
    .poll(async () => Object.keys((await orientation(farPhotos.dir)).photos.far ?? {}))
    .toEqual([]);
  expect(await readFile(join(farPhotos.dir, 'manifest.json'), 'utf8')).toBe(manifestBefore);
  await win.getByTestId('align-to-redo').click();
  await expect
    .poll(async () => (await orientation(farPhotos.dir)).photos.far?.a?.offsetM)
    .toEqual(o.photos.far?.a?.offsetM);
  await win.locator('body').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+z');
  await expect(win.getByTestId('align-to-text')).toHaveText('Alignment undone.');
});
