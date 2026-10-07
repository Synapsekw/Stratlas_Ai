/**
 * Server mode (M9 T7 with T5 sync): two people sync one team project through a team server that
 * runs in this test process on 127.0.0.1 (memory store, TEST-ONLY certificate). Both enrol with
 * invite codes (Rana as owner, Omar as reviewer); Rana shares in server mode and her sync adds the
 * people the server granted, so Omar is a reviewer of the team (his card is not needed); Omar
 * joins. Rana's comment and Omar's approval travel both ways. The server
 * stops: both keep working, and Sync says it cannot be reached; a server on the same store and
 * port comes back and the waiting change goes through. The zero-network guard lets only that
 * loopback origin through.
 */
import { copyFile, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CollabState, Issue } from '@aio/schema';
import {
  closeReviewer,
  expect,
  launchReviewer,
  TEAM_PROJECT_ID,
  test as base,
  type Reviewer,
} from './fixtures';
import {
  closeTeamDialog,
  identityCard,
  invoke,
  openIssue,
  openTeamProject,
  registerOf,
  setTitle,
  syncNow,
  writeReviewIssues,
} from './team';

/** The slice of `apps/team-server/src/testkit.ts` this spec uses. */
interface TestServer {
  origin: string;
  fingerprint: string;
  store: unknown;
  invite(
    role: 'owner' | 'reviewer' | 'viewer' | 'client',
    project?: string | null,
  ): Promise<string>;
  close(): Promise<void>;
}
type Start = (o?: { store?: unknown; port?: number }) => Promise<TestServer>;

/** Load the server from its sources (not a dependency of the app, so not a static import). */
async function serverKit(): Promise<Start> {
  const kit = join(import.meta.dirname, '..', '..', 'team-server', 'src', 'testkit.ts');
  const mod = (await import(pathToFileURL(kit).href)) as { startLoopbackServer: Start };
  return mod.startLoopbackServer;
}

interface ServerTeam {
  a: Reviewer;
  b: Reviewer;
  server: { current: TestServer; start: Start; guarded: string };
  out: string;
}

const test = base.extend<{ serverTeam: ServerTeam }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  serverTeam: async ({}, use, testInfo) => {
    const start = await serverKit();
    const first = await start();
    // the guard knows loopback origins as http; the app speaks https to the same port
    const guarded = first.origin.replace('https:', 'http:');
    const opts = { env: { AIO_NETWORK_GUARD_ALLOW: guarded }, allow: [guarded] };
    const out = await mkdtemp(join(tmpdir(), 'aio-e2e-server-'));
    const a = await launchReviewer('rana', 'Rana Example', 'RE', opts);
    const b = await launchReviewer('omar', 'Omar Sample', 'OS', opts);
    const server = { current: first, start, guarded };
    const outbound: string[] = [];
    const allowed: string[] = [];
    try {
      await use({ a, b, server, out });
      for (const r of [a, b]) {
        outbound.push(...(await r.network.outbound()));
        allowed.push(...(await r.network.allowed()));
      }
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus;
      for (const r of [a, b]) {
        await closeReviewer(r, failed, testInfo.outputPath(`${r.name.split(' ')[0] ?? 'app'}.png`));
      }
      await server.current.close().catch(() => undefined);
      await rm(out, { recursive: true, force: true }).catch(() => undefined);
    }
    expect(outbound, 'the apps made network requests').toEqual([]);
    expect(allowed.length).toBeGreaterThan(0);
    expect(
      allowed.every((u) => u.startsWith(guarded)),
      'only the team server was reached',
    ).toBe(true);
  },
});

/** Enrol this person's device with an invite code, after the fingerprint check. */
async function enrol(r: Reviewer, server: TestServer, role: 'owner' | 'reviewer'): Promise<string> {
  const code = await server.invite(role);
  const first = await invoke(r.win, 'server:enrol', { url: server.origin, code });
  expect(first).toMatchObject({ ok: false, fingerprint: server.fingerprint });
  const done = await invoke(r.win, 'server:enrol', {
    url: server.origin,
    code,
    fingerprint: server.fingerprint,
  });
  if (!done.ok) throw new Error(done.error);
  expect(done.server).toMatchObject({ name: 'Test team server', role });
  return done.server.id;
}

/** Share the open project in server mode through the Share dialog (or join it). */
async function shareOnServer(r: Reviewer): Promise<void> {
  await r.win.getByTestId('sync-chip').click();
  const dlg = r.win.getByTestId('team-share');
  await dlg.getByTestId('share-mode-server').check();
  await expect(dlg.getByTestId('share-server')).toContainText('Test team server');
  await dlg.getByTestId('share-go').click();
  await expect(r.win.getByTestId('sync-chip')).toHaveAttribute('data-mode', 'server', {
    timeout: 30_000,
  });
  await closeTeamDialog(r.win);
}

const collab = async (r: Reviewer): Promise<CollabState> => {
  const c = await invoke(r.win, 'collab:read', { projectId: TEAM_PROJECT_ID });
  if (!c.ok) throw new Error(c.error);
  return c.state;
};

const onDisk = async (r: Reviewer, code: string) =>
  (
    JSON.parse(await readFile(join(r.project, 'issues.json'), 'utf8')) as { issues: Issue[] }
  ).issues.find((i) => i.code === code);

test('two people sync through a team server, keep working while it is down, and sync after', async ({
  serverTeam,
}) => {
  test.setTimeout(300_000);
  const { a, b, server, out } = serverTeam;
  await writeReviewIssues(a.project);
  await writeReviewIssues(b.project);
  await enrol(a, server.current, 'owner');
  await enrol(b, server.current, 'reviewer');

  // Rana shares on the server; her sync adds the people the server granted (Omar, enrolled as a
  // reviewer) to the team; Omar joins with the team file of his copy
  await openTeamProject(a.win);
  await shareOnServer(a);
  const team = await invoke(a.win, 'members:list', { projectId: TEAM_PROJECT_ID });
  if (!team.ok) throw new Error(team.error);
  expect(team.members.map((m) => [m.name, m.role])).toEqual([
    ['Rana Example', 'owner'],
    ['Omar Sample', 'reviewer'],
  ]);
  // adding him again from his card says so
  const card = await identityCard(b, join(out, 'cards'));
  expect(
    await invoke(a.win, 'members:add', {
      projectId: TEAM_PROJECT_ID,
      card,
      role: 'reviewer',
      certify: true,
    }),
  ).toMatchObject({ ok: false, error: /already a member/ });
  expect(await syncNow(a.win)).toMatch(/Synced/);
  await copyFile(join(a.project, 'team.json'), join(b.project, 'team.json'));
  await openTeamProject(b.win);
  await shareOnServer(b);
  expect(await invoke(b.win, 'members:list', { projectId: TEAM_PROJECT_ID })).toMatchObject({
    ok: true,
    me: 'reviewer',
  });

  // Rana comments on F05; Omar sees it after a sync and approves F05 (Rana made it)
  const f05 = await openIssue(a.win, 'i_f05');
  await f05.getByLabel('Write a comment').fill('Please approve the weld crack');
  await f05.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(f05.getByTestId('comment')).toHaveCount(1);
  expect(await syncNow(a.win)).toMatch(/Synced: \d+ received, [1-9]\d* sent/);
  expect(await syncNow(b.win)).toMatch(/Synced: [1-9]\d* received/);
  await expect
    .poll(async () => (await collab(b)).comments.map((c) => c.text))
    .toEqual(['Please approve the weld crack']);
  const f05b = await openIssue(b.win, 'i_f05');
  await expect(f05b.getByTestId('comment')).toContainText('Please approve the weld crack');
  await f05b.getByRole('tab', { name: 'Approvals' }).click();
  await f05b.getByTestId('approve').click();
  await expect(f05b.getByTestId('approval-state')).toHaveText('Approved');
  expect(await syncNow(b.win)).toMatch(/Synced: \d+ received, [1-9]\d* sent/);
  expect(await syncNow(a.win)).toMatch(/Synced: [1-9]\d* received/);
  await expect.poll(async () => (await onDisk(a, 'F05'))?.status).toBe('approved');
  const omar = (await collab(a)).approvals.map((x) => [x.decision, x.current]);
  expect(omar).toEqual([['approve', true]]);

  // the server goes away: Rana keeps working; Sync says it cannot be reached
  await server.current.close();
  await setTitle(a.win, 'F03', 'Crack beside the nozzle');
  await expect(await registerOf(a)).toContainText('Crack beside the nozzle');
  expect(await syncNow(a.win)).toMatch(/team server cannot be reached/);
  await expect(a.win.getByTestId('sync-chip')).toHaveAttribute('data-state', 'offline');
  await expect(a.win.getByTestId('sync-pending')).toBeVisible();

  // a server on the same store and port: the waiting change goes through
  const port = Number(new URL(server.current.origin).port);
  server.current = await server.start({ store: server.current.store, port });
  expect(await syncNow(a.win)).toMatch(/Synced: \d+ received, [1-9]\d* sent/);
  await expect(a.win.getByTestId('sync-chip')).toHaveAttribute('data-state', 'ok');
  expect(await syncNow(b.win)).toMatch(/Synced: [1-9]\d* received/);
  await expect.poll(async () => (await onDisk(b, 'F03'))?.title).toBe('Crack beside the nozzle');
});
