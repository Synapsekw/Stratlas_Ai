/** Steps shared by the M9 sharing specs (hub folder and exchange files), done through the UI. */
import type { IpcChannel, IpcRequest, IpcResponse } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expect,
  TEAM_PROJECT_ID,
  TEAM_PROJECT_NAME,
  type Reviewer,
  type TwoReviewers,
} from './fixtures';

export async function openTeamProject(win: Page): Promise<void> {
  const card = win.getByTestId('project-card').filter({ hasText: TEAM_PROJECT_NAME });
  if (
    !(await card
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  }
  await card.first().click();
  await expect(win.getByTestId('sync-chip')).toBeVisible({ timeout: 30_000 });
}

/** Share the open project: through a shared folder (auto-sync off, so each sync is a click). */
export async function shareThroughHub(win: Page, hub: string): Promise<void> {
  await win.getByTestId('sync-chip').click();
  const dlg = win.getByTestId('team-share');
  await dlg.getByTestId('share-mode-hub').check();
  await dlg.getByTestId('share-hub-path').fill(hub);
  const auto = dlg.getByRole('switch');
  if ((await auto.getAttribute('aria-checked')) === 'true') await auto.click();
  await dlg.getByTestId('share-go').click();
  await expect(win.getByTestId('sync-chip')).toHaveAttribute('data-mode', 'hub', {
    timeout: 30_000,
  });
  await win
    .getByTestId('team-status')
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click();
  await expect(win.getByTestId('team-status')).toHaveCount(0);
}

export async function shareWithExchangeFiles(win: Page): Promise<void> {
  await win.getByTestId('sync-chip').click();
  const dlg = win.getByTestId('team-share');
  await dlg.getByTestId('share-mode-exchange').check();
  await dlg.getByTestId('share-go').click();
  await expect(win.getByTestId('sync-chip')).toHaveAttribute('data-mode', 'exchange', {
    timeout: 30_000,
  });
  await closeTeamDialog(win);
}

export async function closeTeamDialog(win: Page): Promise<void> {
  const dlg = win.getByTestId('team-status');
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dlg).toHaveCount(0);
}

/** Select an issue in the register and open its editor on the issue card. */
export async function editIssue(win: Page, code: string): Promise<ReturnType<Page['getByTestId']>> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  await win
    .getByTestId('issue-register')
    .getByRole('option', { name: new RegExp(code) })
    .click();
  const card = win.getByTestId('issue-card').first();
  const details = card.locator('details', {
    has: win.locator('summary', { hasText: 'Edit issue' }),
  });
  if ((await details.getAttribute('open')) === null) {
    await card.locator('summary', { hasText: 'Edit issue' }).click();
  }
  return card;
}

/** Wait until the issue editor has written issues.json. */
async function saved(win: Page): Promise<void> {
  await expect(win.locator('.ann-save').first()).toHaveAttribute('data-state', 'saved', {
    timeout: 15_000,
  });
}

export async function setTitle(win: Page, code: string, title: string): Promise<void> {
  const card = await editIssue(win, code);
  const input = card.getByLabel('Title', { exact: true });
  await input.fill(title);
  await input.press('Enter');
  await expect(win.getByTestId('issue-register')).toContainText(title);
  await saved(win);
}

export async function setSeverity(win: Page, code: string, severity: number): Promise<void> {
  const card = await editIssue(win, code);
  const button = card
    .getByRole('group', { name: 'Severity', exact: true })
    .getByRole('button', { name: String(severity), exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await saved(win);
}

/** Open the Team dialog, Sync now, and wait for the result. Returns the note or the error. */
export async function syncNow(win: Page): Promise<string> {
  await win.getByTestId('sync-chip').click();
  const dlg = win.getByTestId('team-status');
  await dlg.getByTestId('sync-now').click();
  const result = dlg.getByTestId('sync-note').or(dlg.getByTestId('sync-error'));
  await expect(result).toBeVisible({ timeout: 30_000 });
  const text = (await result.textContent()) ?? '';
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dlg).toHaveCount(0);
  return text;
}

/** Answer the next save dialog with `<dir>/<default name>`. */
export async function answerSaveDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, folder) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'changes.aiosync';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
    },
    dir.replace(/\\/g, '/'),
  );
}

/** Answer the next open dialog with `file`. */
export async function answerOpenDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
  }, file);
}

/** Call a main IPC channel from the window, as the renderer does (no dialog in between). */
export async function invoke<C extends IpcChannel>(
  win: Page,
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  return await win.evaluate(([c, r]) => window.aio.invoke(c, r as never), [
    channel,
    request,
  ] as const);
}

/** Export this person's identity card (`.aioid`) into `dir` and return its text. */
export async function identityCard(r: Reviewer, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await answerSaveDialog(r.app, dir);
  const res = await invoke(r.win, 'identity:exportCard', {});
  if (!res.ok || !res.path) throw new Error(`No identity card: ${JSON.stringify(res)}`);
  return readFile(res.path, 'utf8');
}

/**
 * The owner adds `person` to the open, shared team project from their identity card, certified
 * by the owner's device (T2 `members:add`). Without it, the person's changes are quarantined on
 * the owner's copy.
 */
export async function addMember(
  owner: Reviewer,
  person: Reviewer,
  dir: string,
  role: 'owner' | 'reviewer' | 'viewer' | 'client' = 'reviewer',
): Promise<void> {
  const card = await identityCard(person, dir);
  const res = await invoke(owner.win, 'members:add', {
    projectId: TEAM_PROJECT_ID,
    card,
    role,
    certify: true,
  });
  expect(res, 'members:add').toMatchObject({ ok: true, member: { name: person.name, role } });
}

/**
 * Rana shares through the hub and adds Omar as a reviewer; her sync carries the team to the hub;
 * Omar's copy gets the team file (as with his copy of the folder), joins and pulls the team.
 */
export async function bothOnHub({ a, b, hub, out }: TwoReviewers): Promise<void> {
  await openTeamProject(a.win);
  await shareThroughHub(a.win, hub);
  await addMember(a, b, out);
  expect(await syncNow(a.win)).toMatch(/Synced/);
  await copyFile(join(a.project, 'team.json'), join(b.project, 'team.json'));
  await openTeamProject(b.win);
  await shareThroughHub(b.win, hub);
  const members = await invoke(b.win, 'members:list', { projectId: TEAM_PROJECT_ID });
  expect(members, 'Omar sees himself as a reviewer').toMatchObject({ ok: true, me: 'reviewer' });
}

/** The issue register of a reviewer, on the Issues screen. */
export async function registerOf(r: Reviewer): Promise<ReturnType<Page['getByTestId']>> {
  await r.win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  return r.win.getByTestId('issue-register');
}
