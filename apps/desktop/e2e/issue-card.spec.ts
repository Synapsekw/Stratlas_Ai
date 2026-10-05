/**
 * The issue card and photo findings on the real HCl and DAMAC projects: picking an issue in the
 * 3D view opens its card in the right panel with its photo (marks drawn), the photo opens full
 * size and Esc closes it; picking it in 3D also opens its photo beside the 3D view (split), and
 * Esc puts the layout back; Media marks the photos with findings and filters to them.
 *
 * Runs only where the projects exist under E:\Stratlas Data (or STRATLAS_DATA_ROOT); skipped
 * elsewhere. Read-only for the projects: settings and thumbnails go to a throwaway profile.
 * Screenshots go to STRATLAS_SHOTS when it is set.
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard } from './fixtures';

const DATA = process.env.STRATLAS_DATA_ROOT ?? 'E:/Stratlas Data';
const SHOTS = process.env.STRATLAS_SHOTS;

const test = base.extend<{ app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  app: async ({}, use) => {
    const tmp = await mkdtemp(join(tmpdir(), 'aio-card-'));
    const network = new NetworkGuard();
    const app = await launchApp({
      base: tmp,
      root: DATA,
      userData: join(tmp, 'user'),
      projectId: 'hcl',
      projectDir: join(DATA, 'projects', 'hcl'),
    });
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
      await rm(tmp, { recursive: true, force: true });
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 960);
    });
    await use(win);
  },
});

test.setTimeout(240_000);

async function shot(win: Page, name: string): Promise<void> {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
}

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: { id: string; code: string }[];
        selection: { kind: string; id: string } | null;
        select(s: { kind: string; id: string } | null): void;
        flyTo(t: { kind: 'home' }): void;
      };
    };
    stage(): {
      scene: { traverse(fn: (o: { userData: Record<string, unknown> }) => void): void };
    } | null;
  };
}

interface Item {
  kind: 'pin' | 'cluster';
  x: number;
  y: number;
  members: { issueId: string; code: string }[];
}

/** The pins and count badges the 3D overlay laid out last, in canvas pixels. */
function pinItems(win: Page): Promise<Item[]> {
  return win.evaluate(() => {
    const stage = (window as unknown as Inspect).__stratlas.stage();
    let items: Item[] = [];
    stage?.scene.traverse((o) => {
      const layout = o.userData.layout as { items?: Item[] } | undefined;
      if (layout?.items) items = layout.items;
    });
    return items.map((i) => ({
      kind: i.kind,
      x: i.x,
      y: i.y,
      members: i.members.map((m) => ({ issueId: m.issueId, code: m.code })),
    }));
  });
}

async function openProject(win: Page, name: string, issues: number): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: name }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        win.evaluate(
          () => (window as unknown as Inspect).__stratlas.workspace.getState().issues.length,
        ),
      { timeout: 60_000 },
    )
    .toBe(issues);
}

/** Wait until the overlay has pins (or badges) on screen and the camera has settled. */
async function waitForPins(win: Page): Promise<Item[]> {
  let items: Item[] = [];
  let last = '';
  await expect
    .poll(
      async () => {
        items = await pinItems(win);
        const now = JSON.stringify(items.map((i) => [Math.round(i.x), Math.round(i.y)]));
        const still = items.length > 0 && now === last;
        last = now;
        return still;
      },
      { timeout: 90_000, intervals: [700] },
    )
    .toBe(true);
  return items;
}

/** Click a single pin in the 3D view (or a badge's list row); returns the picked issue id. */
async function pickInScene(win: Page): Promise<string> {
  const canvas = win.locator('[data-scene-view] canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no 3D canvas');
  for (let attempt = 0; attempt < 6; attempt++) {
    const items = await waitForPins(win);
    const inside = items.filter(
      (i) => i.x > 60 && i.y > 90 && i.x < box.width - 60 && i.y < box.height - 60,
    );
    const pin = inside.find((i) => i.kind === 'pin');
    if (pin) {
      await win.mouse.click(box.x + pin.x, box.y + pin.y);
      return pin.members[0]?.issueId ?? '';
    }
    const badge = inside[0];
    if (!badge) throw new Error('no pin in view');
    await win.mouse.click(box.x + badge.x, box.y + badge.y);
    const list = win.locator('.ann-cluster-list');
    if (await list.isVisible().catch(() => false)) {
      const row = list.getByRole('option').first();
      const code = (await row.textContent())?.trim() ?? '';
      await row.click();
      return win.evaluate(
        (c) =>
          (window as unknown as Inspect).__stratlas.workspace
            .getState()
            .issues.find((i) => i.code === c)?.id ?? '',
        code,
      );
    }
    // the badge flew the camera closer: look again once it settles
    await win.waitForTimeout(1_500);
  }
  throw new Error('could not pick an issue in 3D');
}

const stageMode = (win: Page) => win.locator('.stage').getAttribute('data-mode');

for (const p of [
  { id: 'hcl', name: 'HCl', label: true },
  { id: 'damac', name: 'DAMAC', label: false },
]) {
  const dir = join(DATA, 'projects', p.id);
  const count = existsSync(join(dir, 'issues.json'))
    ? (JSON.parse(readFileSync(join(dir, 'issues.json'), 'utf8')) as { issues: unknown[] }).issues
        .length
    : 0;

  test(`${p.name}: a picked issue opens its card, its photo full size, and beside the 3D view`, async ({
    win,
  }) => {
    test.skip(!existsSync(join(dir, 'manifest.json')), `${p.name} not found at ${dir}`);
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));

    await openProject(win, p.name, count);
    await expect(win.locator('.stage')).toHaveAttribute('data-mode', '3d');
    // fold the right panel away: picking an issue brings it back
    await win.keyboard.press('Control+Alt+b');
    await expect(win.locator('.ws.right-off')).toHaveCount(1);
    await waitForPins(win);

    let picked: string;
    if (p.label) {
      // HCl: click an issue's code label (the view is uncrowded: every pin has its code)
      const label = win.locator('.ann-pin-labels > div[data-kind="code"]:visible').first();
      await expect(label).toBeVisible();
      const code = (await label.textContent())?.trim() ?? '';
      const lb = await label.boundingBox();
      if (!lb) throw new Error('no label box');
      await win.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 4 });
      await win.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2);
      picked = await win.evaluate(
        (c) =>
          (window as unknown as Inspect).__stratlas.workspace
            .getState()
            .issues.find((i) => i.code === c)?.id ?? '',
        code,
      );
    } else {
      picked = await pickInScene(win);
    }
    expect(picked).not.toBe('');
    await expect
      .poll(() =>
        win.evaluate(
          () => (window as unknown as Inspect).__stratlas.workspace.getState().selection,
        ),
      )
      .toEqual({ kind: 'issue', id: picked });

    // the card, with the issue's photo
    await expect(win.locator('.ws.right-off')).toHaveCount(0);
    const card = win.getByTestId('issue-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-issue', picked);
    const photo = card.getByTestId('issue-card-photo');
    await expect(photo).toBeVisible();
    await expect(photo.locator('svg image').first()).toBeAttached({ timeout: 20_000 });

    // ... and beside the 3D view: split, the photos pane shows the issue's photo
    await expect.poll(() => stageMode(win)).toBe('split');
    const evidence = win.getByTestId('evidence-photo');
    await expect(evidence).toBeVisible();
    await expect(evidence).toHaveAttribute('data-issue', picked);
    await expect(win.locator('.pane-3d[data-side="left"]')).toBeVisible();
    await expect(win.getByTestId('photo-viewer').first()).toBeVisible();
    await win.waitForTimeout(1_500);
    await shot(win, `issue-card-${p.id}-split`);

    // the card's photo opens full size, Esc closes it (the split stays)
    await photo.click();
    const lightbox = win.getByTestId('lightbox');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByTestId('photo-viewer')).toBeVisible();
    await expect(lightbox.locator('img.ann-img').first()).toBeVisible({ timeout: 20_000 });
    await win.waitForTimeout(800);
    await shot(win, `issue-card-${p.id}-lightbox`);
    // markings off and on
    await lightbox.getByTestId('lightbox-marks').click();
    await expect(lightbox.getByTestId('lightbox-marks')).toHaveAttribute('aria-pressed', 'false');
    await win.keyboard.press('m');
    await expect(lightbox.getByTestId('lightbox-marks')).toHaveAttribute('aria-pressed', 'true');
    await win.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
    expect(await stageMode(win)).toBe('split');
    // focus went back to the photo that opened it
    await expect(photo).toBeFocused();

    // Esc closes the evidence: the 3D view alone again, as before
    await win.locator('[data-scene-view] canvas').hover();
    await win.keyboard.press('Escape');
    await expect.poll(() => stageMode(win)).toBe('3d');
    await expect(card).toBeVisible();
    await shot(win, `issue-card-${p.id}-card`);

    // the card's next button walks to another issue
    await card.getByRole('button', { name: 'Next issue' }).click();
    await expect(card).not.toHaveAttribute('data-issue', picked);

    // with the switch off, a pick in 3D only opens the card
    await card.getByRole('switch', { name: 'Open evidence in split' }).click();
    await win.evaluate(() => {
      (window as unknown as Inspect).__stratlas.workspace.getState().select(null);
    });
    await pickInScene(win);
    await expect(win.getByTestId('issue-card')).toBeVisible();
    await win.waitForTimeout(500);
    expect(await stageMode(win)).toBe('3d');

    // Media: photos with findings are marked, and the filter keeps only them
    await win.evaluate(() => {
      (window as unknown as Inspect).__stratlas.workspace.getState().select(null);
    });
    await win.locator('.nav-item', { hasText: 'Media' }).first().click();
    const withF = win.locator('.media .m-card.has-f');
    await withF.first().scrollIntoViewIfNeeded({ timeout: 30_000 });
    await expect(withF.first()).toBeVisible({ timeout: 30_000 });
    await expect(withF.first().locator('.m-fbadge')).toBeVisible();
    await expect(win.getByTestId('media-findings-count')).toContainText('with findings');
    await expect(withF.first().locator('.m-marks').first()).toBeAttached({ timeout: 30_000 });
    await win.waitForTimeout(1_000);
    await shot(win, `media-findings-${p.id}`);
    const all = await win.locator('.media .m-card.sq').count();
    await win.getByTestId('media-only-findings').click();
    await expect(win.getByTestId('media-only-findings')).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => {
        const shown = await win.locator('.media .m-card.sq').count();
        const marked = await win.locator('.media .m-card.sq.has-f').count();
        return shown > 0 && shown === marked;
      })
      .toBe(true);
    if (p.id === 'hcl') expect(await win.locator('.media .m-card.sq').count()).toBeLessThan(all);
    await win.getByTestId('media-order').selectOption('severity');
    await withF.first().scrollIntoViewIfNeeded();
    await win.waitForTimeout(1_500);
    await shot(win, `media-findings-${p.id}-filtered`);
    // a tile opens its photo with the issues drawn; a box in it opens that issue's card
    await withF.first().click();
    await expect(win.getByTestId('photo-viewer')).toBeVisible();
    await win.waitForTimeout(1_000);
    await shot(win, `media-findings-${p.id}-photo`);

    expect(errors).toEqual([]);
  });
}
