/**
 * M9 T3 review workflow, two reviewers on their own copies of one team project (synthetic,
 * fictional people), synced through a hub folder. Real identities and device keys (T2): Rana
 * shares and adds Omar from his identity card as a reviewer. Rana assigns F03 to Omar with a due
 * date and a comment that mentions him with a saved view; after a sync Omar's My work lists it and
 * flies to the view; Rana cannot approve F05, which she made; Omar's approval completes it on both
 * copies; the house report prints the sign-off block; Rana's severity edit voids the approval and
 * F05 is back to reviewed, on both copies after the next sync.
 */
import type { CollabState, Issue } from '@aio/schema';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, TEAM_PROJECT_ID, twoReviewersTest as test } from './fixtures';
import { pdfText } from './pdf';
import { answerSaveDialog, bothOnHub, invoke, syncNow } from './team';

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: Issue[];
        lastCamera: { target: { kind: string; p?: number[] } } | null;
        select(s: { kind: string; id: string } | null): void;
      };
    };
  };
}

/** F03 made by Omar and F05 made by Rana, both reviewed: the same file in both copies. */
async function writeReviewIssues(project: string): Promise<void> {
  const issue = (code: string, author: string, x: number): Issue => ({
    id: `i_${code.toLowerCase()}`,
    code,
    classId: 'crack',
    severityModelId: 'sev',
    severity: 2,
    status: 'reviewed',
    title: `Crack ${code}`,
    note: '',
    author,
    createdAt: '2026-10-07T08:00:00.000Z',
    updatedAt: '2026-10-07T08:00:00.000Z',
    source: 'human',
    sightings: [
      { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [x, 0, -0.5], n: [0, 1, 0] } },
    ],
  });
  await writeFile(
    join(project, 'issues.json'),
    JSON.stringify({
      schema: 'aio.issues/1',
      issues: [issue('F03', 'Omar Sample', 0.3), issue('F05', 'Rana Example', 0.7)],
    }),
  );
}

const ws = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Inspect).__stratlas.workspace.getState();
    return {
      issues: s.issues.map((i) => ({ code: i.code, status: i.status, severity: i.severity })),
      camera: s.lastCamera?.target ?? null,
    };
  });

const statusOf = async (win: Page, code: string) =>
  (await ws(win)).issues.find((i) => i.code === code)?.status;

/** Open the issue's card on the 3D screen with its edit form and review panel. */
async function openIssue(win: Page, id: string) {
  await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
  await win.evaluate((issue) => {
    (window as unknown as Inspect).__stratlas.workspace
      .getState()
      .select({ kind: 'issue', id: issue });
  }, id);
  const card = win.getByTestId('issue-card');
  await expect(card).toBeVisible();
  const edit = card.locator('details.ic-edit');
  if (!(await edit.evaluate((d) => (d as HTMLDetailsElement).open)))
    await edit.locator('summary').click();
  const panel = card.getByTestId('issue-collab');
  await expect(panel).toBeVisible();
  return panel;
}

const read = async (win: Page): Promise<CollabState> => {
  const r = await invoke(win, 'collab:read', { projectId: TEAM_PROJECT_ID });
  if (!r.ok) throw new Error(r.error);
  return r.state;
};

const issuesOnDisk = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8')) as { issues: Issue[] }).issues;

test('two reviewers: assign, mention with a view, four-eyes approval, sign-off, voided by an edit', async ({
  twoReviewers,
}) => {
  test.setTimeout(300_000);
  const { a: rana, b: omar, out } = twoReviewers;
  await writeReviewIssues(rana.project);
  await writeReviewIssues(omar.project);
  await bothOnHub(twoReviewers);
  const omarActor = (await invoke(omar.win, 'identity:get', {})) as { identity: { actor: string } };

  // ---- Rana: assign F03 to Omar with a due date, comment with a mention and the view
  const f03 = await openIssue(rana.win, 'i_f03');
  await f03.getByRole('button', { name: 'Assign', exact: true }).click();
  await f03.getByLabel('Person').selectOption({ label: 'Omar Sample (OS)' });
  await f03.getByLabel('Due date').fill('2026-10-09');
  await f03.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(f03.getByTestId('assignee')).toHaveText('Assigned to Omar Sample');
  await expect(f03.getByText('Due Fri 9 Oct')).toBeVisible();

  const box = f03.getByLabel('Write a comment');
  await box.fill('@Om');
  await f03.getByRole('button', { name: /Omar Sample/ }).click();
  await box.pressSequentially('please check the weld');
  await f03.getByLabel('Attach view').check();
  await f03.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(f03.getByTestId('comment')).toHaveCount(1);
  await expect(f03.getByTestId('comment')).toContainText('@Omar please check the weld');
  await expect(f03.getByTestId('comment-view')).toBeVisible();
  await expectAccessible(rana.win, 'Review panel', { include: '[data-testid="issue-collab"]' });

  // four-eyes: Rana made F05, so she cannot approve it
  const f05r = await openIssue(rana.win, 'i_f05');
  await f05r.getByRole('tab', { name: 'Approvals' }).click();
  await f05r.getByTestId('approve').click();
  await expect(f05r.getByRole('alert')).toHaveText(
    'Another reviewer must approve this. You made it or last changed it.',
  );
  const state = await read(rana.win);
  expect(state.approvals).toEqual([]);
  expect(state.comments[0]?.mentions).toEqual([omarActor.identity.actor]);
  expect(state.comments[0]?.view?.camera.target).toHaveLength(3);

  expect(await syncNow(rana.win)).toMatch(/Synced: \d+ received, [1-9]\d* sent/);
  expect(await syncNow(omar.win)).toMatch(/Synced: [1-9]\d* received/);

  // ---- Omar: My work lists F03; the mention flies to Rana's view; he approves F05
  await expect.poll(async () => (await read(omar.win)).comments.length).toBe(1);
  const saved = (await read(omar.win)).comments[0]?.view?.camera.target ?? [];
  await omar.win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
  await expect(omar.win.getByTestId('my-work-button')).toHaveText('My work (2)');
  await omar.win.getByTestId('mine-filter').click();
  await expect(omar.win.locator('.ann-row')).toHaveCount(1);
  await omar.win.getByTestId('mine-filter').click();
  await omar.win.getByTestId('my-work-button').click();
  const work = omar.win.getByTestId('my-work');
  await expect(work).toContainText('Assigned to me (1)');
  await expect(work).toContainText('Mentions (1)');
  await expect(work).toContainText('Awaiting my approval (1)');
  await expectAccessible(omar.win, 'My work', { include: '[data-testid="my-work"]' });
  await work.locator('section', { hasText: 'Mentions' }).getByRole('button').first().click();
  await expect
    .poll(async () => {
      const c = (await ws(omar.win)).camera;
      const p = c?.kind === 'point' ? (c.p ?? []) : [];
      return p.length === 3 && p.every((v, i) => Math.abs(v - (saved[i] ?? NaN)) < 1e-6);
    })
    .toBe(true);

  const f05 = await openIssue(omar.win, 'i_f05');
  await f05.getByRole('tab', { name: 'Approvals' }).click();
  await f05.getByTestId('approve').click();
  await expect(f05.getByTestId('approval-message')).toHaveText(
    'Approved. The status is now Approved.',
  );
  await expect(f05.getByTestId('approval-state')).toHaveText('Approved');
  await expectAccessible(omar.win, 'Approvals', { include: '[data-testid="approval-bar"]' });
  await expect
    .poll(async () => (await issuesOnDisk(omar.project)).find((i) => i.code === 'F05')?.status)
    .toBe('approved');

  // the approval reaches Rana's copy, where it counts (Omar is a member)
  expect(await syncNow(omar.win)).toMatch(/Synced: \d+ received, [1-9]\d* sent/);
  expect(await syncNow(rana.win)).toMatch(/Synced: [1-9]\d* received/);
  await expect.poll(() => statusOf(rana.win, 'F05')).toBe('approved');
  await expect
    .poll(async () => (await issuesOnDisk(rana.project)).find((i) => i.code === 'F05')?.status)
    .toBe('approved');
  expect(await invoke(rana.win, 'team:status', { projectId: TEAM_PROJECT_ID })).toMatchObject({
    ok: true,
    status: { quarantined: 0 },
  });

  // the house report prints the sign-off block
  await answerSaveDialog(omar.app, out);
  await omar.win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
  await expect(omar.win.getByTestId('report-signoff')).toContainText('Omar Sample (OS)');
  await omar.win.getByRole('button', { name: 'Export project report PDF' }).click();
  const toast = omar.win.getByTestId('export-toast-message').last();
  await expect(toast).toContainText('saved to', { timeout: 120_000 });
  const pdfName = (await toast.textContent())
    ?.match(/saved to (.+\.pdf)/)?.[1]
    ?.split(/[\\/]/)
    .pop();
  const pdf = await pdfText(
    join(out, pdfName ?? ''),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  // the report spaces out its capitals: compare without spaces, lower case
  const text = [...pdf.text.values()].join(' ').replace(/\s+/g, '').toLowerCase();
  expect(text).toContain('sign-offandapprovals');
  expect(text).toMatch(/preparedbyomarsample\(os\),\d{4}-\d{2}-\d{2}/);
  expect(text).toContain('reviewedbyomarsample(os)');
  expect(text).toContain('1of2findingsapproved');
  expect(text).toContain('approvedbynotyet');

  // ---- Rana: a severity edit voids Omar's approval; F05 is back to reviewed on both copies
  const f05e = await openIssue(rana.win, 'i_f05');
  await rana.win
    .getByTestId('issue-card')
    .getByRole('group', { name: 'Severity' })
    .getByRole('button', { name: '3' })
    .click();
  await expect.poll(() => statusOf(rana.win, 'F05')).toBe('reviewed');
  await f05e.getByRole('tab', { name: 'Approvals' }).click();
  await expect(f05e.getByTestId('approval-state')).toHaveText('Approval out of date');
  await expect
    .poll(async () => (await issuesOnDisk(rana.project)).find((i) => i.code === 'F05'))
    .toMatchObject({ status: 'reviewed', severity: 3 });
  const approvals = (await read(rana.win)).approvals;
  expect(approvals.map((x) => [x.by, x.current])).toEqual([[omarActor.identity.actor, false]]);

  expect(await syncNow(rana.win)).toMatch(/Synced: \d+ received, [1-9]\d* sent/);
  expect(await syncNow(omar.win)).toMatch(/Synced: [1-9]\d* received/);
  await expect.poll(() => statusOf(omar.win, 'F05')).toBe('reviewed');
  await expect
    .poll(async () => (await issuesOnDisk(omar.project)).find((i) => i.code === 'F05'))
    .toMatchObject({ status: 'reviewed', severity: 3 });
});
