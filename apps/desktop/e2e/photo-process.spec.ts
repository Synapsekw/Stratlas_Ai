/**
 * Create maps from photos (M10 G4): choose the photos, then start. The one screen sums the photos
 * up and estimates for this computer, the run shows one list of steps in plain words with pause
 * and resume, cancel and resume, the maps start by themselves and come back as layers ("Your maps
 * are ready"), then the accuracy report and **Use refined poses**. What makes processing
 * impossible on this computer shows the moment the dialog opens, with the button that fixes it.
 *
 * Runs on the e2e stand-in pipelines (`e2e/photo-fake`, see `photoPack.ts`): the app's side of
 * processing; the app sees the fake ODM of `python/tests/fake_odm` as its processing engine.
 * Needs the development Python (`uv sync` in python/, or QUADRION_E2E_PYTHON), except the blocked
 * states, which run nothing. Synthetic photos only; zero network.
 */
import type { Locator, Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import {
  expect,
  hasPipelinePython,
  launchApp,
  openProcessing,
  processingChip,
  test as plain,
  VENV_PYTHON,
} from './fixtures';
import {
  buildPhotoPack,
  CAMERAS,
  chooseFolder,
  oldPackEnv,
  openOptions,
  packEnv,
  openPhotoSite,
  openWizard,
  PHOTO_DAY,
  PHOTO_PLATFORM,
  PHOTO_PLATFORM_ONLY,
  PHOTO_PROJECT,
  photoFixtures,
  runId,
  startRun,
  type PhotoFixtures,
  type PhotoWorkerFixtures,
} from './photoPack';

const test = plain.extend<PhotoFixtures, PhotoWorkerFixtures>(photoFixtures);
/**
 * The same, on a pack of its own (`ownPack`, its folder): a test may take it away while a run is
 * at work without touching the pack the other tests of the worker share. A start is refused by
 * the app before any pipeline runs, so the stand-in pipelines cannot refuse one themselves.
 */
const alone = test.extend<{ ownPack: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  ownPack: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'aio-photo-pack-own-'));
    try {
      await use(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  appEnv: async ({ ownPack, photoSite }, use) => {
    expect(photoSite.dir).toBeTruthy();
    await use(await buildPhotoPack(ownPack));
  },
});
/** PHOTO_DAY the way the app writes a date. */
const DAY_WORDS = '14 Mar 2026';

/** Screenshots for a person to look at: only with QUADRION_E2E_SHOTS set to a folder. */
const SHOTS = process.env.QUADRION_E2E_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

interface Probe {
  __stratlas: {
    workspace: {
      getState(): {
        project: {
          manifest: {
            captures: { id: string; date: string }[];
            layers: {
              id: string;
              kind: string;
              capture?: string;
              items?: { id: string; pos?: number[] }[];
            }[];
          };
        } | null;
      };
    };
  };
}

const layers = (win: Page) =>
  win.evaluate(() =>
    (window as unknown as Probe).__stratlas.workspace
      .getState()
      .project?.manifest.layers.map((l) => ({ id: l.id, kind: l.kind, items: l.items ?? [] })),
  );

/** A step of the run in plain words: `read`, `match`, `map`, `model` or `add`. */
const phase = (win: Page, id: string) =>
  win.getByTestId('photo-phases').locator(`[data-phase="${id}"]`);

test.describe('on the stand-in pipelines', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);

  test('choose photos and start: one screen, one run, and the maps come back as layers', async ({
    win,
    photoSite,
  }) => {
    test.setTimeout(180_000);
    await openPhotoSite(win);
    const wizard = await openWizard(win);

    // one screen: the project's photos are already chosen, summed up in a line, with the time
    await expect(wizard.getByRole('button', { name: /Photos in this project/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(wizard.getByRole('combobox')).toContainText('Synthetic flight (12 photos)');
    await expect(wizard.getByTestId('photo-summary')).toHaveText(
      '12 photos, 1 camera, GPS on all',
      { timeout: 60_000 },
    );
    await expect(wizard.getByTestId('photo-estimate')).toContainText(
      /(About \d|Under a minute).* on this computer/,
    );
    await expect(wizard.getByTestId('photo-needs')).toContainText('of disk space and');
    // the project by name, and the survey date worked out from the photos
    await expect(wizard.getByTestId('photo-project')).toHaveText(`Project: ${PHOTO_PROJECT.name}`);
    await expect(wizard.getByTestId('photo-date')).toHaveText(`Survey date: ${DAY_WORDS} (new)`);
    await expect(wizard.getByTestId('photo-days')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-destination')).toHaveText(
      `The maps are added to ${PHOTO_PROJECT.name}.`,
    );
    // an ordinary flight on Standard: no question, no warning, nothing blocked, ready to start
    await expect(wizard.getByTestId('photo-blocked')).toHaveCount(0);
    for (const id of ['ask-disk', 'ask-time', 'ask-zone', 'photo-gps', 'photo-none'])
      await expect(wizard.getByTestId(id)).toHaveCount(0);
    await expect(wizard.locator('.notice')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-missing')).toHaveText('');
    await expect(wizard.getByTestId('photo-start')).toBeEnabled();
    await expect(wizard.getByTestId('photo-start')).toHaveText('Create maps');
    // the plain words of the main view: no engine-room vocabulary
    const main = await wizard.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelector('details')?.remove();
      return copy.textContent;
    });
    expect(main).not.toMatch(/photogrammetry|pipeline|align|products|warm laptop|GPU|CPU/i);
    await expectAccessible(win, 'create maps from photos', {
      include: '[data-testid="photo-wizard"]',
    });
    await shot(win, 'create-maps-ready');

    // every earlier choice is still there, under Options, with the same defaults
    const options = await openOptions(wizard);
    for (const name of ['Quick', 'Standard', 'High'])
      await expect(options.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(options.getByRole('button', { name: /^Standard/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    for (const name of [
      'Orthomosaic',
      'Surface model (DSM)',
      'Terrain model (DTM)',
      'Point cloud',
      'Textured mesh',
    ])
      await expect(options.getByRole('checkbox', { name })).toBeChecked();
    await expect(options.getByRole('checkbox', { name: /^3D Tiles/ })).not.toBeChecked();
    await expect(options.getByRole('option', { name: /EPSG:32639/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(options).toContainText('The photos are in UTM zone 39N (EPSG:32639).');
    await expect(options.getByRole('radio', { name: /^Read each photo/ })).toBeChecked();
    await expect(options.getByTestId('photo-heights')).toContainText(
      'Every run states the heights',
    );
    await expect(
      options.getByRole('checkbox', { name: /ground control points/ }),
    ).not.toBeChecked();
    await expect(options.getByTestId('photo-groups')).toContainText(
      'Stratlas Synthetic SYN-20, 800 × 600 (12 photos)',
    );
    // what does the work is quiet detail, never a fault to fix
    await expect(options.getByTestId('photo-gpu')).toContainText(
      /used for processing|switched off|No NVIDIA graphics card found/,
    );
    await expect(options).not.toContainText('not installed');
    await expectAccessible(win, 'create maps from photos, options', {
      include: '[data-testid="photo-wizard"]',
    });
    await shot(win, 'create-maps-options');
    await wizard.getByTestId('photo-start').click();

    // one run, one list of steps in plain words; pause while matching, then resume from there
    const panel = win.getByTestId('photo-run');
    await expect(panel).toBeVisible();
    const run = await runId(win);
    await expect(panel.getByTestId('photo-run-project')).toContainText(PHOTO_PROJECT.name);
    await expect(phase(win, 'match')).toHaveAttribute('data-state', 'running', {
      timeout: 60_000,
    });
    // the date is not added while the photos are still being matched
    expect(
      await win.evaluate(
        (day) =>
          (window as unknown as Probe).__stratlas.workspace
            .getState()
            .project?.manifest.captures.some((c) => c.date === day),
        PHOTO_DAY,
      ),
    ).toBe(false);
    // nor is it written to the project's manifest on disk
    const onDisk = JSON.parse(await readFile(join(photoSite.dir, 'manifest.json'), 'utf8')) as {
      captures: { id: string; date: string }[];
    };
    expect(onDisk.captures.some((c) => c.date === PHOTO_DAY)).toBe(false);
    expect(onDisk.captures.some((c) => c.id === `capture-${PHOTO_DAY}`)).toBe(false);
    await expect(phase(win, 'match')).toContainText('Matching photos');
    // the maps are part of the same run from the start
    await expect(phase(win, 'map')).toHaveAttribute('data-state', 'pending');
    await expect(phase(win, 'map')).toContainText('Building the map');
    await expect(phase(win, 'model')).toContainText('Building the 3D model');
    // the dialog has given way to the run panel by now
    await expectAccessible(win, 'photo run, starting', { include: '[data-testid="photo-run"]' });
    await shot(win, 'create-maps-running');
    await panel.getByRole('button', { name: 'Pause' }).click();
    await expect(panel.getByTestId('photo-job').locator('[data-status="cancelled"]')).toHaveText(
      'Paused',
      { timeout: 20_000 },
    );
    await expect(phase(win, 'read')).toHaveAttribute('data-state', 'done');
    await expect(phase(win, 'map')).toHaveAttribute('data-state', 'pending');
    await panel.getByRole('button', { name: 'Resume' }).click();
    // reading the photos is kept from before the pause
    await expect(phase(win, 'read')).toHaveAttribute('data-state', 'kept', { timeout: 20_000 });

    // the maps start by themselves and come back as layers
    const results = panel.getByTestId('photo-results');
    await expect(results).toContainText('Your maps are ready', { timeout: 60_000 });
    await expect(results).toContainText(`Processed mesh ${run}`);
    await expect(results.getByRole('button', { name: 'Show on map' })).toBeVisible();
    await expect(results.getByRole('button', { name: 'Show in 3D' })).toBeVisible();
    await expect(
      results.getByRole('button', { name: 'Improve accuracy with ground control points' }),
    ).toBeVisible();
    await expect
      .poll(async () => (await layers(win))?.map((l) => l.id))
      .toContain(`photo-${run}-mesh`);
    // the new layer is under the photos' survey date, which the run added
    const filed = () =>
      win.evaluate(
        ([id, day]) => {
          const m = (window as unknown as Probe).__stratlas.workspace.getState().project?.manifest;
          const capture = m?.layers.find((l) => l.id === id)?.capture;
          return { capture, date: m?.captures.find((c) => c.id === capture)?.date, day };
        },
        [`photo-${run}-mesh`, PHOTO_DAY] as const,
      );
    await expect.poll(async () => (await filed()).capture).toBe(`capture-${PHOTO_DAY}`);
    await expect.poll(async () => (await filed()).date).toBe(PHOTO_DAY);
    await expect(results.getByTestId('photo-results-where')).toHaveText(
      `Added to ${PHOTO_PROJECT.name} under ${DAY_WORDS} as new layers:`,
    );
    await expectAccessible(win, 'photo run, maps ready', { include: '[data-testid="photo-run"]' });
    await shot(win, 'create-maps-done');

    // accuracy without ground control says so
    await panel.getByRole('tab', { name: 'Accuracy' }).click();
    await expect(panel.getByTestId('accuracy-headline')).toContainText('GNSS only');
    await expect(panel.getByTestId('overlap-map')).toBeVisible();
    await expectAccessible(win, 'accuracy report (GNSS only)', {
      include: '[data-testid="photo-run"]',
    });

    // refined poses: a preview first, then the move on the person's word
    await panel.getByRole('tab', { name: 'Refined poses' }).click();
    await expect(panel.getByTestId('poses-preview')).toContainText('12 cameras move by');
    await panel.getByRole('button', { name: 'Use refined poses' }).click();
    await panel.getByRole('button', { name: 'Move the cameras' }).click();
    await expect(panel.getByTestId('poses-applied')).toBeVisible();
    await expect
      .poll(async () => {
        const photos = (await layers(win))?.find((l) => l.id === 'photos');
        return photos?.items.find((i) => i.id === CAMERAS[0]?.id)?.pos?.[0];
      })
      .toBeCloseTo((CAMERAS[0]?.pos[0] ?? 0) + 0.05, 6);
    await expectAccessible(win, 'refined poses', { include: '[data-testid="photo-run"]' });

    // the runs list in the Processing drawer, and from the result straight to the map
    await panel.getByRole('button', { name: 'Close' }).click();
    const drawer = await openProcessing(win);
    const runs = drawer.getByTestId('photo-runs');
    await expect(runs.locator(`[data-run="${run}"]`)).toContainText('Done');
    await runs.locator(`[data-run="${run}"]`).getByRole('button', { name: 'Open run' }).click();
    await expect(drawer).toHaveCount(0);
    await panel.getByRole('button', { name: 'Show on map' }).click();
    await expect(panel).toHaveCount(0);
    await expect(
      win.getByRole('group', { name: 'Stage view' }).getByRole('button', { name: 'Map' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  test('cancel keeps the work, resume continues, and a photo job opens its run', async ({
    win,
  }) => {
    test.setTimeout(180_000);
    await openPhotoSite(win);
    const panel = await startRun(win);
    const run = await runId(win);
    await expect(phase(win, 'match')).toHaveAttribute('data-state', 'running', {
      timeout: 60_000,
    });
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toContainText('Cancelled. The work so far is kept', { timeout: 20_000 });
    // the maps queued at the start are dropped with the cancel
    await expect(phase(win, 'map')).toHaveCount(0);
    await panel.getByRole('button', { name: 'resume it' }).click();
    await expect(panel.getByRole('region', { name: 'Next steps' })).toContainText(
      'The photos are matched',
      { timeout: 60_000 },
    );
    await expect(phase(win, 'read')).toHaveAttribute('data-state', 'kept');
    // every stage of the job is still there for whoever wants it
    await panel.getByText('Every step').click();
    await expect(
      panel.getByRole('list', { name: 'Stages' }).getByRole('listitem').filter({
        hasText: 'Align the photos (ODM)',
      }),
    ).toHaveAttribute('data-state', /skipped|done/);

    // from the project's processing: the photo job reads in plain words and opens its run
    await panel.getByRole('button', { name: 'Close' }).click();
    const drawer = await openProcessing(win);
    await drawer
      .locator('.job-row', { hasText: 'Maps from photos: matching the photos' })
      .first()
      .click();
    await drawer.getByTestId('job-open-run').click();
    await expect(drawer).toHaveCount(0);
    await expect(win.getByTestId('photo-run')).toBeVisible();
    await expect(win.getByTestId('photo-run').getByRole('heading', { level: 2 })).toHaveText(
      `Photo run ${run}`,
    );
  });

  alone(
    'maps that cannot start say why, and Create maps tries again under the same survey date',
    async ({ win, ownPack }) => {
      test.setTimeout(180_000);
      await openPhotoSite(win);
      const panel = await startRun(win);
      const run = await runId(win);
      await expect(phase(win, 'match')).toHaveAttribute('data-state', 'running', {
        timeout: 60_000,
      });
      // the processing tools go missing while the photos are matched: the maps cannot start
      const manifest = join(ownPack, 'manifest.json');
      await rename(manifest, `${manifest}.away`);
      const why = panel.getByTestId('photo-start-error');
      const next = panel.getByRole('region', { name: 'Next steps' });
      const create = next.getByRole('button', { name: 'Create maps' });
      try {
        await expect(why).toContainText('The maps could not be started.', { timeout: 60_000 });
        await expect(why).toContainText('is not a valid processing tools folder');
        // not left on "Working": matching is done, no maps are waiting, and the way on is there
        await expect(panel.getByTestId('photo-job').locator('[data-status]')).toHaveText('Done');
        await expect(phase(win, 'map')).toHaveCount(0);
        await expect(next).toContainText('Press Create maps to try again.');
        await expectAccessible(win, 'photo run, maps could not start', {
          include: '[data-testid="photo-run"]',
        });
        await shot(win, 'create-maps-not-started');
        // trying while the tools are still missing says it again, once
        await create.click();
        await expect(create).toBeEnabled();
        await expect(panel.getByRole('alert')).toHaveCount(1);
        await expect(why).toContainText('is not a valid processing tools folder');
      } finally {
        await rename(`${manifest}.away`, manifest);
      }

      // the tools are back: the same button builds the maps, and the message goes
      await create.click();
      await expect(why).toHaveCount(0);
      const results = panel.getByTestId('photo-results');
      await expect(results).toContainText('Your maps are ready', { timeout: 60_000 });
      // under the survey date the dialog worked out from the photos, kept through the refusal
      const filed = await win.evaluate(
        ([id]) => {
          const m = (window as unknown as Probe).__stratlas.workspace.getState().project?.manifest;
          const capture = m?.layers.find((l) => l.id === id)?.capture;
          return { capture, date: m?.captures.find((c) => c.id === capture)?.date };
        },
        [`photo-${run}-mesh`] as const,
      );
      expect(filed).toEqual({ capture: `capture-${PHOTO_DAY}`, date: PHOTO_DAY });
      await expect(results.getByTestId('photo-results-where')).toHaveText(
        `Added to ${PHOTO_PROJECT.name} under ${DAY_WORDS} as new layers:`,
      );
    },
  );

  test('a short flight raises no warning at any quality', async ({ win }) => {
    test.setTimeout(120_000);
    await openPhotoSite(win);
    const wizard = await openWizard(win);
    await expect(wizard.getByTestId('photo-summary')).toBeVisible({ timeout: 60_000 });
    const options = await openOptions(wizard);
    await options.getByRole('button', { name: /^High/ }).click();
    await expect(options.getByRole('button', { name: /^High/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(wizard.getByTestId('photo-estimate')).toContainText('on this computer');
    // twelve small photos are quick at any quality: the long-run hint is for long runs only
    await expect(wizard.getByTestId('ask-time')).toHaveCount(0);
    await expect(wizard.locator('.notice')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-start')).toBeEnabled();
  });

  test('the wizard works from the keyboard alone', async ({ win }) => {
    test.setTimeout(120_000);
    await openPhotoSite(win);
    // Tab (or Shift+Tab) until `target` has the focus, at most 40 presses
    const tabTo = async (target: Locator, back = false) => {
      for (let i = 0; i < 40; i++) {
        if (await target.evaluate((el) => el === document.activeElement)) return;
        await win.keyboard.press(back ? 'Shift+Tab' : 'Tab');
      }
      const at = await win.evaluate(() =>
        String(document.activeElement?.textContent).trim().slice(0, 60),
      );
      throw new Error(`40 presses of Tab did not reach the target; the focus is on "${at}"`);
    };
    await processingChip(win).focus();
    await win.keyboard.press('Enter');
    const drawer = win.getByTestId('processing-drawer');
    await expect(drawer).toBeVisible();
    const create = drawer.getByTestId('create-maps');
    await tabTo(create);
    await win.keyboard.press('Enter');
    const wizard = win.getByRole('dialog', { name: 'Create maps from photos' });
    await expect(wizard).toBeVisible();
    await expect
      .poll(() => wizard.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await expect(wizard.getByTestId('photo-summary')).toBeVisible({ timeout: 60_000 });
    const options = wizard.getByTestId('photo-options');
    const summary = options.locator('summary');
    await tabTo(summary);
    await win.keyboard.press('Enter');
    await expect(options.getByRole('group', { name: 'Quality' })).toBeVisible();
    const quick = options.getByRole('button', { name: /^Quick/ });
    await tabTo(quick);
    await win.keyboard.press('Space');
    await expect(quick).toHaveAttribute('aria-pressed', 'true');
    // close Options again, then on to Create maps
    await tabTo(summary, true);
    await win.keyboard.press('Enter');
    await expect(options.getByRole('group', { name: 'Quality' })).toBeHidden();
    await tabTo(wizard.getByTestId('photo-start'));
    await expect(wizard.getByTestId('photo-start')).toBeEnabled();
    await win.keyboard.press('Escape');
    await expect(wizard).toHaveCount(0);
    // the drawer closed when the dialog opened, so the focus goes back to the Processing chip
    // (it fell to the page body before this test)
    const focused = await win.evaluate(
      () =>
        document.activeElement?.getAttribute('data-testid') ??
        document.activeElement?.tagName ??
        null,
    );
    expect(focused).toBe('processing-chip');
  });

  test('a very long run says so once, with the quicker quality one click away', async ({
    app,
    win,
    dataRoot,
  }) => {
    test.setTimeout(120_000);
    // 2,000 photo heads of 108 megapixels without GPS (only the head of a photo is read for the
    // estimate): days of work at any quality, on any computer
    const flight = join(dataRoot.base, 'long flight');
    await mkdir(flight, { recursive: true });
    const [w, h] = [12000, 9000];
    const head = Buffer.from([
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      h >> 8,
      h & 0xff,
      w >> 8,
      w & 0xff,
      0x03,
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x01,
      0x03,
      0x11,
      0x01,
      0xff,
      0xd9,
    ]);
    for (let i = 0; i < 2000; i++)
      await writeFile(join(flight, `BIG_${String(i).padStart(4, '0')}.JPG`), head);

    await openPhotoSite(win);
    const wizard = await openWizard(win);
    await wizard.getByRole('button', { name: /Folders of photos/ }).click();
    // nothing chosen yet: the one thing missing is said beside the button, which waits
    await expect(wizard.getByTestId('photo-missing')).toHaveText(
      'Choose a folder of photos to begin.',
    );
    await expect(wizard.getByTestId('photo-start')).toBeDisabled();
    await chooseFolder(app, wizard, flight);
    await expect(wizard.getByTestId('photo-summary')).toHaveText(
      'About 2,000 photos, 1 camera, no GPS',
      { timeout: 60_000 },
    );
    // one hint about time, with the quicker quality and its own estimate
    const hint = wizard.getByTestId('ask-time');
    await expect(hint).toHaveText(
      /^Standard takes about .+ on this computer\. Quick: about .+\.\s*Use Quick$/,
    );
    // no GPS at all is said in plain words; nothing else: no boilerplate, no second copy
    await expect(wizard.getByTestId('photo-gps')).toContainText(
      'These photos have no GPS position.',
    );
    await expect(wizard).not.toContainText(/warm laptop|Times are a range|expect a long run/);
    await expect(wizard.getByTestId('photo-start')).toBeEnabled();
    await expectAccessible(win, 'create maps from photos, questions', {
      include: '[data-testid="photo-wizard"]',
    });
    await shot(win, 'create-maps-questions');

    // with Options open the hint sits beside the quality it is about, still only once
    const options = await openOptions(wizard);
    await expect(options.getByTestId('ask-time')).toHaveCount(1);
    await expect(wizard.getByTestId('ask-time')).toHaveCount(1);
    await hint.getByRole('button', { name: 'Use Quick' }).click();
    await expect(options.getByRole('button', { name: /^Quick/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Quick is the quickest there is: nothing is left to switch to (and on a computer with many
    // cores it is no longer a long run, so the hint goes)
    await expect(hint.getByRole('button')).toHaveCount(0);
    await expect(wizard.getByTestId('photo-estimate')).toContainText('on this computer');
  });
});

// the plain fixtures: no pack at all, so nothing here needs the pipeline Python
plain.describe('when this computer cannot create maps', () => {
  plain(
    'the dialog says so first, in place of the form, with the one button that fixes it',
    async ({ win }) => {
      // the plain fixtures have no pack at all; the tiny project is enough to open the dialog
      await win.getByTestId('project-card').first().click();
      const wizard = await openWizard(win);
      const blocked = wizard.getByTestId('photo-blocked');
      await expect(blocked).toBeVisible();
      // in place of the form: nothing to fill in, no second copy of the message, no dead Start
      await expect(wizard.getByTestId('photo-start')).toHaveCount(0);
      await expect(wizard.getByTestId('photo-options')).toHaveCount(0);
      await expect(wizard.locator('.notice, .b-foot')).toHaveCount(0);
      await expect(blocked.locator('p')).toHaveCount(1);
      await expect(wizard).not.toContainText(/pipeline pack/i);
      await expectAccessible(win, 'create maps from photos, blocked', {
        include: '[data-testid="photo-wizard"]',
      });
      const fix = blocked.getByRole('button', { name: 'Update processing tools' });
      if (!PHOTO_PLATFORM) {
        // an Intel Mac, Windows on Arm, Linux: nothing on this computer fixes it, so no button
        await expect(blocked).toContainText('This computer cannot create maps from photos');
        await expect(blocked).toContainText('runs on Windows x64');
        await expect(fix).toHaveCount(0);
        await blocked.getByRole('button', { name: 'Close' }).click();
        await expect(wizard).toHaveCount(0);
        return;
      }
      await expect(blocked).toContainText('The processing tools are not installed');
      await expect(blocked).toContainText('needs the processing tools, version 0.8.0 or later');
      await fix.click();
      await expect(wizard).toHaveCount(0);
      // Settings, on the page that installs and updates this computer's processing tools
      await expect(win.locator('.screen.settings')).toBeVisible();
      await expect(win.getByRole('heading', { level: 1, name: 'Processing tools' })).toBeVisible();
      await expect(win.getByTestId('processing-tools').getByTestId('tools-state')).toHaveAttribute(
        'data-state',
        'missing',
      );
      await expect(win.getByTestId('tools-choose')).toBeVisible();
    },
  );

  plain(
    'with processing tools that are too old it asks for the update before anything is chosen',
    async ({ dataRoot, network }) => {
      // where the computer itself cannot process photos, that comes before the tools' version
      plain.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);
      const dir = await mkdtemp(join(tmpdir(), 'aio-old-pack-'));
      const app = await launchApp(dataRoot, await oldPackEnv(dir));
      await network.attach(app);
      try {
        const win = await app.firstWindow();
        await win.getByTestId('project-card').first().click();
        const wizard = await openWizard(win);
        const blocked = wizard.getByTestId('photo-blocked');
        await expect(blocked).toContainText('The processing tools need an update');
        await expect(blocked).toContainText(
          'too old to create maps from photos. Update them to version 0.8.0 or later.',
        );
        await expect(
          blocked.getByRole('button', { name: 'Update processing tools' }),
        ).toBeVisible();
        await expect(wizard.getByTestId('photo-start')).toHaveCount(0);
        await expect(wizard.getByTestId('photo-drop')).toHaveCount(0);
        await expectAccessible(win, 'create maps from photos, tools too old', {
          include: '[data-testid="photo-wizard"]',
        });
        await shot(win, 'create-maps-blocked');
        expect(await network.outbound()).toEqual([]);
      } finally {
        await app.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  plain(
    'with the processing tools but no processing engine it asks for the engine first',
    async ({ dataRoot, network }) => {
      plain.skip(!PHOTO_PLATFORM, PHOTO_PLATFORM_ONLY);
      // a pack new enough (nothing in it ever runs), no QUADRION_ODM_DIR and no ODM installed
      const dir = await mkdtemp(join(tmpdir(), 'aio-pack-no-engine-'));
      const app = await launchApp(dataRoot, {
        ...(await packEnv(dir, '0.8.0')),
        QUADRION_ODM_DIR: '',
      });
      await network.attach(app);
      try {
        const win = await app.firstWindow();
        await win.getByTestId('project-card').first().click();
        const wizard = await openWizard(win);
        const blocked = wizard.getByTestId('photo-blocked');
        await expect(blocked).toContainText('Install the processing engine first');
        await expect(wizard.getByTestId('photo-start')).toHaveCount(0);
        const fix = blocked.getByTestId('photo-fix');
        await expect(fix).toHaveText('Install the processing engine');
        await expectAccessible(win, 'create maps from photos, no processing engine', {
          include: '[data-testid="photo-wizard"]',
        });
        await fix.click();
        await expect(wizard).toHaveCount(0);
        // Settings, Processing tools, with the Processing engine card in view and its button focused
        await expect(
          win.getByRole('heading', { level: 1, name: 'Processing tools' }),
        ).toBeVisible();
        const card = win.getByTestId('engine');
        await expect(card.getByTestId('engine-state')).toHaveAttribute(
          'data-state',
          'not-installed',
        );
        await expect(card).toBeInViewport();
        await expect(card.getByTestId('engine-install')).toBeFocused();
        expect(await network.outbound()).toEqual([]);
      } finally {
        await app.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
