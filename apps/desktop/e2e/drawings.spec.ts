/**
 * Drawings as a dataset: a PNG and a PDF made here come in through Add data, show under Drawings
 * as "not placed", open side by side (each PDF page its own entry), take an opacity and "on top"
 * for the 3D view and the map, and are placed by two typed points.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test } from './fixtures';

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

/** A PDF of `pages` small pages (200 x 100 points), one blue stroke on each. */
function tinyPdf(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${String(3 + i * 2)} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>`);
  for (let i = 0; i < pages; i++) {
    const content = `0 0 1 RG 4 w 20 20 m ${String(180 - i * 60)} 80 l S`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${String(4 + i * 2)} 0 R /Resources << >> >>`,
    );
    objects.push(`<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

interface Material {
  opacity: number;
  depthTest: boolean;
}
interface Inspect {
  __stratlas: {
    stage: () => {
      scene: { getObjectByName(n: string): { material: Material; visible: boolean } | undefined };
    } | null;
  };
}
interface MapProbe {
  getLayer(id: string): unknown;
  getPaintProperty(layer: string, name: string): unknown;
}

/** How a drawing's quad is drawn in the 3D scene (null until its layer has loaded). */
const quad = (win: Page, layerId: string) =>
  win.evaluate((id) => {
    const o = (window as unknown as Inspect).__stratlas
      .stage()
      ?.scene.getObjectByName(`layer:${id}`);
    return o ? { opacity: o.material.opacity, depthTest: o.material.depthTest } : null;
  }, layerId);

/** The opacity of a drawing's raster layer on the main map (null until it is there). */
const mapOpacity = (win: Page, layerId: string) =>
  win.evaluate((id) => {
    const host = [...document.querySelectorAll('.pane-map div')].find((d) => '__aioMap' in d) as
      { __aioMap: MapProbe } | undefined;
    const sid = `aio-raster-${id}-0`;
    return host?.__aioMap.getLayer(sid)
      ? (host.__aioMap.getPaintProperty(sid, 'raster-opacity') as number)
      : null;
  }, layerId);

const stageBar = (win: Page) => win.getByRole('toolbar', { name: 'Stage tools' });

async function showView(win: Page, view: '3D' | 'Map' | 'Split'): Promise<void> {
  const button = stageBar(win)
    .getByRole('group', { name: 'Stage view' })
    .getByRole('button', { name: view, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

interface Corners {
  tl: [number, number, number];
  tr: [number, number, number];
  bl: [number, number, number];
}
interface ManifestLayer {
  id: string;
  kind: string;
  name: string;
  visible?: boolean;
  role?: string;
  format?: string;
  src?: { path: string };
  corners?: Corners;
}

test('a PNG and a PDF come in as drawings, open side by side, take an opacity and are placed', async ({
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(180_000);
  const png = join(dataRoot.base, 'Site Layout.png');
  await writeFile(
    png,
    await sharp({ create: { width: 400, height: 200, channels: 3, background: '#f4f4f0' } })
      .png()
      .toBuffer(),
  );
  const pdf = join(dataRoot.base, 'sheets.pdf');
  await writeFile(pdf, tinyPdf(2));
  const manifest = async () =>
    JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')) as {
      origin: [number, number, number];
      layers: ManifestLayer[];
    };

  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

  // 1. import through Add data: the PNG lands at once, the PDF asks for its pages
  await nextOpenDialog(app, [png, pdf]);
  await win.getByTestId('add-data').click();
  const pages = win.getByTestId('import-pages');
  await expect(pages).toContainText('This PDF has 2 pages', { timeout: 30_000 });
  await expect(pages.getByLabel('Pages to import')).toHaveValue('1-2');
  await pages.getByRole('button', { name: 'Import 2 pages' }).click();
  const panel = win.getByTestId('import-panel');
  await expect(panel).toContainText('Imported 2 of 2 files', { timeout: 60_000 });
  await expect(panel).toContainText('2 pages added to Drawings');
  await panel.getByRole('button', { name: 'Close' }).click();

  const m = await manifest();
  const sheets = m.layers.filter((l) => l.id.startsWith('sheet-'));
  expect(sheets.map((l) => [l.id, l.name, l.src?.path])).toEqual([
    ['sheet-site-layout', 'Site Layout.png', 'drawings/site-layout/plan.png'],
    ['sheet-sheets-p1', 'sheets.pdf, page 1', 'drawings/sheets-p1/plan.png'],
    ['sheet-sheets-p2', 'sheets.pdf, page 2', 'drawings/sheets-p2/plan.png'],
  ]);
  for (const l of sheets) {
    expect(l).toMatchObject({ kind: 'raster', role: 'plan', format: 'image', visible: false });
  }
  // the page was drawn large enough to read: 200 points at 600 dpi
  const page1 = await sharp(
    join(dataRoot.projectDir, 'drawings', 'sheets-p1', 'plan.png'),
  ).metadata();
  expect(page1.width).toBe(1667);
  // the originals are kept beside the pictures
  await expect(readFile(join(dataRoot.projectDir, 'drawings', 'sheets.pdf'))).resolves.toBeTruthy();
  await expect(
    readFile(join(dataRoot.projectDir, 'drawings', 'site-layout.png')),
  ).resolves.toBeTruthy();

  // 2. a Drawings group, every drawing marked as not placed
  const group = win.getByTestId('tree-group-drawings');
  await expect(group).toContainText('Drawings');
  await expect(group).toContainText('3');
  await expect(win.getByTestId('tree-group-add-drawings')).toHaveAttribute(
    'aria-label',
    'Add drawing',
  );
  for (const id of ['sheet-site-layout', 'sheet-sheets-p1', 'sheet-sheets-p2']) {
    await expect(win.getByTestId(`tree-row-${id}`)).toContainText('not placed');
  }

  // 3. the first drawing shows its controls; they sit in the list, never over the view
  const controls = win.getByTestId('drawing-controls-sheet-site-layout');
  await expect(controls).toBeVisible();
  await expect(controls.getByTestId('drawing-unplaced')).toBeVisible();
  const reached = await win.evaluate(() => {
    const canvas = document.querySelector('[data-scene-view] canvas');
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect();
    return [0.25, 0.5, 0.75].every((f) => {
      const el = document.elementFromPoint(r.left + r.width * f, r.top + r.height * 0.5);
      return (
        el === canvas || canvas.contains(el) || (el?.closest('[data-scene-view]') ?? null) !== null
      );
    });
  });
  expect(reached).toBe(true);

  // 4. side by side: the drawing on the right of the split, each PDF page its own entry
  await controls.getByRole('button', { name: 'Side by side' }).click();
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'split');
  const view = win.getByTestId('raster-view');
  await expect(view.locator('img').first()).toHaveAttribute('src', /site-layout\/plan\.png/);
  const chooser = win.getByLabel('Raster layer');
  await expect(chooser.locator('option')).toHaveText([
    'Site Layout.png',
    'sheets.pdf, page 1',
    'sheets.pdf, page 2',
  ]);
  await chooser.selectOption('sheet-sheets-p2');
  await expect(view.locator('img').first()).toHaveAttribute('src', /sheets-p2\/plan\.png/);
  await chooser.selectOption('sheet-site-layout');

  // 5. opacity and on top reach the 3D scene (the drawing's quad is there, hidden until placed)
  await expect
    .poll(() => quad(win, 'sheet-site-layout'), { timeout: 30_000 })
    .toEqual({
      opacity: 1,
      depthTest: true,
    });
  await controls.getByLabel('Opacity of Site Layout.png').fill('0.4');
  await expect(controls).toContainText('40 %');
  await controls.getByRole('switch', { name: 'On top in 3D' }).click();
  await expect
    .poll(() => quad(win, 'sheet-site-layout'))
    .toEqual({ opacity: 0.4, depthTest: false });
  await controls.getByRole('switch', { name: 'On top in 3D' }).click();
  await expect
    .poll(() => quad(win, 'sheet-site-layout'))
    .toEqual({ opacity: 0.4, depthTest: true });

  // 6. and the map: the chosen value, where a drawing without one keeps 75 percent
  await showView(win, 'Map');
  await expect.poll(() => mapOpacity(win, 'sheet-site-layout'), { timeout: 30_000 }).toBe(0.4);
  expect(await mapOpacity(win, 'sheet-sheets-p1')).toBe(0.75);
  await controls.getByLabel('Opacity of Site Layout.png').fill('0.6');
  await expect.poll(() => mapOpacity(win, 'sheet-site-layout')).toBe(0.6);

  // 7. place it by two points typed in project coordinates, 60 m apart east to west
  await controls.getByRole('button', { name: 'Place on the site' }).click();
  await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'split');
  const strip = win.getByTestId('place-strip');
  await expect(strip).toContainText('Click a point on the drawing');
  await strip.getByRole('button', { name: 'Typed' }).click();
  const box = await view.boundingBox();
  if (!box) throw new Error('no drawing pane');
  const [e0, n0] = m.origin;
  const clicks = [
    { fx: 0.35, e: e0 + 10 },
    { fx: 0.65, e: e0 + 70 },
  ];
  for (const [i, c] of clicks.entries()) {
    await win.mouse.click(box.x + box.width * c.fx, box.y + box.height * 0.5);
    await expect(view.getByTestId('raster-mark')).toHaveCount(i + 1);
    await strip.getByLabel('Site coordinate').fill(`${String(c.e)} ${String(n0 - 5)}`);
    await strip.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(strip.getByTestId('place-pair')).toHaveCount(i + 1);
  }
  await expect(strip.getByTestId('place-fit')).toContainText('mm per pixel');
  await strip.getByTestId('place-save').click();
  await expect(strip).toHaveCount(0);
  await expect(win.getByTestId('tree-row-sheet-site-layout')).not.toContainText('not placed');

  const placed = (await manifest()).layers.find((l) => l.id === 'sheet-site-layout');
  expect(placed?.visible).toBe(true);
  const c = placed?.corners;
  if (!c) throw new Error('the placed drawing has no corners');
  // both points lie 5 m south of the origin on one row of the sheet: it stays level, north up
  expect(c.tr[2]).toBeCloseTo(c.tl[2], 3);
  expect(c.bl[0]).toBeCloseTo(c.tl[0], 3);
  const width = c.tr[0] - c.tl[0];
  const height = c.bl[2] - c.tl[2];
  // a similarity keeps the sheet's shape (400 x 200 pixels)
  expect(width / height).toBeCloseTo(2, 3);
  // the clicked row is the middle of the sheet, 5 m south of the origin (local z = +5)
  expect(Math.abs(c.tl[2] + height / 2 - 5)).toBeLessThan(1);
  // 30 percent of the pane spans 60 m, and the sheet is no wider than the pane
  expect(width).toBeGreaterThan(60);
  const placement = JSON.parse(
    await readFile(join(dataRoot.projectDir, 'drawings', 'site-layout', 'placement.json'), 'utf8'),
  ) as { provisional: boolean; sizePx: [number, number]; units: string };
  expect(placement).toMatchObject({ provisional: false, sizePx: [400, 200], units: 'px' });
  // placed, it shows in 3D
  await expect
    .poll(() =>
      win.evaluate(
        () =>
          (window as unknown as Inspect).__stratlas
            .stage()
            ?.scene.getObjectByName('layer:sheet-site-layout')?.visible ?? null,
      ),
    )
    .toBe(true);
});
