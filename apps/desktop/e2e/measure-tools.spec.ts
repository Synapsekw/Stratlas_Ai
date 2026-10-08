/**
 * Survey measurement tools in the real app (M11 G3): draw a polyline with **Distance** in the 3D
 * view, typing 25 and Enter for an exact 25 m segment and holding Shift to lock the angle; save it
 * (autosave is off); give it US survey feet while the site keeps metres. Runs on the synthetic
 * tiny project, off-screen, zero network; axe on the panel and the units dialog.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, openProject, test } from './fixtures';

interface Saved {
  schema: string;
  measurements: {
    id: string;
    tool: string;
    label: string;
    points: [number, number, number][];
    units?: Record<string, string>;
  }[];
}

const readSaved = async (root: string): Promise<Saved> =>
  JSON.parse(await readFile(join(root, 'survey', 'measurements.json'), 'utf8')) as Saved;

async function openTiny(win: Page): Promise<string> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe('e2e-tiny');
  return (await openProject(win)).root ?? '';
}

async function pickTool(win: Page, testId: string) {
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId(testId).click();
  await expect(win.getByTestId('survey-drawbar')).toBeVisible();
}

const bearing = (a: [number, number, number], b: [number, number, number]) =>
  ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;

test.describe('survey measurement tools', () => {
  test('draws a polyline with a typed 25 m segment and a Shift-locked angle, saves, and shows US survey feet', async ({
    win,
  }) => {
    const root = await openTiny(win);
    const canvas = win.locator('[data-scene-view] canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no 3D view');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await pickTool(win, 'survey-tool-distance');
    // first vertex on the site, then point the cursor east-ish and type the distance
    await win.mouse.click(cx, cy);
    await win.mouse.move(cx + 120, cy + 10);
    await win.keyboard.type('25');
    await expect(win.getByTestId('survey-typed-distance')).toContainText('25');
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('survey-drawbar')).toContainText('2 points');

    // hold Shift: the next segment locks to 15 degree steps (or the last bearing)
    await win.keyboard.down('Shift');
    await win.mouse.move(cx + 60, cy - 140);
    await expect(win.getByTestId('survey-drawbar')).toContainText('locked');
    await win.mouse.click(cx + 60, cy - 140);
    await win.keyboard.up('Shift');
    await expect(win.getByTestId('survey-drawbar')).toContainText('3 points');
    // Enter with nothing typed finishes the line; Esc puts the tool away
    await win.keyboard.press('Enter');
    await expect(win.getByTestId('survey-item')).toHaveCount(1);
    await win.keyboard.press('Escape');
    await expect(win.getByTestId('survey-drawbar')).toHaveCount(0);

    const panel = win.getByTestId('survey-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('survey-readout')).toContainText(' m');
    await expectAccessible(win, 'Survey measurement panel', {
      include: '[data-testid="survey-side"]',
    });

    // autosave is off: nothing on disk until Save
    await win.getByTestId('survey-list-save').click();
    await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
    const saved = await readSaved(root);
    expect(saved.schema).toBe('aio.measurements/1');
    const [line] = saved.measurements;
    expect(line?.tool).toBe('distance');
    const [p0, p1, p2] = line?.points ?? [];
    if (!p0 || !p1 || !p2) throw new Error('three vertices expected');
    expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])).toBeCloseTo(25, 6);
    const locked = bearing(p1, p2);
    const last = bearing(p0, p1);
    const steps = [0, 90, 180, 270].map((d) => (last + d) % 360);
    const onStep = Math.abs(locked / 15 - Math.round(locked / 15)) < 1e-6;
    const onLast = steps.some((b) => Math.abs(b - locked) < 1e-6);
    expect(onStep || onLast, `bearing ${String(locked)}`).toBe(true);

    // US survey feet for this measurement only
    await panel.getByTestId('survey-units-measurement').click();
    const dialog = win.getByTestId('survey-units-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('survey-unit-distance').selectOption('us-ft');
    await expect(dialog).toContainText('US ft');
    await expectAccessible(win, 'Survey units dialog', {
      include: '[data-testid="survey-units-dialog"]',
    });
    await dialog.getByTestId('survey-units-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(panel.getByTestId('survey-readout')).toContainText('US ft');
    await expect(panel.getByTestId('survey-units-summary')).toContainText('US ft');
    await win.getByTestId('survey-list-save').click();
    await expect
      .poll(async () => (await readSaved(root)).measurements[0]?.units)
      .toEqual({ distance: 'us-ft' });
  });
});
