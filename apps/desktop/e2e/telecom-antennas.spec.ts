/** Antenna detection in the real app: a synthetic tower cloud, the real pipeline job, a reload. */
import type { EngineStage } from '@aio/engine';
import { AntennasFile } from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { PIPELINE_ENV, expect, hasPipelinePython, processingChip, test } from './fixtures';
import { measureControl } from './island';
import { writeTelecomTower } from './telecomFixtures';

interface Inspect {
  __stratlas: {
    stage(): EngineStage | null;
    antennas: {
      setState(patch: Record<string, unknown>): void;
      getState(): {
        selected: string | null;
        file: { units: { id: string; name: string }[] } | null;
      };
    };
    workspace: { getState(): { project: { id: string } | null } };
  };
}

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `${name}.png`) });
}

/**
 * The selected unit's labels that the card covers (by key), and whether its name label and its
 * width label overlap. Only labels in view count.
 */
async function labelClashes(win: Page): Promise<{ card: string[]; nameWidth: boolean }> {
  return win.evaluate(() => {
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const shown = [
      ...document.querySelectorAll<HTMLElement>('.antenna-labels .sv-label.sel'),
    ].filter((el) => el.style.display !== 'none');
    const cardEl = document.querySelector('[data-testid="antenna-card"]');
    const cardRect = cardEl?.getBoundingClientRect();
    const card = cardRect
      ? shown
          .filter((el) => hit(el.getBoundingClientRect(), cardRect))
          .map((el) => el.dataset.key ?? '')
      : [];
    const name = shown.find((el) => el.dataset.key?.endsWith(':name'));
    const width = shown.find((el) => el.dataset.key?.endsWith(':dim:w'));
    const nameWidth =
      name !== undefined &&
      width !== undefined &&
      hit(name.getBoundingClientRect(), width.getBoundingClientRect());
    return { card, nameWidth };
  });
}

/**
 * Whether the card covers the selected box (its `data-unit-box`, host px) or the name label, and
 * the stage's width.
 */
async function cardCover(win: Page): Promise<{ box: boolean; name: boolean; stageW: number }> {
  return win.evaluate(() => {
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const card = document.querySelector<HTMLElement>('[data-testid="antenna-card"]');
    const host = card?.parentElement;
    if (!card || !host) return { box: false, name: false, stageW: 0 };
    const c = card.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const [x = 0, y = 0, w = 0, h = 0] = (card.dataset.unitBox ?? '').split(' ').map(Number);
    const box = card.dataset.unitBox ? hit(c, new DOMRect(hr.left + x, hr.top + y, w, h)) : false;
    const name = [...document.querySelectorAll<HTMLElement>('.antenna-labels .sv-label.sel')].find(
      (el) => el.style.display !== 'none' && el.dataset.key?.endsWith(':name'),
    );
    return {
      box,
      name: name !== undefined && hit(c, name.getBoundingClientRect()),
      stageW: host.clientWidth,
    };
  });
}

/** Waits until the card has held its place for 500 ms: the fly to the unit has settled. */
async function cardSettled(win: Page): Promise<void> {
  const card = win.getByTestId('antenna-card');
  let last = '';
  let since = Date.now();
  await expect
    .poll(
      async () => {
        const b = await card.boundingBox();
        const now = b ? `${b.x} ${b.y}` : '';
        if (now !== last) {
          last = now;
          since = Date.now();
        }
        return Date.now() - since >= 500;
      },
      { intervals: [100], timeout: 15_000 },
    )
    .toBe(true);
}

async function openTiny(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
  await openTelecom(win);
}

/** The telecom tools are the Measure workbench's Telecom family: open the bench and the section. */
async function openTelecom(win: Page) {
  await measureControl(win, 'telecom-tool-clearance');
  await expect(win.getByTestId('telecom-tools')).toBeVisible();
}

/** Look at the crown of the synthetic tower (units about 26 to 29 m up). */
async function viewCrown(win: Page) {
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas
      .stage()
      ?.restoreView({ position: [9, 31, 9], target: [0, 27.5, 0] }, false);
  });
}

/** How far the telecom tools' content reaches past their width, in CSS pixels. */
const horizontalOverflow = (win: Page) =>
  win.getByTestId('telecom-tools').evaluate((el) => el.scrollWidth - el.clientWidth);

/** Whether the Detect antennas button lies wholly inside the visible part of the telecom tools. */
const detectInView = (win: Page) =>
  win.getByTestId('detect-antennas').evaluate((button) => {
    const tools = button.closest('[data-testid="telecom-tools"]');
    if (!tools) return false;
    const b = button.getBoundingClientRect();
    const t = tools.getBoundingClientRect();
    return (
      b.left >= t.left &&
      b.right <= t.left + tools.clientWidth &&
      b.top >= t.top &&
      b.bottom <= t.top + tools.clientHeight
    );
  });

/**
 * Whether a row's status chip shows its whole text: not cut inside itself and not cut by the row
 * label around it.
 */
const chipWhole = (row: Locator) =>
  row.getByTestId('antenna-status').evaluate((chip) => {
    const label = chip.closest('.row-label');
    if (!label) return false;
    const c = chip.getBoundingClientRect();
    const l = label.getBoundingClientRect();
    return chip.scrollWidth <= chip.clientWidth && c.left >= l.left && c.right <= l.right + 0.5;
  });

const savedFile = async (dir: string) =>
  AntennasFile.parse(JSON.parse(await readFile(join(dir, 'telecom', 'antennas.json'), 'utf8')));

/** Names of the antenna boxes in the scene (one `antenna-box:<id>` per drawn unit). */
const boxNames = (win: Page) =>
  win.evaluate(() => {
    const names: string[] = [];
    (window as unknown as Inspect).__stratlas.stage()?.scene.traverse((o) => {
      if (o.name.startsWith('antenna-box:')) names.push(o.name);
    });
    return names.sort();
  });

const sceneHas = (win: Page, name: string) =>
  win.evaluate(
    (n) => Boolean((window as unknown as Inspect).__stratlas.stage()?.scene.getObjectByName(n)),
    name,
  );

test('hides Detect antennas in a project without a point cloud', async ({ win }) => {
  await openTiny(win);
  await expect(win.getByTestId('telecom-tools')).toBeVisible();
  await expect(win.getByTestId('detect-antennas')).toHaveCount(0);
});

test('detects antennas, accepts one and keeps it after a reload', async ({ win, dataRoot }) => {
  test.setTimeout(300_000);
  await writeTelecomTower(dataRoot.projectDir);
  await openTiny(win);
  const detect = win.getByTestId('detect-antennas');
  await expect(detect).toBeVisible();
  // disabled with a reason while the cloud loads
  await expect(detect).toBeEnabled({ timeout: 60_000 });
  expect(await detectInView(win), 'Detect antennas is not clipped').toBe(true);
  await evidence(win, 'a-telecom-tools-detect-button');

  await detect.click();
  if (await processingChip(win).isVisible()) await evidence(win, 'b-job-running');

  const panel = win.getByTestId('antenna-panel');
  const rows = panel.getByTestId('antenna-row');
  // seed 3 has 9 truth units: 4 panels, 3 short antennas, 1 dish and 1 "other" box. The run finds
  // the 8 antennas, all of them, and does not report the other box (fixed seed, same every run).
  await expect.poll(() => rows.count(), { timeout: 180_000 }).toBe(8);
  await expect(panel.getByTestId('antenna-summary')).toHaveText(
    '8 antennas · 8 need review · Project north azimuths',
  );
  await expect(panel).toContainText('Project north');
  await expect(detect).toBeEnabled();
  await viewCrown(win);
  // the run lists the units and opens no card: nothing is selected until the person picks
  const card = win.getByTestId('antenna-card');
  await expect(card).toHaveCount(0);
  await expect(panel.locator('[aria-selected="true"][data-testid="antenna-row"]')).toHaveCount(0);
  await panel.getByTestId('antenna-filter-all').click();
  await expect(card).toHaveCount(0);
  await expect(panel.locator('[aria-selected="true"][data-testid="antenna-row"]')).toHaveCount(0);
  await panel.getByTestId('antenna-filter-draft').click();
  await evidence(win, 'c-inventory-after-run');
  // select the first unit: its row, the halo in 3D and the details
  const first = rows.first();
  await first.focus();
  await win.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => sceneHas(win, 'antenna-highlight')).toBe(true);
  await expect(card).toBeVisible();
  // the header shows the whole name, as the row does
  const head = card.getByTestId('antenna-card-name');
  const name = await win.evaluate(() => {
    const a = (window as unknown as Inspect).__stratlas.antennas.getState();
    return a.file?.units.find((u) => u.id === a.selected)?.name ?? '';
  });
  expect(name.length).toBeGreaterThan(0);
  await expect(head).toHaveText(name);
  await expect(first).toContainText(name);
  expect(
    await head.evaluate((el) => el.scrollWidth <= el.clientWidth),
    'the card header name is not cut',
  ).toBe(true);
  // the run leaves the filter on To review, so the card walks the 8 drafts, in the list's order
  await expect(card.getByTestId('antenna-card-position')).toHaveText('1 / 8');
  await evidence(win, 'e-card-selected');
  // at the CI size the tools scroll up and down inside the aside, never sideways
  await expect.poll(() => horizontalOverflow(win)).toBeLessThanOrEqual(0);

  // accept with the key: the unit leaves To review and the card moves on
  await win.keyboard.press('a');
  await expect(rows).toHaveCount(7);
  await expect(card.getByTestId('antenna-card-position')).toHaveText('1 / 7');
  await panel.getByTestId('antenna-filter-all').click();
  await expect(rows).toHaveCount(8);
  const accepted = panel.locator('[data-testid="antenna-row"][data-status="accepted"]');
  await expect(accepted).toHaveCount(1);
  // the chip keeps its text at the CI size
  expect(await chipWhole(accepted.first()), 'accepted chip is whole').toBe(true);
  await expect(panel.locator('[data-testid="antenna-row"][data-status="draft"]')).toHaveCount(7);
  expect(
    await chipWhole(panel.locator('[data-testid="antenna-row"][data-status="draft"]').first()),
    'draft chip is whole',
  ).toBe(true);
  await expectAccessible(win, 'Antenna inventory', { include: '[data-testid="antenna-panel"]' });
  await expectAccessible(win, 'Antenna card', { include: '[data-testid="antenna-card"]' });

  // a clicked row keeps the review keys: the arrow steps the card, Escape closes it
  await panel.getByTestId('antenna-filter-draft').click();
  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
  await win.keyboard.press('ArrowRight');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByTestId('antenna-card-position')).toHaveText('2 / 7');
  await evidence(win, 'i-row-click-arrow-step');
  await win.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await rows.nth(0).click();
  await expect(card).toBeVisible();

  // Hide all: only the selected unit stays drawn, and the walk moves it with the selection
  await panel.getByTestId('antenna-hide-all').click();
  await expect.poll(() => boxNames(win)).toHaveLength(1);
  const [before] = await boxNames(win);
  await win.keyboard.press('ArrowRight');
  await expect.poll(async () => (await boxNames(win)).join()).not.toBe(before);
  expect(await boxNames(win)).toHaveLength(1);
  await evidence(win, 'g-hide-all-walk');
  await panel.getByTestId('antenna-show-all').click();
  await expect.poll(() => boxNames(win)).toHaveLength(8);
  await evidence(win, 'h-show-all');

  // the panel group's eye hides the panels' boxes
  await panel.getByTestId('antenna-filter-all').click();
  await panel.getByTestId('antenna-group-eye-panel').click();
  await expect.poll(async () => (await boxNames(win)).length).toBeLessThan(8);
  const left = await boxNames(win);
  expect(left.length).toBeGreaterThanOrEqual(1);
  await panel.getByTestId('antenna-group-eye-panel').click();
  await expect.poll(() => boxNames(win)).toHaveLength(8);

  // numbered pins: a click on another unit's pin selects it, as a box pick does
  await viewCrown(win);
  const pins = win.locator('.antenna-label--pin');
  await expect.poll(() => pins.count()).toBe(7);
  const target = await pins.evaluateAll((els) => {
    // the first pin that is on top where it is drawn (not under the card or another pin)
    for (const el of els as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el)
        return el.dataset.unitId ?? null;
    }
    return null;
  });
  expect(target, 'a pin is clickable').not.toBeNull();
  const pin = win.locator(`.antenna-label--pin[data-unit-id="${target ?? ''}"]`);
  const pinBox = await pin.boundingBox();
  expect(pinBox?.height ?? 0, 'the pin is a small pill').toBeLessThan(16);
  const targetName = await win.evaluate(
    (id) =>
      (window as unknown as Inspect).__stratlas.antennas
        .getState()
        .file?.units.find((u) => u.id === id)?.name ?? '',
    target,
  );
  await expect(pin).toHaveAttribute('title', new RegExp(`^${targetName} · `));
  await pin.hover();
  await evidence(win, 'j-pins');
  await pin.click();
  await expect(card.getByTestId('antenna-card-name')).toHaveText(targetName);
  // once the fly to the unit has settled, the card keeps off the selected box and its name at
  // every size, and the name clears the width label. On a stage 700 px wide or less (CI's
  // 1100 x 720 window leaves about 490 px) the 320 px card cannot clear the box and all its
  // labels as well, so it may cover the cheap ones (sizes, angle); a wider stage has room for
  // the card to clear every selected label.
  await cardSettled(win);
  const cover = await cardCover(win);
  expect({ box: cover.box, name: cover.name }).toEqual({ box: false, name: false });
  const clashes = await labelClashes(win);
  expect(clashes.nameWidth).toBe(false);
  if (cover.stageW > 700) expect(clashes.card).toEqual([]);
  // a card capped to the room beside the unit keeps Accept whole in view, without scrolling
  const accept = card.getByTestId('antenna-card-accept');
  await expect(accept).toBeInViewport({ ratio: 1 });
  const unclipped = await accept.evaluate((el) => {
    const a = el.getBoundingClientRect();
    const c = el.closest('[data-testid="antenna-card"]')?.getBoundingClientRect();
    return c !== undefined && a.top >= c.top && a.bottom <= c.bottom && a.height > 0;
  });
  expect(unclipped, 'Accept lies wholly inside the card').toBe(true);
  await evidence(win, 'j2-pins');
  await expect(pin).toHaveCount(0);
  await expect(pins).toHaveCount(7);
  const control = win.getByTestId('antenna-labels-control');
  await expectAccessible(win, 'Labels control', {
    include: '[data-testid="antenna-labels-control"]',
  });
  // Labels Off: no pins, the selected unit keeps its card and its own labels
  await control.getByRole('button', { name: 'Off' }).click();
  await expect(control.getByRole('button', { name: 'Off' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(pins).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(win.locator('.antenna-labels .sv-label.sel').first()).toBeVisible();
  await evidence(win, 'k-labels-off');
  await control.getByRole('button', { name: 'All' }).click();
  await expect(pins).toHaveCount(7);

  // the inventory's CSV export sits next to Export survey data, in Site data
  const site = win.getByTestId('wb-section-siteData');
  const siteHead = site.locator('.wb-section-head');
  if ((await siteHead.getAttribute('aria-expanded')) !== 'true') await siteHead.click();
  const csvTool = site.getByRole('button', { name: 'Export antenna inventory (CSV)' });
  await expect(site.getByTestId('survey-export-open')).toBeVisible();
  await expect(csvTool).toBeVisible();
  await csvTool.click();
  await expect(win.getByTestId('antenna-csv')).toBeVisible();
  await evidence(win, 'f-csv-next-to-export');
  await win.keyboard.press('Escape');

  // the AI send preview (set as a run would, no provider needed) is a modal over the whole window,
  // on the modal layer, not clipped to the sidebar
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas.antennas.setState({
      aiPreview: {
        projectId: (window as unknown as Inspect).__stratlas.workspace.getState().project?.id,
        unitIds: ['u1'],
        value: {
          ok: true,
          provider: 'anthropic',
          model: 'm1',
          cloud: true,
          photosAllowed: false,
          crops: [],
          missing: [],
          estimate: { images: 1, inputTokens: 900, costUsd: 0.02 },
          token: 'e2e',
        },
      },
    });
  });
  const preview = win.getByRole('dialog', { name: 'Send photo crops for labelling' });
  await expect(preview).toBeVisible();
  const layer = await win.locator('.antenna-send-layer .ag-modal-back').evaluate((back) => {
    const r = back.getBoundingClientRect();
    return {
      z: getComputedStyle(back).zIndex,
      modal: getComputedStyle(document.documentElement).getPropertyValue('--z-modal').trim(),
      covers: r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight,
    };
  });
  expect(layer.z).toBe(layer.modal);
  expect(layer.covers, 'the preview backdrop covers the window').toBe(true);
  await evidence(win, 'g-ai-send-preview');
  await win.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);

  // the accept is on disk before the reload reads it again
  await expect
    .poll(
      async () =>
        (await savedFile(dataRoot.projectDir).catch(() => null))?.units.filter(
          (u) => u.status === 'accepted',
        ).length ?? 0,
    )
    .toBe(1);
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openTiny(win);
  else await openTelecom(win);
  // a fresh open selects nothing, and neither does a filter click
  await expect(win.getByTestId('antenna-card')).toHaveCount(0);
  await win.getByTestId('antenna-panel').getByTestId('antenna-filter-all').click();
  await expect(win.getByTestId('antenna-card')).toHaveCount(0);
  await expect(
    win.getByTestId('antenna-panel').locator('[aria-selected="true"][data-testid="antenna-row"]'),
  ).toHaveCount(0);
  const reopened = win
    .getByTestId('antenna-panel')
    .locator('[data-testid="antenna-row"][data-status="accepted"]');
  await expect(reopened).toHaveCount(1);
  await expect(reopened.first()).toHaveAttribute('data-status', 'accepted');
  await expect(win.getByTestId('antenna-panel')).toContainText('Accepted');
  expect(await chipWhole(reopened.first()), 'accepted chip is whole after the reload').toBe(true);
  await viewCrown(win);
  await evidence(win, 'e-accepted-after-reload');

  const saved = await savedFile(dataRoot.projectDir);
  expect(saved.units).toHaveLength(8);
  expect(saved.units.filter((u) => u.status === 'accepted')).toHaveLength(1);
});
