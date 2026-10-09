/**
 * Terrain overlays in the real app (M11 G5, SRV-8) on the synthetic earthworks demo: from the
 * Overlays panel, **Contours** (0.5 m minor, 2.5 m major) and a **Gradient** in degrees of a
 * prepared survey are made by `survey.overlay`, listed in `survey/overlays.json` (never in the
 * manifest) and drawn on the map; hiding one takes it off the map. Off-screen, zero network,
 * pipeline Python needed.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { openDemo, prepareSurveys } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

interface Registry {
  schema: string;
  overlays: {
    id: string;
    kind: string;
    visible: boolean;
    dir: string;
    options: Record<string, unknown>;
  }[];
}

/** Overlay layer ids on the map on screen. */
function overlayLayers(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
      | (Element & { __aioMap: { getStyle(): { layers: { id: string }[] } | undefined } })
      | undefined;
    return (el?.__aioMap.getStyle()?.layers ?? [])
      .map((l) => l.id)
      .filter((id) => id.startsWith('aio-ov-'));
  });
}

test('contours and a gradient in degrees are made, listed and shown on the map', async ({
  earthworksProject,
  win,
}) => {
  test.setTimeout(420_000);
  const root = earthworksProject.dir;
  await prepareSurveys(win, root);
  await openDemo(win, earthworksProject.name, earthworksProject.id);

  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-overlays-open').click();
  const panel = win.getByTestId('overlays-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('overlay-surface').selectOption('dsm-d2');

  // contours, 0.5 m minor and 2.5 m major (the defaults)
  await panel.getByTestId('overlay-kind-contours').click();
  await expect(panel.getByTestId('overlay-minor')).toHaveValue('0.5');
  await expect(panel.getByTestId('overlay-major')).toHaveValue('2.5');
  await panel.getByTestId('overlay-create').click();
  await expect(panel.getByTestId('overlay-item').filter({ hasText: 'Contours' })).toHaveCount(1, {
    timeout: 180_000,
  });

  // gradient in degrees
  await panel.getByTestId('overlay-kind-slope').click();
  await panel.getByTestId('overlay-style').selectOption('degrees');
  await panel.getByTestId('overlay-create').click();
  await expect(panel.getByTestId('overlay-item').filter({ hasText: 'Slope' })).toHaveCount(1, {
    timeout: 180_000,
  });
  await expectAccessible(win, 'Terrain overlays panel', {
    include: '[data-testid="overlays-panel"]',
  });

  const reg = JSON.parse(await readFile(join(root, 'survey', 'overlays.json'), 'utf8')) as Registry;
  expect(reg.schema).toBe('aio.survey-overlays/1');
  const contours = reg.overlays.find((o) => o.kind === 'contours');
  const slope = reg.overlays.find((o) => o.kind === 'slope');
  expect(contours?.options).toMatchObject({ minorM: 0.5, majorM: 2.5 });
  expect(slope?.options).toMatchObject({ style: 'degrees' });
  const geo = JSON.parse(
    await readFile(join(root, contours?.dir ?? '', 'contours.geojson'), 'utf8'),
  ) as { features: { properties: { levelM: number; major: boolean } }[] };
  expect(geo.features.length).toBeGreaterThan(0);
  for (const f of geo.features) {
    const lv = f.properties.levelM;
    expect(Math.abs(lv / 0.5 - Math.round(lv / 0.5))).toBeLessThan(1e-9);
    expect(f.properties.major).toBe(Math.abs(lv / 2.5 - Math.round(lv / 2.5)) < 1e-9);
  }
  const manifest = await readFile(join(root, 'manifest.json'), 'utf8');
  expect(manifest).not.toContain('survey/overlays');

  // shown on the map: the contour lines and the gradient's tiles
  await panel.getByRole('button', { name: 'Close the overlays' }).click();
  await win.getByRole('button', { name: 'Map', exact: true }).first().click();
  await expect
    .poll(() => overlayLayers(win), { timeout: 60_000 })
    .toEqual(
      expect.arrayContaining([`aio-ov-${contours?.id ?? ''}`, `aio-ov-${slope?.id ?? ''}-0`]),
    );

  // hiding the gradient takes it off the map and is saved
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-overlays-open').click();
  // the box follows the saved list, so it clears once the save is done
  const show = panel.getByRole('checkbox', { name: /Show Slope/ });
  await show.click();
  await expect(show).not.toBeChecked();
  await expect
    .poll(() => overlayLayers(win), { timeout: 30_000 })
    .not.toContain(`aio-ov-${slope?.id ?? ''}-0`);
  await expect
    .poll(async () => {
      const r = JSON.parse(
        await readFile(join(root, 'survey', 'overlays.json'), 'utf8'),
      ) as Registry;
      return r.overlays.find((o) => o.kind === 'slope')?.visible;
    })
    .toBe(false);
});
