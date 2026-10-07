/**
 * M9 T5: exchange files between two reviewers, as over an air gap: Rana shares, adds Omar from his
 * identity card as a reviewer and exports a patch; Omar (a plain copy of the project, not shared
 * yet) previews it, applies it and so joins the team project; importing it again says it is
 * already applied. His own patch back counts on Rana's copy (he is a member, nothing is held in
 * quarantine). An encrypted file asks for its passphrase first.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, TEAM_PROJECT_ID, twoReviewersTest as test, type Reviewer } from './fixtures';
import {
  addMember,
  answerOpenDialog,
  answerSaveDialog,
  invoke,
  openTeamProject,
  registerOf,
  setTitle,
  shareWithExchangeFiles,
} from './team';

async function exportPatch(r: Reviewer, out: string, passphrase?: string): Promise<string> {
  await answerSaveDialog(r.app, out);
  await r.win.getByTestId('sync-chip').click();
  await r.win.getByTestId('exchange-export-open').click();
  const dlg = r.win.getByTestId('exchange-export');
  await expect(dlg.getByTestId('exchange-plan')).toContainText(/\d+ changes?/);
  if (passphrase) {
    await dlg.getByRole('switch', { name: 'Encrypt with a passphrase' }).click();
    await dlg.getByLabel('Passphrase', { exact: true }).fill(passphrase);
    await dlg.getByLabel('Type it again', { exact: true }).fill(passphrase);
  }
  await dlg.getByTestId('exchange-export-go').click();
  await expect(dlg.getByTestId('exchange-done')).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  const files = (await readdir(out)).filter((f) => f.endsWith('.aiosync'));
  expect(files).toHaveLength(1);
  return join(out, files[0] ?? '');
}

/** From the chip: the Share dialog for a private project, or the Team dialog once shared. */
async function openImport(
  r: Reviewer,
  file: string,
): Promise<ReturnType<Reviewer['win']['getByTestId']>> {
  await answerOpenDialog(r.app, file);
  await r.win.getByTestId('sync-chip').click();
  const share = r.win.getByTestId('team-share');
  if (await share.isVisible().catch(() => false)) {
    await share.getByRole('button', { name: 'Import exchange file' }).click();
  } else {
    await r.win.getByTestId('exchange-import-open').click();
  }
  const dlg = r.win.getByTestId('exchange-import');
  await dlg.getByTestId('exchange-pick').click();
  return dlg;
}

test('a patch goes across by file: preview, apply, join, a second import is already applied, and one comes back', async ({
  twoReviewers,
}) => {
  test.setTimeout(180_000);
  const { a, b, out } = twoReviewers;
  await openTeamProject(a.win);
  await shareWithExchangeFiles(a.win);
  await addMember(a, b, join(out, 'cards'));
  await setTitle(a.win, 'F01', 'Cracked weld');
  const file = await exportPatch(a, out);

  await openTeamProject(b.win);
  await expect(b.win.getByTestId('sync-chip')).toHaveAttribute('data-mode', 'off');
  const dlg = await openImport(b, file);
  await expect(dlg.getByTestId('exchange-from')).toHaveText('Rana Example (RE)');
  await expect(dlg.getByTestId('exchange-signature')).toHaveText('Signed by their device');
  await expect(dlg.getByTestId('exchange-new')).toHaveText(/[1-9]\d* new changes?/);
  await expect(dlg).toContainText('part of the team project');
  await dlg.getByTestId('exchange-apply').click();
  await expect(dlg.getByTestId('exchange-applied')).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(await registerOf(b)).toContainText('Cracked weld');
  await expect(b.win.getByTestId('sync-chip')).toHaveAttribute('data-mode', 'exchange');

  // the same file again: nothing new
  const again = await openImport(b, file);
  await expect(again.getByTestId('exchange-already')).toBeVisible();
  await expect(again.getByTestId('exchange-apply')).toBeDisabled();
  await again.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(again).toHaveCount(0);
  expect(await invoke(b.win, 'members:list', { projectId: TEAM_PROJECT_ID })).toMatchObject({
    ok: true,
    me: 'reviewer',
  });

  // Omar's change goes back: he is a member, so it counts on Rana's copy
  await setTitle(b.win, 'F02', 'Weld spatter');
  const back = join(out, 'back');
  await mkdir(back);
  const reply = await exportPatch(b, back);
  const dlgA = await openImport(a, reply);
  await expect(dlgA.getByTestId('exchange-from')).toHaveText('Omar Sample (OS)');
  await dlgA.getByTestId('exchange-apply').click();
  await expect(dlgA.getByTestId('exchange-applied')).toBeVisible({ timeout: 30_000 });
  await dlgA.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(await registerOf(a)).toContainText('Weld spatter');
  const status = await invoke(a.win, 'team:status', { projectId: TEAM_PROJECT_ID });
  expect(status).toMatchObject({ ok: true, status: { quarantined: 0, conflicts: 0 } });
});

test('an encrypted exchange file asks for its passphrase before the preview', async ({
  twoReviewers,
}) => {
  test.setTimeout(180_000);
  const { a, b, out } = twoReviewers;
  await openTeamProject(a.win);
  await shareWithExchangeFiles(a.win);
  await setTitle(a.win, 'F02', 'Paint loss');
  const file = await exportPatch(a, out, 'site visit 7 October');

  await openTeamProject(b.win);
  const dlg = await openImport(b, file);
  await dlg.getByTestId('exchange-pass').fill('site visit 7 October');
  await dlg.getByTestId('exchange-unlock').click();
  await expect(dlg.getByTestId('exchange-from')).toHaveText('Rana Example (RE)', {
    timeout: 30_000,
  });
  await dlg.getByTestId('exchange-apply').click();
  await expect(dlg.getByTestId('exchange-applied')).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(await registerOf(b)).toContainText('Paint loss');
});
