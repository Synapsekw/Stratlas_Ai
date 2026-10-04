/**
 * Builder walkthrough on real (client) data, outside the CI suite: runs only when
 * STRATLAS_B2_RAW points at a folder with `ebsm/` (raw EBSM photos with EXIF GPS) and
 * `ebsm-glb/EBSM-Flare-model.glb`, and STRATLAS_B2_OUT at a folder for screenshots. The data root
 * is a temporary copy (STRATLAS_B2_DATA, holding `packs/`); nothing is written to the real one.
 *
 *   STRATLAS_B2_RAW=... STRATLAS_B2_DATA=... STRATLAS_B2_OUT=... npx playwright test builder-real
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromWgs84 } from '@aio/geo';
import { MAIN_ENTRY } from './fixtures';

const RAW = process.env.STRATLAS_B2_RAW ?? '';
const DATA = process.env.STRATLAS_B2_DATA ?? '';
const OUT = process.env.STRATLAS_B2_OUT ?? '';

test.skip(!RAW || !DATA || !OUT, 'real-data walkthrough: set STRATLAS_B2_RAW, _DATA and _OUT');
test.setTimeout(300_000);

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

const shot = (win: Page, name: string) => win.screenshot({ path: join(OUT, name) });

interface StratlasWindow {
  __stratlas: {
    workspace: {
      getState: () => {
        setLayerVisible: (id: string, v: boolean) => void;
        flyTo: (t: { kind: 'home' }) => void;
      };
    };
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

/** Screen points over the canvas whose ray hits the mesh layer, with the local hit point. */
async function meshHits(win: Page, layerId: string) {
  return win.evaluate((id) => {
    const st = (window as unknown as StratlasWindow).__stratlas.stage();
    const canvas = document.querySelector('[data-scene-view] canvas');
    if (!st || !canvas) return [];
    const r = canvas.getBoundingClientRect();
    const out: { x: number; y: number; p: [number, number, number] }[] = [];
    for (let i = 6; i < 58; i++)
      for (let j = 10; j < 54; j++) {
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
        if (lid !== id) continue;
        out.push({
          x: r.left + ((nx + 1) / 2) * r.width,
          y: r.top + ((1 - ny) / 2) * r.height,
          p: [hit.point.x, hit.point.y, hit.point.z],
        });
      }
    return out;
  }, layerId);
}

/** `n` hits spread apart in plan and height (greedy farthest point). */
function pickSpread<T extends { p: [number, number, number] }>(hits: T[], n: number): T[] {
  if (!hits.length) return [];
  const d = (a: T, b: T) => Math.hypot(a.p[0] - b.p[0], (a.p[1] - b.p[1]) * 0.3, a.p[2] - b.p[2]);
  const top = hits.reduce((m, h) => (h.p[1] > m.p[1] ? h : m));
  const out = [top];
  while (out.length < n) {
    let best: T | undefined;
    let bd = -1;
    for (const h of hits) {
      const m = Math.min(...out.map((o) => d(o, h)));
      if (m > bd) {
        bd = m;
        best = h;
      }
    }
    if (!best || bd <= 0) break;
    out.push(best);
  }
  return out;
}

/** The kit's georeference of the EBSM model (E:/Stratlas Data/projects/ebsm). */
const KIT_ORIGIN: [number, number, number] = [221029.443, 3214461.958, 31.7];
const KIT_T = [
  0.024999398714205534, 0, -0.999687466193274, 0, 0, 1, 0, 0, 0.999687466193274, 0,
  0.024999398714205534, 0, 0, 0, 0, 1,
];
const kitLocal = (s: [number, number, number]): [number, number, number] => [
  (KIT_T[0] ?? 0) * s[0] + (KIT_T[4] ?? 0) * s[1] + (KIT_T[8] ?? 0) * s[2],
  (KIT_T[1] ?? 0) * s[0] + (KIT_T[5] ?? 0) * s[1] + (KIT_T[9] ?? 0) * s[2],
  (KIT_T[2] ?? 0) * s[0] + (KIT_T[6] ?? 0) * s[1] + (KIT_T[10] ?? 0) * s[2],
];
/** Survey coordinates (E, N, H) of a model point. */
function truth(s: [number, number, number]): [number, number, number] {
  const l = kitLocal(s);
  return [KIT_ORIGIN[0] + l[0], KIT_ORIGIN[1] - l[2], KIT_ORIGIN[2] + l[1]];
}
/** The transform the alignment should find in a project with another origin. */
function expectedTransform(origin: [number, number, number]): number[] {
  const t = [...KIT_T];
  t[12] = KIT_ORIGIN[0] - origin[0];
  t[13] = KIT_ORIGIN[2] - origin[2];
  t[14] = -(KIT_ORIGIN[1] - origin[1]);
  return t;
}

const REAL_PROJECTS = ['alzour', 'damac', 'ebsm', 'hcl', 'masafi', 'ringroad'].map(
  (p) => `E:/Stratlas Data/projects/${p}`,
);

test('new project from raw EBSM photos and the GLB: create, import, align, annotate', async () => {
  const user = await mkdtemp(join(tmpdir(), 'aio-b2-user-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      STRATLAS_DATA: DATA,
      STRATLAS_USER_DATA: user,
    },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // the library's projects (read only) offer their severity models to the wizard
    for (const p of REAL_PROJECTS)
      await win.evaluate((path) => window.aio.invoke('library:add', { path }), p);
    await win.reload();

    // 1. wizard
    await win.getByTestId('new-project').first().click();
    const wiz = win.getByTestId('new-project-wizard');
    await expect(wiz).toBeVisible();
    await wiz.getByLabel('Project name').fill('EBSM flare (rebuilt)');
    await wiz.getByLabel('Customer').fill('EQUATE');
    await wiz.getByLabel('Site').fill('Shuaiba, Kuwait');
    await shot(win, '01-wizard-project.png');
    await wiz.getByRole('button', { name: 'Next' }).click();
    const photos = (await readdir(join(RAW, 'ebsm'))).filter((f) => /\.jpe?g$/i.test(f)).sort();
    const first = join(RAW, 'ebsm', photos[0] ?? '');
    await nextOpenDialog(app, [first]);
    await wiz.getByRole('button', { name: 'Pick a photo' }).click();
    await expect(wiz.getByTestId('origin-readout')).toContainText('E 2');
    await shot(win, '02-wizard-place.png');
    await wiz.getByRole('button', { name: 'Next' }).click();
    await wiz
      .getByRole('option', { name: /Stack, chimney or flare/ })
      .first()
      .click();
    await shot(win, '03-wizard-standards.png');
    await wiz.getByRole('button', { name: 'Next' }).click();
    await shot(win, '04-wizard-review.png');
    await wiz.getByRole('button', { name: 'Create project' }).click();
    await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
    await shot(win, '05-empty-project.png');

    // 2. import 20 photos and the GLB
    await nextOpenDialog(app, [
      ...photos.map((f) => join(RAW, 'ebsm', f)),
      join(RAW, 'ebsm-glb', 'EBSM-Flare-model.glb'),
    ]);
    await win.getByRole('button', { name: 'Import files' }).click();
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText(/Imported \d+ of \d+ files/, { timeout: 240_000 });
    await shot(win, '06-imported.png');
    const root = join(DATA, 'projects', 'ebsm-flare-rebuilt');
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      origin: [number, number, number];
      layers: { kind: string; id: string; items?: unknown[] }[];
      verticalDatum?: { absAltOffsetM: number };
    };
    expect(manifest.layers.map((l) => l.kind).sort()).toEqual(['mesh', 'photos']);
    // the origin height came from the photo's absolute altitude: heights share that datum
    expect(manifest.verticalDatum?.absAltOffsetM).toBe(0);
    await expect(panel.getByTestId('import-heights-line')).toContainText(
      'absolute altitude + 0.0 m',
    );
    await panel.getByRole('button', { name: 'Close' }).click();

    // 3. the GLB loads in the kit frame (X north): frame it alone
    const meshId = manifest.layers.find((l) => l.kind === 'mesh')?.id ?? '';
    await expect
      .poll(() => meshHits(win, meshId).then((h) => h.length), { timeout: 90_000 })
      .toBeGreaterThan(0);
    await win.evaluate(() => {
      const ws = (window as unknown as StratlasWindow).__stratlas.workspace.getState();
      ws.setLayerVisible('photos', false);
      ws.flyTo({ kind: 'home' });
    });
    await win.waitForTimeout(2500);
    await shot(win, '07-model-before-align.png');

    // 4. georeference by four point pairs: picked on the model, true coordinates typed (they come
    //    from the kit's own georeference of this model, the reference for the check)
    await win.keyboard.press('Control+K');
    await win.keyboard.type('Georeference');
    await win.keyboard.press('Enter');
    const align = win.getByTestId('align-model');
    await expect(align).toBeVisible();
    const hits = pickSpread(await meshHits(win, meshId), 4);
    expect(hits.length).toBe(4);
    for (const h of hits) {
      await align.getByTestId('pick-model').click();
      await win.mouse.click(h.x, h.y);
      const text = (await align.getByTestId('align-pending').textContent()) ?? '';
      const src = text.replace('Model point', '').trim().split(/\s+/).map(Number) as [
        number,
        number,
        number,
      ];
      const t = truth(src);
      await align.getByRole('button', { name: 'Typed' }).click();
      await align
        .getByLabel('Target coordinate')
        .fill(`${t[0].toFixed(3)} ${t[1].toFixed(3)} ${t[2].toFixed(3)}`);
      await align.getByLabel('Target coordinate').press('Enter');
    }
    await expect(align.getByTestId('align-stats')).toBeVisible();
    await shot(win, '08-align-pairs.png');
    const rmsText =
      (await align.getByTestId('align-stats').locator('b').first().textContent()) ?? '';
    await align.getByTestId('align-save').click();
    await expect(align).toContainText('Saved.');
    const after = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      origin: [number, number, number];
      layers: { kind: string; transform?: number[] }[];
    };
    const tr = after.layers.find((l) => l.kind === 'mesh')?.transform ?? [];
    const expected = expectedTransform(after.origin);
    const worst = Math.max(...tr.map((v, i) => Math.abs(v - (expected[i] ?? 0))));
    process.stdout.write(
      `align: RMS ${rmsText}, worst matrix element difference to the kit georeference ${worst.toFixed(4)}
`,
    );
    expect(worst).toBeLessThan(0.05);
    await align.getByRole('button', { name: 'Close' }).click();
    await win.evaluate(() => {
      const ws = (window as unknown as StratlasWindow).__stratlas.workspace.getState();
      ws.setLayerVisible('photos', true);
      ws.flyTo({ kind: 'home' });
    });
    await expect
      .poll(() => meshHits(win, meshId).then((h) => h.length), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await win.waitForTimeout(2500);
    await shot(win, '09-aligned-with-photos.png');

    // 5. annotate: a pin on the model becomes an issue
    await win.evaluate(() => {
      const ws = (window as unknown as StratlasWindow).__stratlas.workspace.getState();
      ws.setLayerVisible('photos', false);
      ws.flyTo({ kind: 'home' });
    });
    await win.waitForTimeout(2000);
    await win.locator('[data-scene-view] canvas').click({ position: { x: 5, y: 5 } });
    await win.keyboard.press('a');
    await win.locator('.ann-subbar').getByRole('button', { name: 'Pin' }).click();
    const [pin] = pickSpread(await meshHits(win, meshId), 1);
    if (!pin) throw new Error('no point on the model to pin');
    await win.mouse.click(pin.x, pin.y);
    const pop = win.getByRole('dialog', { name: 'New issue' });
    await expect(pop).toBeVisible();
    await pop.getByRole('listbox', { name: 'Class' }).getByRole('button').first().click();
    await pop.getByRole('group', { name: 'Severity' }).getByRole('button').nth(1).click();
    await pop.getByRole('button', { name: 'Create issue' }).click();
    await expect
      .poll(
        async () => {
          const f = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as {
            issues: unknown[];
          };
          return f.issues.length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    await win.waitForTimeout(800);
    await shot(win, '10-annotated.png');
  } finally {
    await app.close();
    await rm(user, { recursive: true, force: true });
  }
});

test('raw DJI video with its SRT imports as a placed clip and opens in calibration', async () => {
  const mp4 = join(RAW, 'dji', 'DJI_0498.MP4');
  const user = await mkdtemp(join(tmpdir(), 'aio-b2-user-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      STRATLAS_DATA: DATA,
      STRATLAS_USER_DATA: user,
    },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const o = fromWgs84([47.98378, 29.38445, 0], 32639);
    const created = await win.evaluate(
      (origin) =>
        window.aio.invoke('builder:createProject', {
          name: 'Bobyan clip test',
          type: 'fusion',
          epsg: 32639,
          origin,
          severityTemplate: null,
        }),
      [o[0], o[1], 0] as [number, number, number],
    );
    expect(created.ok).toBe(true);
    await win.reload();
    await win.getByTestId('project-card').filter({ hasText: 'Bobyan clip test' }).first().click();
    await expect(win.getByTestId('empty-project')).toBeVisible({ timeout: 30_000 });
    await nextOpenDialog(app, [mp4]);
    await win.getByRole('button', { name: 'Import files' }).click();
    // relative altitude in a project without a vertical datum: confirm the take-off height
    const heights = win.getByTestId('import-heights');
    await expect(heights).toBeVisible({ timeout: 60_000 });
    await expect(heights.getByTestId('takeoff-warning')).toBeVisible();
    await shot(win, '11a-dji-heights.png');
    await heights.getByRole('button', { name: 'Import' }).click();
    const panel = win.getByTestId('import-panel');
    await expect(panel).toContainText('SRT matches the video frames within', { timeout: 120_000 });
    const msg = (await panel.locator('li p').first().textContent()) ?? '';
    process.stdout.write(`video import: ${msg}
`);
    await shot(win, '11-dji-imported.png');
    const root = created.ok ? created.path : '';
    const flight = JSON.parse(await readFile(join(root, 'flights', 'dji-0498.json'), 'utf8')) as {
      schema: string;
      samples: { t: number }[];
    };
    expect(flight.schema).toBe('aio.flight/1');
    expect(flight.samples.length).toBe(270);
    await panel.getByRole('button', { name: 'Close' }).click();
    await win.keyboard.press('Control+K');
    await win.keyboard.type('Calibrate video');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('calibrate-video')).toBeVisible();
    await win.waitForTimeout(3000);
    await shot(win, '12-dji-calibrate.png');
  } finally {
    await app.close();
    await rm(user, { recursive: true, force: true });
  }
});
