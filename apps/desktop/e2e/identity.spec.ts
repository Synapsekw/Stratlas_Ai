/**
 * Identity, members and roles (M9 T2): the old free-text "Your name on issues" moves into the
 * identity with initials; a second person on the same PC (`--profile=reviewer-b`) exports an
 * identity card; the first person adds it to the open project as a reviewer, certified by them.
 * Fictional people only ("Rana Example", "Omar Sample").
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

async function openIdentity(win: Page) {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Identity and team' }).click();
  await expect(win.getByRole('heading', { name: 'Your identity' })).toBeVisible();
}

async function openTiny(win: Page) {
  await win.locator('.nav-item', { hasText: 'Projects' }).click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('.crumbs')).toContainText('E2E tiny project');
}

async function setField(win: Page, label: string, value: string) {
  const field = win.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press('Enter');
}

async function stubDialogs(app: ElectronApplication, save: string | null, open: string | null) {
  await app.evaluate(
    ({ dialog }, paths) => {
      if (paths.save) {
        dialog.showSaveDialog = () =>
          Promise.resolve({ canceled: false, filePath: paths.save ?? '' });
      }
      if (paths.open) {
        dialog.showOpenDialog = () =>
          Promise.resolve({ canceled: false, filePaths: [paths.open ?? ''] });
      }
    },
    { save, open },
  );
}

test('the old author name becomes the identity, with initials the person can change', async ({
  win,
  dataRoot,
}) => {
  await expect(win.getByTestId('project-card').first()).toBeVisible();
  // a 0.8 profile: the name lived in the renderer's storage
  await win.evaluate(() => {
    localStorage.setItem('stratlas.author', 'Rana Example');
  });
  await win.reload();
  await openIdentity(win);
  await expect(win.getByLabel('Your name', { exact: true })).toHaveValue('Rana Example');
  await expect(win.getByLabel('Initials', { exact: true })).toHaveValue('RE');

  await setField(win, 'Initials', 'X1Y');
  await expect(win.getByRole('alert')).toHaveText(
    'Initials are 1 to 3 letters, optionally followed by one digit.',
  );
  await setField(win, 'Initials', 'DR');
  await expect(win.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(async () => {
      const text = await readFile(join(dataRoot.userData, 'identity.json'), 'utf8');
      return (JSON.parse(text) as { initials: string; name: string; migratedFrom: string })
        .initials;
    })
    .toBe('DR');
  const saved = JSON.parse(await readFile(join(dataRoot.userData, 'identity.json'), 'utf8')) as {
    name: string;
    migratedFrom: string;
  };
  expect(saved).toMatchObject({ name: 'Rana Example', migratedFrom: 'author-setting' });
  // the identity file holds no key
  expect(JSON.stringify(saved)).not.toMatch(/private|seed|pkcs8/i);
});

test('a second profile exports a card and the owner adds it as an owner-certified reviewer', async ({
  app,
  win,
  dataRoot,
}) => {
  const card = join(dataRoot.base, 'Omar Sample.aioid');
  // Omar: a second instance on the same PC, own userData and vault service
  const network = new NetworkGuard();
  const omarApp = await launchApp(dataRoot, {}, ['--profile=reviewer-b']);
  try {
    await network.attach(omarApp);
    const omar = await omarApp.firstWindow();
    await omar.waitForLoadState('domcontentloaded');
    await openIdentity(omar);
    await setField(omar, 'Your name', 'Omar Sample');
    await expect(omar.getByLabel('Initials', { exact: true })).toHaveValue('OS');
    await stubDialogs(omarApp, card, null);
    await omar.getByRole('button', { name: 'Export identity card' }).click();
    await expect(omar.getByText(`Saved to ${card}`)).toBeVisible();
    await expect(omar.getByText(/^Device key d_/)).toBeVisible();
    const text = await readFile(card, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ schema: 'aio.idcard/1', name: 'Omar Sample' });
    expect(text).not.toMatch(/private|seed|pkcs8/i);

    // Rana: the first instance opens the project and adds Omar from the card
    await openTiny(win);
    await openIdentity(win);
    await setField(win, 'Your name', 'Rana Example');
    await expect(win.getByText('This project is not shared.', { exact: false })).toBeVisible();
    await stubDialogs(app, null, card);
    await win.getByRole('button', { name: 'Add from card' }).click();
    await expect(win.getByRole('group', { name: 'Add Omar Sample' })).toBeVisible();
    await win.getByLabel('Add as', { exact: true }).selectOption('reviewer');
    await win.getByRole('button', { name: 'Add Omar Sample' }).click();

    const table = win.getByRole('table', { name: 'Members of E2E tiny project' });
    await expect(table).toBeVisible();
    const omarRow = table.locator('tr', { hasText: 'Omar Sample' });
    await expect(omarRow).toContainText('Certified by you');
    await expect(omarRow.getByLabel('Role: Omar Sample')).toHaveValue('reviewer');
    const ranaRow = table.locator('tr', { hasText: 'Rana Example' });
    await expect(ranaRow).toContainText('(you)');
    await expect(ranaRow).toContainText('Owner');
    await expect(ranaRow).toContainText('Unverified');

    // the team lives in the project journal; Omar sees his role and cannot change the team
    await openTiny(omar);
    await openIdentity(omar);
    const omarTable = omar.getByRole('table', { name: 'Members of E2E tiny project' });
    await expect(omarTable.locator('tr', { hasText: 'Omar Sample' })).toContainText('Reviewer');
    await expect(omar.getByRole('button', { name: 'Add from card' })).toHaveCount(0);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await omarApp.close();
  }
});
