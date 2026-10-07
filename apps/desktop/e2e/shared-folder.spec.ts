/**
 * Projects opened in place on a share (compare-before-write): two people open the same project
 * folder, not shared as a team project, from two computers (two app instances with their own
 * userData, off-screen like every launch). Rana saves first; Omar, who opened before her save,
 * is refused with Reload instead of overwriting her, reloads, sees her change, edits again, and
 * the file on disk ends with both edits. No network.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDataRoot,
  expect,
  launchApp,
  NetworkGuard,
  test as base,
  writeTeamProject,
  type DataRoot,
  type Reviewer,
} from './fixtures';
import { editIssue, openTeamProject, registerOf, setSeverity, setTitle } from './team';

/** One person: their own app and userData; `project` is the shared folder. */
type Person = Pick<Reviewer, 'name' | 'app' | 'win' | 'dataRoot' | 'project'>;

interface SharedFolder {
  a: Person;
  b: Person;
  /** The one project folder both have open. */
  project: string;
}

const test = base.extend<{ shared: SharedFolder }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  shared: async ({}, use, testInfo) => {
    // one data root holds the project (the share); each person has their own userData
    const data = await createDataRoot();
    const project = await writeTeamProject(data.root);
    const launch = async (name: string, initials: string, actor: string): Promise<Person> => {
      const userData = join(data.base, `user-${initials.toLowerCase()}`);
      await mkdir(userData, { recursive: true });
      await writeFile(
        join(userData, 'identity.json'),
        JSON.stringify({
          schema: 'aio.identity/1',
          actor,
          name,
          initials,
          createdAt: '2026-10-07T08:00:00.000Z',
        }),
      );
      const root: DataRoot = { ...data, userData };
      const app = await launchApp(root);
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      return { name, app, win, dataRoot: root, project };
    };
    const a = await launch('Rana Example', 'RE', 'a_ranaexampleaaaaaaaaaaaaaaa');
    const b = await launch('Omar Sample', 'OS', 'a_omarsampleaaaaaaaaaaaaaaaa');
    const guards = [new NetworkGuard(), new NetworkGuard()] as const;
    await guards[0].attach(a.app);
    await guards[1].attach(b.app);
    const outbound: string[] = [];
    try {
      await use({ a, b, project });
      for (const g of guards) outbound.push(...(await g.outbound()));
    } finally {
      for (const p of [a, b]) {
        if (testInfo.status !== testInfo.expectedStatus) {
          await p.win
            .screenshot({ path: testInfo.outputPath(`${p.name.split(' ')[0] ?? 'app'}.png`) })
            .catch(() => undefined);
        }
        await p.app.close().catch(() => undefined);
      }
      await rm(data.base, { recursive: true, force: true }).catch(() => undefined);
    }
    expect(outbound, 'the apps made network requests').toEqual([]);
  },
});

interface IssueOnDisk {
  code: string;
  title: string;
  severity: number;
}

async function onDisk(project: string): Promise<IssueOnDisk[]> {
  const text = await readFile(join(project, 'issues.json'), 'utf8');
  return (JSON.parse(text) as { issues: IssueOnDisk[] }).issues;
}

test('a save over a newer file on the share is refused with Reload, then both edits are kept', async ({
  shared,
}) => {
  test.setTimeout(120_000);
  const { a, b, project } = shared;
  // both open the same folder before anyone saves
  await openTeamProject(a.win);
  await openTeamProject(b.win);
  await expect(await registerOf(b)).toContainText('Crack F01');

  // Rana saves first
  await setTitle(a.win, 'F01', 'Corroded bolt');
  expect((await onDisk(project)).find((i) => i.code === 'F01')?.title).toBe('Corroded bolt');

  // Omar edits another issue over the version he opened: refused, nothing replaced
  const card = await editIssue(b.win, 'F02');
  await card
    .getByRole('group', { name: 'Severity', exact: true })
    .getByRole('button', { name: '3', exact: true })
    .click();
  const notice = b.win.getByTestId('disk-changed');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText(
    'issues.json was changed by someone else since you opened it. Reload to see their changes; your edit was not saved.',
  );
  await expect(b.win.locator('.ann-save').first()).toHaveAttribute('data-state', 'error');
  const afterRefusal = await onDisk(project);
  expect(afterRefusal.find((i) => i.code === 'F01')?.title).toBe('Corroded bolt');
  expect(afterRefusal.find((i) => i.code === 'F02')?.severity).toBe(2);

  // Reload: Rana's change shows, Omar's refused edit is gone
  await notice.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(notice).toHaveCount(0);
  const register = await registerOf(b);
  await expect(register).toContainText('Corroded bolt');
  await expect(b.win.locator('.ann-save').first()).toHaveAttribute('data-state', 'saved');

  // he makes his edit again, and this time it is saved next to hers
  await setSeverity(b.win, 'F02', 3);
  await expect(b.win.getByTestId('disk-changed')).toHaveCount(0);
  const final = await onDisk(project);
  expect(final.find((i) => i.code === 'F01')?.title).toBe('Corroded bolt');
  expect(final.find((i) => i.code === 'F02')?.severity).toBe(3);
});
