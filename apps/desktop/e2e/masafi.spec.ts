/**
 * End to end on the real Masafi stockpile project (19 piles, two surveys): the native volumetric
 * workspace. Runs only where the project is present at E:\Stratlas Data\projects\masafi (or under
 * STRATLAS_MASAFI_DATA); skipped elsewhere. The project is copied to a temporary data root, so the
 * boundary edit written here never touches the real data.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_MASAFI_DATA ?? 'E:\\Stratlas Data';
const MASAFI = join(DATA, 'projects', 'masafi');
const PACKS = join(DATA, 'packs');

interface Fcn {
  fill: number;
  cut: number;
  net: number;
}
interface VolumesJson {
  piles: { id: string; epochs: Record<string, { volumes: Record<string, Fcn> }> }[];
}
type Recomputed = Record<string, Record<string, Fcn> | null>;

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        selection: { kind: string; id: string; layer?: string } | null;
        isLayerVisible(id: string): boolean;
      };
    };
    stage(): {
      scene: {
        getObjectByName(n: string): { visible: boolean; children: unknown[] } | undefined;
      };
    } | null;
    volumetric: {
      getState(): {
        status: string;
        selected: string | null;
        elevation?: { ramp: string; hillshade: boolean };
        service: { recompute(id: string): Promise<Recomputed> } | null;
      };
    };
  };
}

const test = base.extend<{ root: string; app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  root: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-masafi-'));
    await cp(MASAFI, join(dir, 'data', 'projects', 'masafi'), { recursive: true });
    // start from the delivered volumes: edits saved while testing the real project are left out
    await rm(join(dir, 'data', 'projects', 'masafi', 'edits'), { recursive: true, force: true });
    // the installed street map pack that covers the yard, when this machine has it
    if (existsSync(join(PACKS, 'kuwait.pmtiles')))
      for (const f of ['kuwait.json', 'kuwait.pmtiles'])
        await cp(join(PACKS, f), join(dir, 'data', 'packs', f));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  app: async ({ root }, use) => {
    const network = new NetworkGuard();
    const app = await launchApp({
      base: root,
      root: join(root, 'data'),
      userData: join(root, 'user'),
      projectId: 'masafi',
      projectDir: join(root, 'data', 'projects', 'masafi'),
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
    }
  },
  win: async ({ app }, use) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

test.skip(!existsSync(join(MASAFI, 'volumes.json')), `Masafi project not found at ${MASAFI}`);
test.setTimeout(180_000);

/**
 * Run a probe in the renderer with the app's inspection hook typed. The probe is sent as a
 * function (no eval in the page) and gets the window and an argument.
 */
async function inspect<T, A>(
  win: Page,
  probe: (x: { w: Inspect; a: A }) => T | Promise<T>,
  arg: A,
): Promise<T> {
  const w = await win.evaluateHandle(() => window);
  try {
    const fn = probe as unknown as (x: { w: Window; a: unknown }) => T | Promise<T>;
    const payload: { w: typeof w; a: unknown } = { w, a: arg };
    return await win.evaluate(fn, payload);
  } finally {
    await w.dispose();
  }
}

/** The project's saved boundary edits as text, or null when there are none. */
function boundariesOf(project: string): string | null {
  const f = join(project, 'edits', 'boundaries.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

async function openMasafi(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'Masafi' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await expect(win.getByTestId('vol-register')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () =>
        inspect(
          win,
          ({ w }) => w.__stratlas.stage()?.scene.getObjectByName('volumetric') !== undefined,
          null,
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
}

/** The pile's volume body, toe line or base outline is drawn in 3D. */
const pileDrawn = (win: Page, id: string) =>
  inspect(
    win,
    ({ w, a }) => w.__stratlas.stage()?.scene.getObjectByName(`vol:${a}`) !== undefined,
    id,
  );

/** Every callout's text on the 3D stage. */
const calloutText = (win: Page) =>
  win.locator('[data-scene-view] .aio-stage-overlay').first().innerText();

interface Projectable {
  clone(): Projectable;
  applyMatrix4(m: unknown): Projectable;
  project(camera: unknown): { x: number; y: number };
}

/** Client coordinates of the middle of a scene node (a pile on the terrain). */
async function pileOnScreen(win: Page, node: string): Promise<{ x: number; y: number }> {
  const ndc = await inspect(
    win,
    ({ w, a }) => {
      const stage = w.__stratlas.stage() as unknown as {
        camera: unknown;
        scene: { getObjectByName(n: string): unknown };
      };
      const root = stage.scene.getObjectByName(a) as
        { traverse(cb: (o: unknown) => void): void } | undefined;
      const found: { x: number; y: number }[] = [];
      root?.traverse((o) => {
        const m = o as {
          isMesh?: boolean;
          matrixWorld: unknown;
          geometry?: {
            boundingSphere: { center: Projectable } | null;
            computeBoundingSphere(): void;
          };
        };
        if (found.length || !m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        const c = m.geometry.boundingSphere?.center;
        if (c) found.push(c.clone().applyMatrix4(m.matrixWorld).project(stage.camera));
      });
      const p = found[0];
      return p ? { x: p.x, y: p.y } : null;
    },
    node,
  );
  const box = await win.locator('[data-scene-view] canvas').boundingBox();
  if (!ndc || !box) throw new Error(`${node} is not on screen`);
  return { x: box.x + ((ndc.x + 1) / 2) * box.width, y: box.y + ((1 - ndc.y) / 2) * box.height };
}

const rowNet = (win: Page, pile: string) =>
  win.locator(`[data-testid="vol-register"] tbody tr[data-pile="${pile}"] td.net`);

test('Masafi register, recomputed volumes, 3D selection, surfaces and section', async ({ win }) => {
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await openMasafi(win);
  const vols = JSON.parse(readFileSync(join(MASAFI, 'volumes.json'), 'utf8')) as VolumesJson;

  // Register: 19 piles on 10 Jan 2021, triangulated toe, as volumes.json says.
  await expect(win.locator('[data-testid="vol-register"] tbody tr')).toHaveCount(19);
  await expect(rowNet(win, 'P02')).toHaveText('11,379');
  await win.getByLabel('Base surface').first().selectOption('low');
  await expect(rowNet(win, 'P02')).toHaveText('14,240');
  await win.getByLabel('Base surface').first().selectOption('tin');
  await win.locator('[data-testid="vol-register"] th button', { hasText: 'Net' }).click();
  await expect(win.locator('[data-testid="vol-register"] tbody tr').first()).toHaveAttribute(
    'data-pile',
    'P02',
  );

  // Every pile, date and base recomputed in the volume worker from the 10 cm grids: within 0.5 %.
  const ids = vols.piles.map((p) => p.id);
  const recomputed = await inspect(
    win,
    async ({ w, a: piles }) => {
      const svc = w.__stratlas.volumetric.getState().service;
      if (!svc) throw new Error('no volume worker');
      const out: Record<string, Recomputed> = {};
      for (const id of piles) out[id] = await svc.recompute(id);
      return out;
    },
    ids,
  );
  let worst = 0;
  let count = 0;
  for (const p of vols.piles)
    for (const [epoch, ep] of Object.entries(p.epochs))
      for (const [b, v] of Object.entries(ep.volumes)) {
        const r = recomputed[p.id]?.[epoch]?.[b];
        if (!r) throw new Error(`${p.id} ${epoch} ${b} was not recomputed`);
        worst = Math.max(worst, Math.abs(r.net - v.net) / Math.max(Math.abs(v.net), 10));
        count++;
      }
  expect(count).toBe(152);
  expect(worst).toBeLessThan(0.005);

  // By default no pile is drawn in 3D: no bodies, toe lines or volume callouts; a hint says how.
  await expect(win.getByTestId('vol-hint')).toBeVisible();
  for (const id of ids) expect(await pileDrawn(win, id)).toBe(false);
  expect(await calloutText(win)).not.toContain('m³');
  // the survey's flat ortho is not drawn in 3D (its terrain carries the photo), the map has it
  expect(
    await inspect(
      win,
      ({ w }) => [
        w.__stratlas.workspace.getState().isLayerVisible('ortho-2021-01-10'),
        w.__stratlas.stage()?.scene.getObjectByName('layer:ortho-2021-01-10')?.visible,
      ],
      null,
    ),
  ).toEqual([true, false]);
  // the offline street map lies under the yard
  if (existsSync(join(PACKS, 'kuwait.pmtiles')))
    await expect
      .poll(
        () =>
          inspect(
            win,
            ({ w }) =>
              w.__stratlas.stage()?.scene.getObjectByName('basemap:site-street-map')?.visible ??
              false,
            null,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

  // Selecting a pile selects its node in 3D, draws its body, base plate and toe line.
  await win.locator('[data-testid="vol-register"] tbody tr[data-pile="P02"]').click();
  await expect(win.getByTestId('vol-pile')).toHaveAttribute('data-pile', 'P02');
  await expect(win.getByTestId('vol-recomputed')).toHaveText('11,379 m³', { timeout: 30_000 });
  expect(await inspect(win, ({ w }) => w.__stratlas.workspace.getState().selection, null)).toEqual({
    kind: 'asset',
    id: 'P02_e2',
    layer: 'terrain-2021-01-10',
  });
  await expect
    .poll(() =>
      inspect(
        win,
        ({ w }) => {
          const s = w.__stratlas.stage()?.scene;
          const g = s?.getObjectByName('vol:P02') as
            { getObjectByName(n: string): unknown } | undefined;
          return !!g && !!g.getObjectByName('base-plate') && !!g.getObjectByName('toe-selected');
        },
        null,
      ),
    )
    .toBe(true);
  // only that pile, with its measurement on the callout; the panel has fill, cut, net and edits
  expect(await pileDrawn(win, 'P05')).toBe(false);
  await expect.poll(() => calloutText(win)).toContain('11,379 m³ · 18,206 t');
  await expect(win.getByTestId('vol-measure')).toContainText('11,384');
  await expect(win.getByTestId('vol-last-edit')).toContainText('Never');

  // Esc hides it again; a click on a pile on the terrain flies to it and reveals it.
  await win.locator('[data-scene-view] canvas').hover();
  await win.keyboard.press('Escape');
  await expect.poll(() => pileDrawn(win, 'P02')).toBe(false);
  expect(
    await inspect(win, ({ w }) => w.__stratlas.volumetric.getState().selected, null),
  ).toBeNull();
  await win.locator('body').press('h'); // whole site
  await win.waitForTimeout(1500);
  const at = await pileOnScreen(win, 'P05_e2');
  await win.mouse.click(at.x, at.y);
  await expect
    .poll(() => inspect(win, ({ w }) => w.__stratlas.volumetric.getState().selected, null))
    .toBe('P05');
  await expect.poll(() => pileDrawn(win, 'P05')).toBe(true);
  await expect(win.getByTestId('vol-pile')).toHaveAttribute('data-pile', 'P05');
  await win.getByRole('button', { name: 'All piles', exact: true }).click();
  await expect.poll(() => pileDrawn(win, 'P05')).toBe(false);
  await win.locator('[data-testid="vol-register"] tbody tr[data-pile="P02"]').click();

  // The other survey: its terrain shows, the other hides.
  await win.locator('.vol-dates button', { hasText: '31 Dec' }).click();
  expect(
    await inspect(
      win,
      ({ w }) => {
        const s = w.__stratlas.workspace.getState();
        return [s.isLayerVisible('terrain-2020-12-31'), s.isLayerVisible('terrain-2021-01-10')];
      },
      null,
    ),
  ).toEqual([true, false]);
  await expect(win.getByTestId('vol-net')).toHaveText('14,687 m³');
  await win.locator('.vol-dates button', { hasText: '10 Jan' }).click();

  // Elevation colours drape on the shown survey, straight from the toolbar.
  const surfaces = win.getByRole('group', { name: 'Surface colours' });
  await surfaces.getByRole('button', { name: 'Elevation' }).click();
  await expect
    .poll(
      () =>
        inspect(
          win,
          ({ w }) => w.__stratlas.stage()?.scene.getObjectByName('drape:e2')?.visible ?? false,
          null,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  // its ramp, range (metres, auto from the surveys) and hillshade are chosen on the legend
  const elev = win.getByTestId('vol-elev');
  await expect(elev.getByRole('radio', { name: 'Turbo' })).toHaveAttribute('aria-checked', 'true');
  await expect(elev.locator('.ends')).toContainText(' m');
  const drapeKey = () =>
    inspect(
      win,
      ({ w }) => {
        const d = w.__stratlas.stage()?.scene.getObjectByName('drape:e2') as
          { uuid: string } | undefined;
        return d?.uuid ?? null;
      },
      null,
    );
  const first = await drapeKey();
  await elev.getByRole('radio', { name: 'Viridis' }).click();
  await expect.poll(drapeKey, { timeout: 20_000 }).not.toBe(first);
  await expect(elev.getByRole('radio', { name: 'Viridis' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await elev.getByRole('checkbox', { name: 'Hillshade' }).uncheck();
  await expect
    .poll(() =>
      inspect(win, ({ w }) => w.__stratlas.volumetric.getState().elevation?.hillshade, null),
    )
    .toBe(false);
  await elev.getByRole('checkbox', { name: 'Hillshade' }).check();
  await elev.getByRole('radio', { name: 'Turbo' }).click();

  // Cut and fill colours drape on the last survey.
  await surfaces.getByRole('button', { name: 'Cut / fill' }).click();
  await expect
    .poll(
      () =>
        inspect(
          win,
          ({ w }) => w.__stratlas.stage()?.scene.getObjectByName('drape:e2')?.visible ?? false,
          null,
        ),
      {
        timeout: 20_000,
      },
    )
    .toBe(true);
  // the panel counts the change by pile, cut to fill
  await win.getByRole('button', { name: 'All piles', exact: true }).click();
  await expect(win.getByTestId('vol-change').locator('button[data-pile]').first()).toHaveAttribute(
    'data-pile',
    'P05',
  );
  await expect(win.getByTestId('vol-change').locator('button[data-pile="P05"]')).toContainText(
    '−5,116',
  );
  await surfaces.getByRole('button', { name: 'Photo' }).click();

  // Piles show on purpose one by one or all at once; hiding all goes back to none.
  await expect.poll(() => pileDrawn(win, 'P05')).toBe(false);
  await win.getByRole('button', { name: 'Show P03 in 3D' }).click();
  await expect.poll(() => pileDrawn(win, 'P03')).toBe(true);
  await expect.poll(() => pileDrawn(win, 'P05')).toBe(false);
  await expect(win.getByTestId('vol-shown-n')).toContainText('1 shown in 3D');
  // with some shown the one button shows every pile, then hides every pile
  await win.getByTestId('vol-eye-all').click();
  await expect.poll(() => pileDrawn(win, 'P05')).toBe(true);
  await expect(win.getByTestId('vol-shown-n')).toContainText('19 shown in 3D');
  await win.getByTestId('vol-eye-all').click();
  await expect.poll(() => pileDrawn(win, 'P03')).toBe(false);
  await expect.poll(() => pileDrawn(win, 'P05')).toBe(false);

  // Swipe shows both surveys.
  await win.locator('.vol-dates button', { hasText: 'Swipe' }).click();
  await expect(win.getByTestId('vol-swipe')).toBeVisible();
  expect(
    await inspect(
      win,
      ({ w }) => {
        const s = w.__stratlas.workspace.getState();
        return [s.isLayerVisible('terrain-2020-12-31'), s.isLayerVisible('terrain-2021-01-10')];
      },
      null,
    ),
  ).toEqual([true, true]);
  await win.locator('.vol-dates button', { hasText: 'Swipe' }).click();

  // Section across the yard: a profile of both surveys with cut and fill areas.
  await win.locator('body').press('h'); // whole site
  await win.waitForTimeout(1200);
  await win.getByRole('button', { name: 'Section line between the surveys' }).click();
  const box = await win.locator('[data-scene-view] canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  const camera = () =>
    inspect(
      win,
      ({ w }) => {
        const p = (
          w.__stratlas.stage() as unknown as {
            camera: { position: { x: number; y: number; z: number } };
          }
        ).camera.position;
        return [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100);
      },
      null,
    );
  await win.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.45);
  // after the first point the camera stays put while the mouse moves to the second
  const before = await camera();
  await win.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 12 });
  expect(await camera()).toEqual(before);
  await win.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await expect(win.getByTestId('vol-sec-cut')).toHaveText(/\d+ m² cut/, { timeout: 20_000 });
  await expect(win.getByTestId('vol-sec-fill')).toHaveText(/\d+ m² fill/);
  expect(
    await inspect(win, ({ w }) => w.__stratlas.volumetric.getState().selected, null),
  ).toBeNull();

  expect(errors).toEqual([]);
});

test('Masafi boundary edit in 3D is recomputed, saved to the project, and exported', async ({
  app,
  win,
  root,
}) => {
  const realBefore = boundariesOf(MASAFI);
  await openMasafi(win);
  await win.locator('[data-testid="vol-register"] tbody tr[data-pile="P02"]').click();
  await win.getByRole('button', { name: 'Edit boundary' }).click();
  // The automatic line simplified, every base refitted to it: the original review shows 7,637 m³.
  await expect(win.getByTestId('vol-edit-net')).toHaveText('7,637 m³', { timeout: 30_000 });
  await win.waitForTimeout(800);
  const handle = win.locator('.vol-vh').nth(3);
  const hb = await handle.boundingBox();
  if (!hb) throw new Error('no boundary handle on screen');
  await win.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await win.mouse.down();
  await win.mouse.move(hb.x + 40, hb.y + 30, { steps: 8 });
  await win.mouse.up();
  await expect(win.getByTestId('vol-editbar')).toContainText('automatic 11,379 m³');
  await win.locator('[data-testid="vol-editbar"] button', { hasText: 'Save' }).click();
  await expect(win.getByTestId('vol-editbar')).toHaveCount(0);

  const file = JSON.parse(
    await readFile(join(root, 'data', 'projects', 'masafi', 'edits', 'boundaries.json'), 'utf8'),
  ) as {
    schema: string;
    edits: { pile: string; epoch: string; ring: number[][]; volumes: { tin: Fcn } }[];
  };
  expect(file.schema).toBe('aio.boundaries/1');
  expect(file.edits).toHaveLength(1);
  expect(file.edits[0]).toMatchObject({ pile: 'P02', epoch: 'e2' });
  const net = file.edits[0]?.volumes.tin.net ?? 0;
  await expect(win.getByTestId('vol-net')).toHaveText(
    `${Math.round(net).toLocaleString('en-US')} m³`,
  );

  // The register carries the edit, and the CSV export says so.
  await win.getByRole('button', { name: 'All piles', exact: true }).click();
  await expect(rowNet(win, 'P02')).toHaveText(Math.round(net).toLocaleString('en-US'));
  await expect(win.locator('tr[data-pile="P02"] .vol-ed')).toHaveCount(1);
  const target = join(root, 'register.csv');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
  }, target);
  await win.getByRole('button', { name: 'CSV' }).click();
  await expect.poll(() => existsSync(target)).toBe(true);
  const csv = (await readFile(target, 'utf8')).trim().split('\n');
  expect(csv).toHaveLength(20);
  expect(csv[0]?.startsWith('pile,name,status,e1_date')).toBe(true);
  expect(csv.find((l) => l.startsWith('P02,'))?.endsWith('edited 10 Jan 2021')).toBe(true);
  // the real project is never written
  expect(boundariesOf(MASAFI)).toBe(realBefore);
});
