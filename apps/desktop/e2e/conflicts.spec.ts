/**
 * M9 conflicts and quarantine between two reviewers on a hub folder (T4 merge, T2 team replay):
 * Rana (owner) shares and adds Omar from his identity card as a reviewer. Each test works apart,
 * then syncs:
 * (a) both change F02's severity (a field conflict on both copies; Omar's title merges cleanly);
 *     Rana keeps hers and after the next syncs both copies agree and the conflict is gone;
 * (b) both make a new issue: one keeps F03, the other is renumbered F04 (inbox entry, notice and
 *     the history label);
 * (c) Rana deletes F03 (made in the app, synced) while Omar edits it: it stays on both, with a
 *     delete-vs-edit conflict;
 * (d) Omar changes the coordinate system (a reviewer may not; no screen offers it, so his copy's
 *     manifest.json is edited and the journal records a `manifest.entry` with `crs` at his
 *     sync): quarantined on Rana's copy with the role message; Rana applies it anyway and the op
 *     counts in her history (the merge does not write manifest entries into manifest.json yet).
 * Windows off-screen; no network.
 */
import type { Issue } from '@aio/schema';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, TEAM_PROJECT_ID, twoReviewersTest as test, type Reviewer } from './fixtures';
import {
  bothOnHub,
  closeTeamDialog,
  editIssue,
  invoke,
  registerOf,
  setSeverity,
  setTitle,
  syncNow,
} from './team';

interface Inspect {
  __stratlas: {
    workspace: { getState(): { issues: Issue[]; flyTo(t: { kind: 'home' }): void } };
    stage(): {
      raycast(
        x: number,
        y: number,
      ): { object: { userData: Record<string, unknown>; parent: unknown } } | null;
    } | null;
  };
}

const onDisk = async (r: Reviewer): Promise<Issue[]> =>
  (JSON.parse(await readFile(join(r.project, 'issues.json'), 'utf8')) as { issues: Issue[] })
    .issues;

const issue = async (r: Reviewer, code: string) => (await onDisk(r)).find((i) => i.code === code);

const status = async (r: Reviewer) => {
  const s = await invoke(r.win, 'team:status', { projectId: TEAM_PROJECT_ID });
  if (!s.ok) throw new Error(s.error);
  return s.status;
};

/** Rana syncs, Omar syncs, Rana syncs again: both copies hold every op. */
async function syncAll(a: Reviewer, b: Reviewer): Promise<void> {
  for (const r of [a, b, a]) expect(await syncNow(r.win)).toMatch(/Synced/);
}

/** The Team dialog's Conflicts inbox. */
async function inbox(win: Page) {
  await win.getByTestId('sync-chip').click();
  const dlg = win.getByTestId('team-status');
  await expect(dlg).toBeVisible();
  return dlg.locator('.cf-panel');
}

/** Points on the canvas where a layer is hit (a grid of raycasts). */
async function meshHits(win: Page, layerId: string) {
  return win.evaluate((id) => {
    const st = (window as unknown as Inspect).__stratlas.stage();
    const canvas = document.querySelector('[data-scene-view] canvas');
    if (!st || !canvas) return [];
    const r = canvas.getBoundingClientRect();
    const out: { x: number; y: number }[] = [];
    for (let i = 4; i < 60; i += 2)
      for (let j = 4; j < 58; j += 2) {
        const nx = (i / 64) * 2 - 1;
        const ny = -((j / 62) * 2 - 1);
        const hit = st.raycast(nx, ny);
        if (!hit) continue;
        let o = hit.object as { userData: Record<string, unknown>; parent: unknown } | null;
        let lid: unknown = null;
        while (o && lid === null) {
          lid = o.userData.layerId ?? null;
          o = o.parent as typeof o;
        }
        if (lid === id)
          out.push({ x: r.left + ((nx + 1) / 2) * r.width, y: r.top + ((1 - ny) / 2) * r.height });
      }
    return out;
  }, layerId);
}

/** A pin on the quad in the 3D view becomes a new issue (Crack, severity 1). */
async function pinIssue(r: Reviewer): Promise<void> {
  const before = (await onDisk(r)).length;
  const win = r.win;
  await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
  const canvas = win.locator('[data-scene-view] canvas');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas.workspace.getState().flyTo({ kind: 'home' });
  });
  await expect.poll(async () => (await meshHits(win, 'quad')).length).toBeGreaterThan(0);
  await canvas.click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('a');
  await win.locator('.ann-subbar').getByRole('button', { name: 'Pin' }).click();
  const hits = await meshHits(win, 'quad');
  const pin = hits[Math.floor(hits.length / 2)];
  if (!pin) throw new Error('no point on the quad');
  await win.mouse.click(pin.x, pin.y);
  const pop = win.getByRole('dialog', { name: 'New issue' });
  await expect(pop).toBeVisible();
  await pop.getByRole('listbox', { name: 'Class' }).getByRole('button').first().click();
  await pop.getByRole('group', { name: 'Severity' }).getByRole('button').nth(1).click();
  await pop.getByRole('button', { name: 'Create issue' }).click();
  await expect.poll(async () => (await onDisk(r)).length, { timeout: 15_000 }).toBe(before + 1);
  await win.keyboard.press('Escape');
}

test('one field changed on both copies: a conflict on both, Keep mine settles it everywhere', async ({
  twoReviewers,
}) => {
  test.setTimeout(240_000);
  const { a, b } = twoReviewers;
  await bothOnHub(twoReviewers);

  // apart: Rana sets 3; Omar sets 4 and retitles (the title merges without a conflict)
  await setSeverity(a.win, 'F02', 3);
  await setSeverity(b.win, 'F02', 4);
  await setTitle(b.win, 'F02', 'Crack along the weld');
  await syncAll(a, b);

  for (const r of [a, b]) {
    await expect(r.win.getByTestId('sync-conflicts')).toHaveText('1 conflict', { timeout: 15_000 });
    await expect(await registerOf(r)).toContainText('Crack along the weld');
  }
  const omarsInbox = await inbox(b.win);
  await expect(omarsInbox.locator('.cf-item')).toHaveCount(1);
  await expect(omarsInbox.locator('.cf-h')).toHaveText('F02 severity');
  await closeTeamDialog(b.win);

  // Rana keeps hers
  const ranasInbox = await inbox(a.win);
  await expect(ranasInbox.locator('.cf-h')).toHaveText('F02 severity');
  await ranasInbox.getByRole('button', { name: 'Keep mine: F02 severity 3' }).click();
  await expect(ranasInbox.locator('.cf-item')).toHaveCount(0, { timeout: 15_000 });
  await closeTeamDialog(a.win);
  await syncAll(a, b);

  for (const r of [a, b]) {
    await expect(r.win.getByTestId('sync-conflicts')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await issue(r, 'F02'))?.severity).toBe(3);
    expect((await issue(r, 'F02'))?.title).toBe('Crack along the weld');
    expect(await status(r)).toMatchObject({ conflicts: 0, quarantined: 0 });
  }
});

test('a new issue on each copy: one keeps F03, the other is renumbered F04', async ({
  twoReviewers,
}) => {
  test.setTimeout(240_000);
  const { a, b } = twoReviewers;
  await bothOnHub(twoReviewers);
  // collect the notices each copy announces
  for (const r of [a, b]) {
    await r.win.evaluate(() => {
      const w = window as unknown as { __notices: unknown[] };
      w.__notices = [];
      window.aio.on('sync:notice', (e) => w.__notices.push(...e.notices));
    });
  }

  await pinIssue(a);
  await pinIssue(b);
  expect((await onDisk(a)).map((i) => i.code)).toEqual(['F01', 'F02', 'F03']);
  expect((await onDisk(b)).map((i) => i.code)).toEqual(['F01', 'F02', 'F03']);
  const ranas = (await onDisk(a)).find((i) => i.code === 'F03')?.id;
  const omars = (await onDisk(b)).find((i) => i.code === 'F03')?.id;
  expect(ranas).not.toBe(omars);
  await syncAll(a, b);

  // the same four issues on both copies, the two new ones with different codes
  const codes = async (r: Reviewer) =>
    Object.fromEntries((await onDisk(r)).map((i) => [i.id, i.code]));
  await expect.poll(async () => Object.keys(await codes(a)).length).toBe(4);
  await expect.poll(async () => Object.keys(await codes(b)).length).toBe(4);
  const onA = await codes(a);
  expect(await codes(b)).toEqual(onA);
  expect([onA[ranas ?? ''], onA[omars ?? '']].sort()).toEqual(['F03', 'F04']);
  const renumbered = onA[ranas ?? ''] === 'F04' ? a : b;
  const renumberedId = onA[ranas ?? ''] === 'F04' ? ranas : omars;

  // the copy that renumbered says so: a notice, the inbox entry and the issue's history
  const notices = (await renumbered.win.evaluate(
    () => (window as unknown as { __notices: unknown[] }).__notices,
  )) as { kind: string; from?: string; to?: string; issue?: string }[];
  expect(notices).toContainEqual(
    expect.objectContaining({ kind: 'recode', issue: renumberedId, from: 'F03', to: 'F04' }),
  );
  const box = await inbox(renumbered.win);
  await expect(box.locator('.cf-item[data-kind="code"]')).toContainText(
    'was F03. Another issue made apart has that code, so it is now F04.',
  );
  await closeTeamDialog(renumbered.win);
  const card = await editIssue(renumbered.win, 'F04');
  await expect(card).toContainText('F03 to F04 (made apart with the same code)', {
    timeout: 15_000,
  });
});

test('a delete on one copy and an edit on the other: the issue stays, with a conflict', async ({
  twoReviewers,
}) => {
  test.setTimeout(240_000);
  const { a, b } = twoReviewers;
  await bothOnHub(twoReviewers);
  // an issue the journal made (F03 by Rana), on both copies
  await pinIssue(a);
  await syncAll(a, b);
  await expect.poll(async () => (await issue(b, 'F03'))?.author).toBe('Rana Example');

  const card = await editIssue(a.win, 'F03');
  await card.getByRole('button', { name: 'Delete issue' }).click();
  await expect.poll(async () => (await onDisk(a)).map((i) => i.code)).toEqual(['F01', 'F02']);
  await setTitle(b.win, 'F03', 'Crack still there');
  await syncAll(a, b);

  for (const r of [a, b]) {
    await expect.poll(async () => (await issue(r, 'F03'))?.title).toBe('Crack still there');
    await expect(await registerOf(r)).toContainText('Crack still there');
    await expect(r.win.getByTestId('sync-conflicts')).toHaveText('1 conflict', { timeout: 15_000 });
  }
  const box = await inbox(a.win);
  const item = box.locator('.cf-item[data-kind="delete-edit"]');
  await expect(item).toContainText('You deleted F03 while Omar Sample changed it. It was kept.');
  await expect(item.getByRole('button', { name: 'Delete again' })).toBeVisible();
  await closeTeamDialog(a.win);
});

test('a reviewer changes the coordinate system: quarantined on the owner copy until applied anyway', async ({
  twoReviewers,
}) => {
  test.setTimeout(240_000);
  const { a, b } = twoReviewers;
  await bothOnHub(twoReviewers);

  // Omar edits the manifest's CRS (no screen lets a reviewer do it; the file is changed on his
  // copy and the journal records it as a manifest entry when he syncs)
  const file = join(b.project, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as { crs: { epsg: number } };
  expect(manifest.crs.epsg).toBe(32639);
  await writeFile(file, JSON.stringify({ ...manifest, crs: { epsg: 32640 } }, null, 2));
  await syncAll(a, b);

  await expect.poll(async () => (await status(a)).quarantined).toBe(1);
  // the op in Rana's history: Omar's manifest entry setting the CRS, held
  const crsOp = async () => {
    const h = await invoke(a.win, 'journal:history', {
      projectId: TEAM_PROJECT_ID,
      filter: { kinds: ['manifest.entry'] },
    });
    if (!h.ok) throw new Error(h.error);
    return h.entries.find((e) => e.actor.name === 'Omar Sample');
  };
  await expect.poll(async () => (await crsOp())?.state).toBe('quarantined');
  const box = await inbox(a.win);
  const held = box.locator('.cf-item[data-kind="quarantine"]');
  await expect(held).toHaveCount(1);
  await expect(held).toContainText('by Omar Sample');
  await expect(held.locator('.cf-why')).toHaveText(
    'Omar Sample is a reviewer in this project. Only an owner can change the coordinate system, origin or datum.',
  );
  await held.getByRole('button', { name: 'Apply anyway' }).click();
  await expect(held).toHaveCount(0, { timeout: 15_000 });
  await closeTeamDialog(a.win);
  await expect.poll(async () => (await status(a)).quarantined).toBe(0);
  await expect.poll(async () => (await crsOp())?.state).toBe('ok');
});
