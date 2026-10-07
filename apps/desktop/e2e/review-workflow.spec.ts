/**
 * M9 T3 review workflow, two reviewers on one shared project folder (synthetic, fictional people):
 * Rana (owner) assigns F03 to Omar with a due date and a comment that mentions him with a saved
 * view; Omar's My work lists it and flies to the view; Rana cannot approve F05, which she made;
 * Omar's approval completes it; the house report prints the sign-off block; Rana's severity edit
 * voids the approval and F05 is back to reviewed.
 *
 * Two Electron instances with their own userData (windows off-screen). Until T2 and T5 land:
 * identities are `identity.json` files the T3 stub reads, `identity:get` and `members:list` are
 * answered in main by this spec (T2's channels are stubs), and the folder itself is shared (T5's
 * `twoReviewers` hub fixture replaces it).
 */
import type { CollabState, Issue, ProjectManifestInput } from '@aio/schema';
import { ProjectManifest, SCHEMA_VERSION } from '@aio/schema';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, launchApp, NetworkGuard, test, tinyGlb, type DataRoot } from './fixtures';
import { pdfText } from './pdf';

type Who = 'rana' | 'omar';
type Key = Who | 'lina';

/** tools/demo/team.mjs: the fictional team and its journal (plain JavaScript, typed here). */
interface TeamDemo {
  PEOPLE: Record<
    Key,
    {
      name: string;
      initials: string;
      email: string;
      role: 'owner' | 'reviewer';
      actor: string;
      device: string;
    }
  >;
  identityOf: (key: Key) => Record<string, string>;
  writeIdentity: (userDataDir: string, key: Key) => Promise<void>;
  writeTeamJournal: (dir: string, opts: { scenario: 'demo' | 'shared' }) => Promise<unknown>;
}
const team = (await import(
  pathToFileURL(join(import.meta.dirname, '..', '..', '..', 'tools', 'demo', 'team.mjs')).href
)) as TeamDemo;
const { PEOPLE, identityOf, writeIdentity, writeTeamJournal } = team;
const PROJECT = 'e2e-team';

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: Issue[];
        selection: { kind: string; id: string } | null;
        lastCamera: { target: { kind: string; p?: number[] } } | null;
        select(s: { kind: string; id: string } | null): void;
      };
    };
  };
}

async function writeTeamProject(data: DataRoot): Promise<string> {
  const dir = join(data.root, 'projects', PROJECT);
  await mkdir(join(dir, 'models'), { recursive: true });
  const manifest: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: PROJECT,
    name: 'E2E team project',
    customer: 'E2E (fictional)',
    site: 'Synthetic site',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: [{ id: 'c1', label: 'Synthetic capture', date: '2026-10-01' }],
    layers: [
      {
        kind: 'mesh',
        id: 'quad',
        name: 'Unit quad',
        src: { path: 'models/quad.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
    severityModels: [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
          { value: 2, label: 'Moderate', color: '#f08a3c', criteria: 'Plan' },
          { value: 3, label: 'Severe', color: '#ee3f4b', criteria: 'Act' },
        ],
      },
    ],
    classCatalogues: [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'tank',
        classes: [{ id: 'weld', label: 'Weld defect', color: '#ee3f4b', severityModel: 'sev' }],
      },
    ],
  };
  const issue = (code: string, author: string, x: number): Issue => ({
    id: `i_${code.toLowerCase()}`,
    code,
    classId: 'weld',
    severityModelId: 'sev',
    severity: 2,
    status: 'reviewed',
    title: `Weld ${code}`,
    note: '',
    author,
    createdAt: '2026-10-07T08:00:00.000Z',
    updatedAt: '2026-10-07T08:00:00.000Z',
    source: 'human',
    sightings: [
      { on: 'mesh', layer: 'quad', geom: { type: 'spoint', p: [x, 0, -0.5], n: [0, 1, 0] } },
    ],
  });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({
      schema: 'aio.issues/1',
      issues: [issue('F03', 'Omar Sample', 0.3), issue('F05', 'Rana Example', 0.7)],
    }),
  );
  await writeTeamJournal(dir, { scenario: 'shared' });
  return dir;
}

/** T2 stand-in: this person and the members, answered in main (T2's channels are stubs). */
async function stubIdentity(app: ElectronApplication, who: Who): Promise<void> {
  const member = (key: Key) => {
    const p = PEOPLE[key];
    return {
      actor: p.actor,
      name: p.name,
      initials: p.initials,
      email: p.email,
      role: p.role,
      devices: [{ id: p.device, key: 'A'.repeat(43), revoked: false }],
      verification: 'self',
      addedBy: PEOPLE.rana.actor,
      addedAt: `1791360000000.0000.${PEOPLE.rana.device}`,
    };
  };
  await app.evaluate(
    ({ ipcMain }, d) => {
      ipcMain.removeHandler('identity:get');
      ipcMain.handle('identity:get', () => ({
        ok: true,
        identity: d.identity,
        device: null,
        unsigned: true,
      }));
      ipcMain.removeHandler('members:list');
      ipcMain.handle('members:list', () => ({ ok: true, members: d.members, me: d.role }));
    },
    {
      identity: identityOf(who),
      members: [member('rana'), member('omar'), member('lina')],
      role: PEOPLE[who].role,
    },
  );
}

async function launchAs(data: DataRoot, who: Who, network: NetworkGuard) {
  const userData = join(data.base, `user-${who}`);
  await writeIdentity(userData, who);
  const app = await launchApp({ ...data, userData });
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // after main registered its handlers (the window exists), before the project opens
  await stubIdentity(app, who);
  await win.getByTestId('project-card').filter({ hasText: 'E2E team project' }).click();
  await expect(win.locator('[data-scene-view=""] canvas')).toBeVisible({ timeout: 60_000 });
  return { app, win };
}

const ws = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Inspect).__stratlas.workspace.getState();
    return {
      issues: s.issues.map((i) => ({ code: i.code, status: i.status, severity: i.severity })),
      camera: s.lastCamera?.target ?? null,
    };
  });

/** Open the issue's card on the 3D screen with its edit form and review panel. */
async function openIssue(win: Page, id: string) {
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

const read = (win: Page) =>
  win.evaluate((pid) => window.aio.invoke('collab:read', { projectId: pid }), PROJECT) as Promise<{
    ok: true;
    state: CollabState;
  }>;

const issuesOnDisk = async (dir: string) =>
  (JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8')) as { issues: Issue[] }).issues;

test('two reviewers: assign, mention with a view, four-eyes approval, sign-off, voided by an edit', async ({
  dataRoot,
}) => {
  test.setTimeout(300_000);
  const dir = await writeTeamProject(dataRoot);
  const network = new NetworkGuard();

  // ---- Rana: assign F03 to Omar with a due date, comment with a mention and the view
  let rana = await launchAs(dataRoot, 'rana', network);
  try {
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

    // four-eyes: Rana made F05, so she cannot approve it
    const f05 = await openIssue(rana.win, 'i_f05');
    await f05.getByRole('tab', { name: 'Approvals' }).click();
    await f05.getByTestId('approve').click();
    await expect(f05.getByRole('alert')).toHaveText(
      'Another reviewer must approve this. You made it or last changed it.',
    );
    const state = (await read(rana.win)).state;
    expect(state.approvals).toEqual([]);
    expect(state.comments[0]?.mentions).toEqual([PEOPLE.omar.actor]);
    expect(state.comments[0]?.view?.camera.target).toHaveLength(3);
  } finally {
    await rana.app.close();
  }

  // ---- Omar: My work lists F03; the mention flies to Rana's view; he approves F05
  const omar = await launchAs(dataRoot, 'omar', network);
  try {
    const saved = (await read(omar.win)).state.comments[0]?.view?.camera.target ?? [];
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
    await work.locator('section', { hasText: 'Mentions' }).getByRole('button').first().click();
    await expect
      .poll(async () => {
        const c = (await ws(omar.win)).camera;
        const p = c?.kind === 'point' ? (c.p ?? []) : [];
        return p.length === 3 && p.every((v, i) => Math.abs(v - (saved[i] ?? NaN)) < 1e-6);
      })
      .toBe(true);

    await omar.win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
    const f05 = await openIssue(omar.win, 'i_f05');
    await f05.getByRole('tab', { name: 'Approvals' }).click();
    await f05.getByTestId('approve').click();
    await expect(f05.getByTestId('approval-message')).toHaveText(
      'Approved. The status is now Approved.',
    );
    await expect(f05.getByTestId('approval-state')).toHaveText('Approved');
    await expect
      .poll(async () => (await issuesOnDisk(dir)).find((i) => i.code === 'F05')?.status)
      .toBe('approved');

    // the house report prints the sign-off block
    const out = join(dataRoot.base, 'out');
    await mkdir(out, { recursive: true });
    await omar.app.evaluate(
      ({ dialog }, folder) => {
        dialog.showSaveDialog = (...args: unknown[]) => {
          const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
          const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'report.pdf';
          return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
        };
      },
      out.replace(/\\/g, '/'),
    );
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
  } finally {
    await omar.app.close();
  }

  // ---- Rana: a severity edit voids Omar's approval; F05 is back to reviewed
  rana = await launchAs(dataRoot, 'rana', network);
  try {
    expect((await ws(rana.win)).issues.find((i) => i.code === 'F05')?.status).toBe('approved');
    const f05 = await openIssue(rana.win, 'i_f05');
    await rana.win
      .getByRole('group', { name: 'Severity' })
      .getByRole('button', { name: '3' })
      .click();
    await expect
      .poll(async () => (await ws(rana.win)).issues.find((i) => i.code === 'F05')?.status)
      .toBe('reviewed');
    await f05.getByRole('tab', { name: 'Approvals' }).click();
    await expect(f05.getByTestId('approval-state')).toHaveText('Approval out of date');
    await expect
      .poll(async () => (await issuesOnDisk(dir)).find((i) => i.code === 'F05'))
      .toMatchObject({ status: 'reviewed', severity: 3 });
    const approvals = (await read(rana.win)).state.approvals;
    expect(approvals.map((a) => [a.by, a.current])).toEqual([[PEOPLE.omar.actor, false]]);
    expect(await network.outbound()).toEqual([]);
  } finally {
    await rana.app.close();
  }
});
