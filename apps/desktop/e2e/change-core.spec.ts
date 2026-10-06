/**
 * M8 Change core (C1) on the change demo (C8, synthetic, no client data): Compare dates, Show
 * changes, the Changes register with the counts of the demo's `truth.json` (issues, detections,
 * map layers), a click flying both views, "Close as resolved", "Make issue" and the reviews kept
 * after reopening. The zero-network guard of the fixture stays on. The demo opens as a working
 * copy, so the bundled demo is never written.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { CHANGE_DEMO, expect, openChangeDemo, test } from './fixtures';

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: {
          id: string;
          code: string;
          status: string;
          capture?: string;
          resolvedIn?: string;
        }[];
        lastCamera: { target: { kind: string; p?: number[] } } | null;
        select(s: unknown): void;
      };
    };
    graphics(): { getState(): { tier: string; setOverride(t: string | null): void } };
    compare(): {
      changes: {
        main: { id: string; verdict: string; ghost: boolean; selected: boolean }[];
        second: { id: string; verdict: string; ghost: boolean; selected: boolean }[];
      };
    };
  };
}

const ws = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as Inspect).__stratlas.workspace.getState();
    return { issues: s.issues, last: s.lastCamera?.target ?? null };
  });
const pins = (win: Page) =>
  win.evaluate(() => (window as unknown as Inspect).__stratlas.compare().changes);

/** Verdict counts of the register rows of one kind. */
async function verdictCounts(panel: ReturnType<Page['getByTestId']>, kind: string) {
  const verdicts = await panel
    .locator(`[data-testid="change-row"][data-kind="${kind}"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-verdict') ?? ''));
  const out: Record<string, number> = {};
  for (const v of verdicts) out[v] = (out[v] ?? 0) + 1;
  return out;
}

const issueCode = (id: string) => id.split('-').pop()?.toUpperCase() ?? id;

test('the change demo: compare dates, find changes as truth.json says, review and make an issue', async ({
  demoProject,
}) => {
  test.setTimeout(180_000);
  const { win, root, truth } = demoProject;
  await expect(win.locator('[data-scene-view=""] canvas')).toBeVisible();
  // two 3D views need the Medium tier (CI's software GPU is Low)
  await win.evaluate(() => {
    const g = (window as unknown as Inspect).__stratlas.graphics().getState();
    if (g.tier === 'low') g.setOverride('medium');
  });

  await win.getByTestId('compare-dates').click();
  await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2);
  await win.getByTestId('compare-show-changes').click();
  await expect(win.getByTestId('compare-show-changes')).toHaveAttribute('aria-pressed', 'true');
  const panel = win.getByTestId('change-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('change-from')).toHaveValue(truth.captures.from);
  await expect(panel.getByTestId('change-to')).toHaveValue(truth.captures.to);

  await panel.getByTestId('change-run').click();
  const issues = truth.changes.issue as { verdicts: Record<string, number>; items: Item[] };
  const total = Object.values(issues.verdicts).reduce((a, b) => a + b, 0);
  await expect(panel.locator('[data-testid="change-row"][data-kind="issue"]')).toHaveCount(total);
  // 1 new, 1 resolved, 1 grown, the rest unchanged
  expect(await verdictCounts(panel, 'issue')).toEqual(issues.verdicts);
  await expectAccessible(win, 'Changes panel', { include: '[data-testid="change-panel"]' });
  // the detection passes of both dates: the marker found again, gone and new
  expect(await verdictCounts(panel, 'detection')).toEqual(truth.changes.detection?.verdicts);
  // the map layers: the fence reshaped, the pad's surface changed, the new track added
  expect(await verdictCounts(panel, 'vector')).toEqual(truth.changes.vector?.verdicts);

  // the new issue: a ghost pin on the earlier date, then a click flies both views to it
  const fresh = issues.items.find((i) => i.verdict === 'new');
  const newId = `issue:${issueCode(fresh?.to ?? '')}`;
  await expect
    .poll(async () => {
      const p = await pins(win);
      return [
        p.main.find((m) => m.id === newId)?.ghost,
        p.second.find((m) => m.id === newId)?.ghost,
      ];
    })
    .toEqual([true, false]);
  await panel.locator(`[data-testid="change-row"][data-id="${newId}"]`).click();
  await expect
    .poll(async () => {
      const t = (await ws(win)).last;
      const at = fresh?.at ?? [0, 0, 0];
      const [x = NaN, , z = NaN] = t?.kind === 'point' && t.p ? t.p : [];
      return Math.hypot(x - at[0], z - at[2]) < 1;
    })
    .toBe(true);
  await expect
    .poll(async () => {
      const p = await pins(win);
      return [
        p.main.find((m) => m.id === newId)?.selected,
        p.second.find((m) => m.id === newId)?.selected,
      ];
    })
    .toEqual([true, true]);

  // the resolved issue (a later photo looked there): a person closes it; nothing did before
  const resolved = issues.items.find((i) => i.verdict === 'resolved');
  const code = issueCode(resolved?.from ?? '');
  expect((await ws(win)).issues.find((i) => i.code === code)?.status).toBe('reviewed');
  await panel.locator(`[data-testid="change-row"][data-id="issue:${code}"]`).click();
  await panel.getByTestId('change-close-resolved').click();
  await panel.getByTestId('change-close-yes').click();
  await expect
    .poll(async () => (await ws(win)).issues.find((i) => i.code === code))
    .toMatchObject({ status: 'closed', resolvedIn: truth.captures.to });

  // make an issue from the added track: a draft issue on the later date
  const before = (await ws(win)).issues.length;
  const added = panel.locator(
    '[data-testid="change-row"][data-kind="vector"][data-verdict="added"]',
  );
  await added.click();
  await panel.getByTestId('change-make-issue').click();
  await expect.poll(async () => (await ws(win)).issues.length).toBe(before + 1);
  const made = (await ws(win)).issues.at(-1);
  expect(made).toMatchObject({ status: 'draft', capture: truth.captures.to });
  await expect(added).toHaveAttribute('data-status', 'confirmed');

  // the reviews and issues are in the working copy, and survive reopening
  await expect
    .poll(async () => {
      const text = await readFile(join(root, 'issues.json'), 'utf8').catch(() => '');
      return text.includes(`"resolvedIn": "${truth.captures.to}"`);
    })
    .toBe(true);
  await openChangeDemo(win);
  await win.getByTestId('tab-changes').click();
  const again = win.getByTestId('change-panel');
  await expect(
    again.locator(`[data-testid="change-row"][data-id="issue:${code}"]`),
  ).toHaveAttribute('data-status', 'confirmed');
  await expect(
    again.locator('[data-testid="change-row"][data-kind="vector"][data-verdict="added"]'),
  ).toHaveAttribute('data-status', 'confirmed');
  await expect
    .poll(async () => (await ws(win)).issues.find((i) => i.code === code)?.status)
    .toBe('closed');

  // "Belongs to date...": a layer's explicit survey date, saved in the working copy's manifest
  const photos = (truth.layers.d1 as { photos: string }).photos;
  await win.evaluate((id) => {
    (window as unknown as Inspect).__stratlas.workspace
      .getState()
      .select({ kind: 'layer', id, layer: id });
  }, photos);
  await win.getByRole('tab', { name: 'Selection' }).click();
  const picker = win.getByTestId('layer-survey-date').locator('select');
  await expect(picker).toHaveValue(truth.captures.from);
  await picker.selectOption(truth.captures.to);
  await expect
    .poll(async () => {
      const m = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
        layers: { id: string; capture?: string }[];
      };
      return m.layers.find((l) => l.id === photos)?.capture;
    })
    .toBe(truth.captures.to);
  expect(root).toContain(CHANGE_DEMO.id);
});

interface Item {
  verdict: string;
  from?: string;
  to?: string;
  at?: [number, number, number];
}
