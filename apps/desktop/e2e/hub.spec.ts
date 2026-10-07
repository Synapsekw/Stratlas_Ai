/**
 * M9 T5: two reviewers share one project through a hub folder (a temp folder standing in for the
 * NAS). Each instance has its own userData, identity and device. No network: the guard of each
 * app must stay empty.
 */
import { copyFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, twoReviewersTest as test, type TwoReviewers } from './fixtures';
import {
  openTeamProject,
  registerOf,
  setSeverity,
  setTitle,
  shareThroughHub,
  syncNow,
} from './team';

/** Rana shares through the hub; Omar's copy gets the team file and joins the same project. */
async function bothOnHub({ a, b, hub }: TwoReviewers): Promise<void> {
  await openTeamProject(a.win);
  await shareThroughHub(a.win, hub);
  // Omar copies the shared project's team file with his copy of the folder
  await copyFile(join(a.project, 'team.json'), join(b.project, 'team.json'));
  await openTeamProject(b.win);
  await shareThroughHub(b.win, hub);
  expect(await readdir(join(hub))).toContain('aio-hub.json');
}

test('an edit travels through the hub, and one made while it is away syncs later', async ({
  twoReviewers,
}) => {
  test.setTimeout(180_000);
  const { a, b, hub } = twoReviewers;
  await bothOnHub(twoReviewers);

  // Rana edits, syncs; Omar syncs and sees it
  await setTitle(a.win, 'F01', 'Corroded bolt');
  expect(await syncNow(a.win)).toMatch(/Synced: \d+ received, [1-9]\d* sent/);
  expect(await syncNow(b.win)).toMatch(/Synced: [1-9]\d* received/);
  await expect(await registerOf(b)).toContainText('Corroded bolt');

  // the hub goes away: Rana keeps working, the chip says so, and the change waits
  await rename(hub, `${hub}-away`);
  await setTitle(a.win, 'F02', 'Loose flange');
  expect(await syncNow(a.win)).toMatch(/cannot be reached/);
  await expect(a.win.getByTestId('sync-chip')).toHaveAttribute('data-state', 'offline');
  await expect(a.win.getByTestId('sync-pending')).toBeVisible();
  await expect(await registerOf(a)).toContainText('Loose flange');

  // it is back: the change goes out and arrives
  await rename(`${hub}-away`, hub);
  expect(await syncNow(a.win)).toMatch(/Synced/);
  await expect(a.win.getByTestId('sync-chip')).toHaveAttribute('data-state', 'ok');
  expect(await syncNow(b.win)).toMatch(/Synced: [1-9]\d* received/);
  await expect(await registerOf(b)).toContainText('Loose flange');
});

test('concurrent edits of one field show a conflict in both copies', async ({ twoReviewers }) => {
  test.setTimeout(180_000);
  const { a, b } = twoReviewers;
  await bothOnHub(twoReviewers);

  // both change F01's severity without seeing each other
  await setSeverity(a.win, 'F01', 3);
  await setSeverity(b.win, 'F01', 1);
  await syncNow(a.win);
  await syncNow(b.win);
  await syncNow(a.win);

  for (const r of [a, b]) {
    await expect(r.win.getByTestId('sync-conflicts')).toHaveText('1 conflict', { timeout: 15_000 });
    await r.win.getByTestId('sync-chip').click();
    await expect(r.win.getByTestId('team-conflicts-note')).toContainText(
      'both copies changed the same field',
    );
    await r.win
      .getByTestId('team-status')
      .getByRole('button', { name: 'Close', exact: true })
      .last()
      .click();
  }
});
