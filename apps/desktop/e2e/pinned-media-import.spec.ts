/**
 * Importing 360s that have no GPS (pinned media design): Add data with a 2:1 JPEG without EXIF,
 * the same picture as an Insta360 `.insp` still (a JPEG with the camera's trailer after it) and an
 * unstitched `.insp` (two fisheye circles on black). The offer says the two 360s import as not
 * placed and why the fisheye still is left out; after the import the 360s have no place and Media
 * says "Not placed". Then Treat as 360 moves a 2:1 photo into its date's panoramas layer and Treat
 * as photo moves it back. Synthetic files only (pinFixture.ts), off-screen, zero network.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test } from './fixtures';
import {
  createPinProject,
  nextOpenDialog,
  notPlaced,
  openMedia,
  openPinProject,
  PANO_LAYER,
  PHOTO_LAYER,
  readPinManifest,
  tileAction,
} from './pinFixture';

const W = 2560;
const H = 1280;

/** A 2:1 equirect-like JPEG with picture everywhere (a sky over ground), no EXIF. */
const equirect = () =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(W)}" height="${String(H)}">` +
        `<rect width="${String(W)}" height="${String(H / 2)}" fill="#7fb2e5"/>` +
        `<rect y="${String(H / 2)}" width="${String(W)}" height="${String(H / 2)}" fill="#8a7a5a"/>` +
        '</svg>',
    ),
  )
    .jpeg()
    .toBuffer();

/** Two bright fisheye circles side by side on black, as an Insta360 camera writes them. */
const dualFisheye = () =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${String(W)}" height="${String(H)}">` +
        `<rect width="${String(W)}" height="${String(H)}" fill="#000"/>` +
        `<circle cx="${String(W / 4)}" cy="${String(H / 2)}" r="${String(H / 2 - 20)}" fill="#c8c8c8"/>` +
        `<circle cx="${String((3 * W) / 4)}" cy="${String(H / 2)}" r="${String(H / 2 - 20)}" fill="#c8c8c8"/>` +
        '</svg>',
    ),
  )
    .jpeg()
    .toBuffer();

test('360s without GPS import as not placed; a 2:1 photo becomes a 360 and back', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(180_000);
  // the panorama import asks for an EPSG frame, even for 360s with no GPS
  const dir = await createPinProject(dataRoot.root, { crs: 'utm' });
  const drop = join(dataRoot.base, 'drop');
  await mkdir(drop, { recursive: true });
  const jpg = await equirect();
  const files = [join(drop, 'ground360.jpg'), join(drop, 'still.insp'), join(drop, 'fisheye.insp')];
  await writeFile(files[0] ?? '', jpg);
  // the camera's trailer after the JPEG: decoders stop at the end of the image
  await writeFile(files[1] ?? '', Buffer.concat([jpg, Buffer.alloc(64, 0x5a)]));
  await writeFile(files[2] ?? '', Buffer.concat([await dualFisheye(), Buffer.alloc(64, 0x5a)]));
  await win.reload();
  await openPinProject(win);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 30_000 });

  // the offer: two 360s with no GPS, the fisheye still left out with a reason
  await nextOpenDialog(app, files);
  await win.getByTestId('add-data').click();
  const offer = win.getByTestId('pano-offer');
  await expect(offer.getByTestId('pano-offer-unplaced')).toContainText('2 360s have no GPS', {
    timeout: 60_000,
  });
  await expect(offer.getByTestId('pano-offer-fisheye')).toContainText(
    'Two fisheye circles, not a 360 yet: export it as a 360 photo from Insta360 Studio first.',
  );
  await offer.getByTestId('pano-offer-yes').click();
  const dlg = win.getByTestId('pano-import');
  await dlg.getByTestId('pano-import-go').click();
  await expect(dlg).toBeHidden({ timeout: 60_000 });

  // two new 360s, neither with a place (p1 of the fixture is the third)
  const unplaced360s = async () =>
    (await readPinManifest(dir)).layers
      .filter((l) => l.kind === 'panoramas')
      .flatMap((l) => l.items ?? [])
      .filter((i) => i.pos === undefined).length;
  await expect.poll(unplaced360s, { timeout: 60_000 }).toBe(3);
  const panos = (await readPinManifest(dir)).layers
    .filter((l) => l.kind === 'panoramas')
    .flatMap((l) => l.items ?? []);
  expect(panos).toHaveLength(3);

  // Media: p1, ph1, ph2 and the two new 360s are not placed
  await openMedia(win);
  await expect(win.getByTestId('media-not-placed')).toHaveCount(5, { timeout: 30_000 });

  // ph2 is 2:1: it looks like a 360; Treat as 360 moves it into the date's panoramas layer
  const ph2 = win.locator('[data-testid="media-treat-360"][data-item="ph2"]');
  await expect(ph2).toBeVisible({ timeout: 30_000 });
  await ph2.click();
  const idsOf = async (layerId: string) =>
    (await readPinManifest(dir)).layers.find((l) => l.id === layerId)?.items?.map((i) => i.id) ??
    [];
  await expect.poll(() => idsOf(PANO_LAYER), { timeout: 30_000 }).toContain('ph2');
  expect(await idsOf(PHOTO_LAYER)).toEqual(['ph1', 'ph3']);
  await expect(notPlaced(win, 'ph2')).toBeVisible();

  // right-click its tile, Treat as photo: back in the photos layer
  await tileAction(win, { pano: 'ph2' }, 'Treat as photo');
  await expect.poll(() => idsOf(PHOTO_LAYER), { timeout: 30_000 }).toContain('ph2');
  expect(await idsOf(PANO_LAYER)).not.toContain('ph2');
});
