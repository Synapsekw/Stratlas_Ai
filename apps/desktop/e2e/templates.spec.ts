/**
 * Measurement templates in the real app (M11 G3): make "Pad check" (a volume template with a
 * dropdown "Crew" and a cut and fill comparison), bookmark it, use it twice from the toolbar, set
 * the Crew on one and filter the list by it. Synthetic tiny project, off-screen, zero network;
 * axe on the template editor.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, openProject, test } from './fixtures';

async function openTiny(win: Page): Promise<string> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe('e2e-tiny');
  return (await openProject(win)).root ?? '';
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

test.describe('measurement templates', () => {
  test('a custom template with a dropdown field, bookmarked and used twice', async ({ win }) => {
    const root = await openTiny(win);
    await win.getByRole('button', { name: 'Survey measurements' }).click();
    await win.getByTestId('survey-templates-open').click();
    const dlg = win.getByTestId('survey-templates');
    await expect(dlg).toBeVisible();

    await dlg.getByTestId('survey-template-new').click();
    await dlg.getByTestId('survey-template-name').fill('Pad check');
    await dlg.getByTestId('survey-template-tool').selectOption('volume');
    await dlg.getByTestId('survey-field-name').fill('Crew');
    await dlg.getByTestId('survey-field-type').selectOption('dropdown');
    await dlg.getByTestId('survey-field-options').fill('North, South');
    await dlg.getByTestId('survey-field-add').click();
    await expect(dlg.getByTestId('survey-template-field-crew')).toBeVisible();
    await dlg.getByLabel('Comparison label').fill('Cut and fill');
    await dlg.getByTestId('survey-comparison-add').click();
    await dlg.getByTestId('survey-template-bookmark').check();
    await expectAccessible(win, 'Template editor', { include: '[data-testid="survey-templates"]' });
    await dlg.getByTestId('survey-template-save').click();
    await expect(dlg.getByTestId('survey-template-pad-check')).toBeVisible();
    await dlg.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(dlg).toHaveCount(0);

    const tpl = await readJson<{
      templates: { id: string; tool: string; bookmarked?: boolean; fields: unknown[] }[];
    }>(join(root, 'survey', 'templates.json'));
    expect(tpl.templates[0]).toMatchObject({
      id: 'pad-check',
      tool: 'volume',
      bookmarked: true,
      fields: [{ id: 'crew', name: 'Crew', type: 'dropdown', options: ['North', 'South'] }],
    });

    // the bookmark is on the toolbar: draw two pads with it
    await win.getByRole('button', { name: 'Survey measurements' }).click();
    await win.getByTestId('survey-bookmark-pad-check').click();
    await expect(win.getByTestId('survey-drawbar')).toContainText('Pad check');
    const box = await win.locator('[data-scene-view] canvas').first().boundingBox();
    if (!box) throw new Error('no 3D view');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const dx of [-160, 60]) {
      await win.mouse.click(cx + dx, cy - 40);
      await win.mouse.click(cx + dx + 80, cy - 40);
      await win.mouse.click(cx + dx + 80, cy + 50);
      await win.keyboard.press('Enter');
    }
    await expect(win.getByTestId('survey-item')).toHaveCount(2);
    await win.keyboard.press('Escape');

    // set the Crew on the second pad, then filter the list by it
    const panel = win.getByTestId('survey-panel');
    await expect(panel.getByTestId('survey-label')).toHaveValue('Pad check 2');
    await panel.getByTestId('survey-field-crew').selectOption('North');
    const list = win.getByTestId('survey-list');
    await list.getByRole('button', { name: /Filters/ }).click();
    await list.getByTestId('survey-filter-field').selectOption('crew=North');
    await expect(win.getByTestId('survey-item')).toHaveCount(1);
    await list.getByTestId('survey-filter-field').selectOption('');
    await expect(win.getByTestId('survey-item')).toHaveCount(2);

    await win.getByTestId('survey-list-save').click();
    await expect(list).toContainText('Measurements saved.');
    const saved = await readJson<{
      measurements: {
        label: string;
        template?: string;
        tool: string;
        fields?: Record<string, string>;
        items: { id: string; from: { kind: string }; to: { kind: string } }[];
      }[];
    }>(join(root, 'survey', 'measurements.json'));
    expect(saved.measurements.map((m) => [m.label, m.template, m.tool])).toEqual([
      ['Pad check 1', 'pad-check', 'volume'],
      ['Pad check 2', 'pad-check', 'volume'],
    ]);
    expect(saved.measurements[1]?.fields).toEqual({ crew: 'North' });
    for (const m of saved.measurements)
      expect(m.items).toEqual([
        expect.objectContaining({
          id: 'cut-and-fill',
          from: { kind: 'smart' },
          to: { kind: 'current' },
        }),
      ]);
  });
});
