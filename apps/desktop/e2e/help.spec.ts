/** The in-app user guide: F1, search, links between chapters and the "?" beside settings. */
import { expect, test } from './fixtures';

test('F1 opens the guide; search, contents and settings help land on the right section', async ({
  win,
}) => {
  const dialog = win.getByRole('dialog', { name: 'User guide' });

  // F1 opens it on the first chapter, with the cursor in the search box
  await expect(
    win.getByRole('heading', { name: /Project library|No projects/ }).first(),
  ).toBeVisible();
  await win.keyboard.press('F1');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('heading', { level: 1, name: 'Install and first start' }),
  ).toBeVisible();
  const search = dialog.getByRole('searchbox', { name: 'Search the guide' });
  await expect(search).toBeFocused();

  // search finds the workspace ID section; Enter opens the best hit
  await search.fill('workspace id');
  await expect(dialog.locator('.help-hit').first()).toContainText('Anthropic workspace ID');
  await search.press('Enter');
  await expect(
    dialog.getByRole('heading', { level: 3, name: 'Anthropic workspace ID' }),
  ).toBeInViewport();

  // Esc clears the search first, then closes
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog.getByRole('navigation', { name: 'Contents' })).toBeVisible();

  // a link between chapters
  await dialog.getByRole('button', { name: /Troubleshooting/ }).click();
  await dialog.getByRole('link', { name: 'Calibrate video' }).click();
  await expect(dialog.getByRole('heading', { level: 2, name: 'Calibrate video' })).toBeInViewport();

  await win.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // the "?" on a Settings page opens its section
  await win.getByRole('button', { name: 'Settings Settings' }).click();
  await win
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Graphics quality' })
    .click();
  await win.getByRole('button', { name: 'Help on this' }).click();
  await expect(
    dialog.getByRole('heading', { level: 2, name: 'Graphics quality' }),
  ).toBeInViewport();
  await dialog.getByRole('button', { name: 'Close the guide (Esc)' }).click();
  await expect(dialog).toBeHidden();

  // the title bar "?" opens it too
  await win.getByTestId('help-open').click();
  await expect(dialog).toBeVisible();
});
