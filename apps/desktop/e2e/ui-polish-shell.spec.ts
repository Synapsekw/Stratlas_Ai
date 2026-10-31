/**
 * UI revision W1a, polish of the shell, the library, compare and processing, at the CI window:
 * - the project switcher shows whole project names (the customer on a second line);
 * - Create maps from photos sits in the sidebar's calm Processing section (founder, 31 Oct); a
 *   photo-only project also offers it on its library card and over its scene;
 * - Delete run sits behind the run's ··· menu and asks before deleting;
 * - Compare dates at 1100 x 700 keeps both pane dates readable;
 * - the footage clock (HH:MM:SS.ff) is never cut;
 * - the custom request's Class and Severity lists show their whole placeholder.
 *
 * The tiny project is rewritten as photo-only (two photos, a failed run) for the processing
 * tests. The demo tests use the bundled demo (`pnpm demo:build --quick`, `pnpm demo:change
 * --quick`) and skip without it. Zero network.
 */
import type { Locator, Page } from '@playwright/test';
import { ProjectManifest } from '@aio/schema';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEMO_FOLDER,
  expect,
  openProcessing,
  reportWindow,
  test,
  tinyManifest,
  type DataRoot,
} from './fixtures';
import { openInspect } from './inspect';
import { toggleCompareDates } from './island';
import { headerProblems } from './split';

const TINY = 'E2E tiny project';
const RUN = '20261030-0900';
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** A 1 x 1 grey JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////' +
    '////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

async function put(root: string, rel: string, data: string | Buffer): Promise<void> {
  const file = join(root, ...rel.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** The tiny project as photos only (no model, no map) with one failed run, before the app starts. */
async function writePhotoOnly(data: DataRoot): Promise<void> {
  const tiny = tinyManifest();
  const manifest = ProjectManifest.parse({
    ...tiny,
    layers: [
      {
        kind: 'photos',
        id: 'photos-a',
        name: 'Flight A',
        capture: 'capture-1',
        items: [
          { id: 'p1', src: { path: 'photos/p1.jpg' } },
          { id: 'p2', src: { path: 'photos/p2.jpg' } },
        ],
      },
    ],
  });
  await put(data.projectDir, 'manifest.json', JSON.stringify(manifest, null, 2));
  await put(data.projectDir, 'photos/p1.jpg', JPEG);
  await put(data.projectDir, 'photos/p2.jpg', JPEG);
  await put(
    data.projectDir,
    `photogrammetry/${RUN}/run.json`,
    JSON.stringify({
      schema: 'aio.photo-run/1',
      id: RUN,
      createdAt: '2026-10-30T09:00:00.000Z',
      status: 'failed',
      preset: 'fast',
      photos: { source: { layer: 'photos-a' }, count: 2 },
      cameras: [],
      crs: { epsg: 32639 },
      stages: [],
      outputs: { layers: [], tilesets: [], files: [] },
      versions: {},
    }),
  );
}

const photoOnly = test.extend({
  dataRoot: async ({ dataRoot }, use) => {
    await writePhotoOnly(dataRoot);
    await use(dataRoot);
  },
});

const card = (win: Page, name: string): Locator =>
  win
    .locator('.pcard-wrap')
    .filter({ has: win.getByTestId('project-card').filter({ hasText: name }) });

photoOnly.describe('a photo-only project', () => {
  photoOnly(
    'the sidebar shows Create maps under Processing; the card and the scene offer it too',
    async ({ win }) => {
      // the library card: photos and no maps, so Create maps from photos is one click away
      const action = card(win, TINY).getByTestId('card-create-maps');
      await expect(action).toHaveText('Create maps from photos');
      await shot(win, 'library-card-create-maps');
      await action.click();
      const wizard = win.getByRole('dialog', { name: 'Create maps from photos' });
      await expect(wizard).toBeVisible();
      await expect(win.locator('.proj-switch')).toContainText(TINY);
      await win.keyboard.press('Escape');
      await expect(wizard).toHaveCount(0);

      // in the sidebar, under its own Processing heading, as a row (not a filled button)
      const row = win.getByTestId('sidebar-processing').getByTestId('sidebar-create-maps');
      await expect(row).toBeVisible();
      await expect(row).not.toHaveClass(/(^|\s)primary(\s|$)/);
      await expect(
        win.locator('.sb-proj').getByRole('button', { name: /Create maps/ }),
      ).toHaveCount(0);

      // photo-only demo scene offers Create maps where the scene would be
      const offer = win.getByTestId('photos-maps-offer');
      await expect(offer).toBeVisible();
      await expect(offer).toContainText('Photos, no maps yet');
      await shot(win, 'scene-photos-offer');
      await offer.getByTestId('photos-create-maps').click();
      await expect(wizard).toBeVisible();
      await win.keyboard.press('Escape');
      await expect(wizard).toHaveCount(0);
      // Not now puts it away
      await offer.getByRole('button', { name: 'Not now' }).click();
      await expect(offer).toHaveCount(0);
    },
  );

  photoOnly('Delete run asks before deleting', async ({ win, dataRoot }) => {
    await win.getByTestId('project-card').filter({ hasText: TINY }).click();
    await expect(win.locator('.proj-switch')).toContainText(TINY);
    const drawer = await openProcessing(win);
    const row = drawer.getByTestId('photo-runs').locator(`[data-run="${RUN}"]`);
    await expect(row).toBeVisible();
    // not in the row beside Delete work files: behind the run's ··· menu
    await expect(row.getByRole('button', { name: 'Delete run' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Delete work files' })).toBeVisible();
    await row.getByTestId(`run-more-${RUN}`).click();
    const menu = win.getByTestId(`run-menu-${RUN}`);
    await expect(menu).toBeVisible();
    await shot(win, 'run-more-menu');
    await menu.getByRole('menuitem', { name: 'Delete run' }).click();
    // it asks; Keep leaves the run where it was
    const dialog = win.getByTestId('remove-dialog');
    await expect(dialog).toBeVisible();
    await expect(win.getByTestId('remove-dialog-title')).toHaveText(`Delete run ${RUN}?`);
    await win.getByTestId('remove-dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(existsSync(join(dataRoot.projectDir, 'photogrammetry', RUN, 'run.json'))).toBe(true);
  });
});

test.describe('with the bundled demos', () => {
  test.skip(
    !existsSync(join(DEMO_FOLDER, 'demo.json')),
    `no demo in ${DEMO_FOLDER}: run pnpm demo:build --quick`,
  );
  test.use({ appEnv: { QUADRION_DEMO: DEMO_FOLDER } });

  test('switcher menu shows full demo project names', async ({ win }) => {
    await reportWindow(win);
    await win.getByTestId('project-card').filter({ hasText: TINY }).click();
    await expect(win.locator('.proj-switch')).toContainText(TINY);
    await win.locator('.proj-switch').click();
    const menu = win.locator('.proj-menu');
    await expect(menu).toBeVisible();
    const names = menu.locator('.pm-n');
    await expect.poll(() => names.count()).toBeGreaterThan(3);
    const cut = await names.evaluateAll((els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    );
    expect(cut, 'project names cut in the switcher').toEqual([]);
    await shot(win, 'switcher-names');
  });

  test('the footage clock is never cut', async ({ win }) => {
    await reportWindow(win);
    await win.getByTestId('project-card').filter({ hasText: 'Demo tank farm' }).first().click();
    const clock = win.getByTestId('timecode');
    const footage = win.getByTestId('bottom-switch-footage');
    await expect(footage).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });
    // the strip may still settle on its remembered side as the project opens: pick Footage and
    // read the clock until both hold
    await expect(async () => {
      if ((await footage.getAttribute('aria-pressed')) !== 'true') await footage.click();
      await expect(clock).toHaveText(/^\d\d:\d\d:\d\d\.\d\d$/, { timeout: 2_000 });
      const fit = await clock.evaluate((el) => {
        const bar = el.parentElement?.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return {
          whole: el.scrollWidth <= el.clientWidth + 1,
          inBar: bar !== undefined && r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5,
          // nothing of the bar spills out of it either
          spill: [...(el.parentElement?.children ?? [])]
            .filter((c) => c.getBoundingClientRect().right > (bar?.right ?? 0) + 0.5)
            .map((c) => c.className),
        };
      });
      expect(fit).toEqual({ whole: true, inBar: true, spill: [] });
    }).toPass({ timeout: 30_000 });
    // a narrow bar drops zoom in and out (Ctrl + wheel zooms), never Fit
    await expect(
      win.getByTestId('lane-timeline').getByRole('button', { name: 'Fit', exact: true }),
    ).toBeVisible();
    await shot(win, 'footage-clock');
  });
});

test.describe('in the smallest window', () => {
  test.use({ appEnv: { QUADRION_WINDOW_SIZE: '1100x700' } });

  test('compare at 1100 x 700 keeps both pane dates readable', async ({ twoDateProject, win }) => {
    await win.getByTestId('project-card').filter({ hasText: 'E2E two dates' }).first().click();
    await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(win.locator('.proj-switch')).toContainText('E2E two dates');
    expect(twoDateProject.captures).toHaveLength(2);
    await toggleCompareDates(win);
    const head = (side: 'left' | 'right') => win.getByTestId(`pane-chooser-${side}`);
    for (const side of ['left', 'right'] as const) {
      const date = head(side).getByTestId('pane-date');
      await expect(date).toBeVisible();
      await expect(date).toBeInViewport({ ratio: 1 });
      await expect(date).toHaveText(/^\d{1,2} \w{3} 2026$/);
      const whole = await date.evaluate((el) => {
        const t = el.querySelector('.pane-date-t');
        return t !== null && t.scrollWidth <= t.clientWidth + 1;
      });
      expect(whole, `the ${side} date is cut`).toBe(true);
    }
    // under 1280 px How compare works folds into the tools row as a "?"
    await expect(win.locator('.compare-group > .compare-how')).toBeHidden();
    await expect(win.locator('.compare-how-q')).toBeVisible();
    await expect.poll(() => headerProblems(win)).toEqual([]);
    await shot(win, 'compare-1100');
  });
});

test.describe('Ask AI custom request', () => {
  test.use({ appEnv: { QUADRION_AI_TEST_PROVIDER: '1' } });

  test('custom request selects show their full placeholder', async ({ demoProject }) => {
    const { win } = demoProject;
    await reportWindow(win);
    await openInspect(win);
    // the first date's p01 (the change demo has one p01 per date)
    const tile = win
      .getByTestId('inspect-photos')
      .locator('section.m-sec')
      .filter({ hasText: 'Photos 2026-03-02' })
      .locator('[data-photo="p01"]');
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await expect(win.locator('[data-testid="photo-viewer"][aria-label="Photo p01"]')).toBeVisible();
    await win.getByTestId('ask-ai-checks').click();
    await win.getByTestId('ask-ai-custom').click();
    const panel = win.getByTestId('ask-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('ask-kind-find').click();
    for (const [id, name] of [
      ['ask-default-class', 'Class'],
      ['ask-default-severity', 'Severity'],
    ] as const) {
      const select = panel.getByTestId(id);
      await select.scrollIntoViewIfNeeded();
      // named by its label beside it, the list itself shows the whole placeholder
      await expect(select).toHaveAccessibleName(name);
      await expect(select.locator('option:checked')).toHaveText('Pick at accept');
      const room = await select.evaluate((el) => {
        const s = el as HTMLSelectElement;
        const probe = document.createElement('span');
        const cs = getComputedStyle(s);
        probe.style.font = cs.font;
        probe.style.position = 'absolute';
        probe.style.whiteSpace = 'nowrap';
        probe.textContent = s.selectedOptions[0]?.textContent ?? '';
        document.body.append(probe);
        const text = probe.getBoundingClientRect().width;
        probe.remove();
        const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 16; // the arrow
        return s.clientWidth - pad - text;
      });
      expect(room, `${name} cuts its placeholder`).toBeGreaterThanOrEqual(0);
    }
    await shot(win, 'ask-request-selects');
  });
});
