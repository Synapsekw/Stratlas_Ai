/**
 * The Antennas group of the Project tab's "In this project" list in the real app: the list is
 * the first tab and holds the detected antennas with their azimuth and downtilt as fields, a
 * delete that stays deleted through a new detection run, the sector a unit sits in, a pick in
 * the 3D view, the right-click menu (the same on a unit in 3D and on its row), the bulk bar and
 * the island's Measure group. The inventory is the synthetic RF fixture (three accepted panels
 * and a draft, a tower cloud) except for the delete, which runs the real detection on the
 * synthetic tower, as `telecom-antennas.spec.ts` does.
 */
import type { EngineStage } from '@aio/engine';
import {
  ANTENNA_DELETIONS_FILE,
  AntennaDeletionsFile,
  AntennasFile,
  RfSectorsFile,
} from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PIPELINE_ENV, expect, hasPipelinePython, processingChip, test } from './fixtures';
import { island, measureControl, openIslandTools } from './island';
import { readRfSectors, writeRfProject } from './rfFixtures';
import { projectAntennas, writeTelecomTower } from './telecomFixtures';

interface Inspect {
  __stratlas: {
    stage(): EngineStage | null;
    workbench: { getState(): { open(id: string): void } };
    antennas: { getState(): { selected: string | null } };
  };
}

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string, atTop = false): Promise<void> {
  if (!EVIDENCE) return;
  if (atTop)
    await win
      .locator('.right .wb-scroll')
      .first()
      .evaluate((el) => (el.scrollTop = 0));
  // a beat and two frames: a fold or a dialog that was just opened has stopped moving
  await win.evaluate(
    () =>
      new Promise((r) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 400),
      ),
  );
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `project-list-${name}.png`) });
}

async function openTiny(win: Page): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible();
}

/** After a reload: the project list or the scene, whichever the app lands on. */
async function reopenTiny(win: Page): Promise<void> {
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openTiny(win);
}

const savedFile = async (dir: string) =>
  AntennasFile.parse(JSON.parse(await readFile(join(dir, 'telecom', 'antennas.json'), 'utf8')));

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The row of a unit in the group, by its id. */
const rowOf = (group: Locator, id: string) =>
  group.locator(`[data-row-id="${id}"] [data-testid="antenna-row"]`);

/** Where a unit's box is on screen, and whether the 3D canvas itself is under that point. */
async function boxOnScreen(win: Page, id: string) {
  return win.evaluate((unit) => {
    const stage = (window as unknown as Inspect).__stratlas.stage();
    const mesh = stage?.scene.getObjectByName(`antenna-box:${unit}`);
    if (!stage || !mesh) throw new Error(`no box for ${unit}`);
    stage.camera.updateMatrixWorld();
    const ndc = mesh.getWorldPosition(stage.camera.position.clone()).project(stage.camera);
    const canvas = stage.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const x = r.left + ((ndc.x + 1) / 2) * r.width;
    const y = r.top + ((1 - ndc.y) / 2) * r.height;
    return { x, y, free: document.elementFromPoint(x, y) === canvas };
  }, id);
}

/** Look at the RF fixture's crown from a few metres out, labels off so nothing lies on a box. */
async function viewTower(win: Page): Promise<void> {
  await expect(win.getByTestId('antenna-labels-control')).toBeVisible({ timeout: 30_000 });
  await win
    .getByTestId('antenna-labels-control')
    .getByRole('button', { name: 'Off', exact: true })
    .click();
  await win.evaluate(() => {
    // the fixture's tower stands at (20, y, -20) in the local frame, its panels 30 m up
    (window as unknown as Inspect).__stratlas
      .stage()
      ?.restoreView({ position: [28, 32, -12], target: [20, 30, -20] }, false);
  });
}

/** The labels of an open menu, in order. */
const menuLabels = (menu: Locator) => menu.getByRole('menuitem').allInnerTexts();

test.describe('project list: the Antennas group', () => {
  test.describe('without the pipeline', () => {
    test('finds the antennas in the Project tab and edits an azimuth in its row', async ({
      win,
      dataRoot,
    }) => {
      const dir = dataRoot.projectDir;
      await writeRfProject(dir, { cloud: true });
      await openTiny(win);
      // the Project tab is the first tab, and its list names what the project holds
      await expect(win.locator('.right [role="tab"]').first()).toHaveText(/^Project/);
      const group = await projectAntennas(win);
      await expect(win.getByTestId('project-caption')).toContainText('In this project');
      await expect(group.locator('.wb-section-title')).toHaveText('Antennas');
      await expect(group.locator('.wb-section-count')).toHaveText('4');
      await evidence(win, 'a-project-tab', true);

      await group.getByTestId('antenna-filter-all').click();
      const az = rowOf(group, 'ant-p2').getByTestId('antenna-row-az');
      await az.fill('45');
      await az.press('Enter');
      await expect
        .poll(() =>
          savedFile(dir).then((f) => f.units.find((u) => u.id === 'ant-p2')?.azimuthGridDeg),
        )
        .toMatchObject({ value: 45, basis: 'user' });

      await reopenTiny(win);
      const again = await projectAntennas(win);
      await again.getByTestId('antenna-filter-all').click();
      await expect(rowOf(again, 'ant-p2').getByTestId('antenna-row-az')).toHaveValue(/^45(\.0)?$/);
    });

    test('a unit in a sector names the sector and leaves it', async ({ win, dataRoot }) => {
      const dir = dataRoot.projectDir;
      await writeRfProject(dir, { cloud: true });
      await mkdir(join(dir, 'rf'), { recursive: true });
      await writeFile(
        join(dir, 'rf', 'sectors.json'),
        JSON.stringify(
          RfSectorsFile.parse({
            schema: 'aio.rf-sectors/1',
            sectors: [{ id: 'sec-alpha', name: 'Alpha', antennaIds: ['ant-p1', 'ant-p2'] }],
            antennas: [],
            study: {},
          }),
        ),
      );
      await openTiny(win);
      const group = await projectAntennas(win);
      await group.getByTestId('antenna-filter-all').click();
      await rowOf(group, 'ant-p2').getByTestId('antenna-row-delete').click();
      const dlg = win.getByTestId('antenna-delete-confirm');
      await expect(dlg).toContainText('P2');
      await expect(win.getByTestId('antenna-delete-sector')).toContainText('Alpha');
      // nothing is edited in Coverage, so there is no unsaved plan to warn about
      await expect(win.getByTestId('antenna-delete-plan-unsaved')).toHaveCount(0);
      await evidence(win, 'b-delete-in-sector');
      await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dlg).toHaveCount(0);
      await expect(rowOf(group, 'ant-p2')).toHaveCount(0);
      // the sector keeps the others and lets the deleted unit go
      await expect
        .poll(() => readRfSectors(dir).then((f) => f?.sectors[0]?.antennaIds))
        .toEqual(['ant-p1']);
      const sectors = win.getByTestId('wb-section-project-sectors');
      const head = sectors.locator('.wb-section-head').first();
      if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
      await expect(sectors.getByRole('listitem').filter({ hasText: 'Alpha' })).toContainText(
        '1 antenna',
      );
    });

    test('picking a unit in 3D opens its row with details; Coverage in front is left alone', async ({
      win,
      dataRoot,
    }) => {
      await writeRfProject(dataRoot.projectDir, { cloud: true });
      await openTiny(win);
      await viewTower(win);
      const tab = (id: string) => win.locator(`.right #wb-tab-${id}`);
      await expect(tab('selection')).toHaveAttribute('aria-selected', 'true');

      // a pick with Selection in front brings the Project tab forward, the unit's row open
      const p3 = await boxOnScreen(win, 'ant-p3');
      expect(p3.free, 'nothing but the 3D view lies on the box').toBe(true);
      await win.mouse.click(p3.x, p3.y);
      await expect(tab('measure')).toHaveAttribute('aria-selected', 'true');
      const group = win.getByTestId('wb-section-project-antennas');
      await expect(rowOf(group, 'ant-p3')).toHaveAttribute('aria-selected', 'true');
      await expect(win.getByTestId('antenna-details')).toBeVisible();
      await evidence(win, 'c-3d-pick', false);

      // Coverage in front: a pick selects the unit but does not take the tab away
      await win.evaluate(() => {
        (window as unknown as Inspect).__stratlas.workbench.getState().open('rf');
      });
      await expect(tab('rf')).toHaveAttribute('aria-selected', 'true');
      // the fly from the first pick must have settled: the box holds its place for two reads
      let last = '';
      await expect
        .poll(
          async () => {
            const b = await boxOnScreen(win, 'ant-p1');
            const now = `${String(Math.round(b.x))} ${String(Math.round(b.y))}`;
            const same = now === last;
            last = now;
            return same;
          },
          { intervals: [300], timeout: 15_000 },
        )
        .toBe(true);
      const p1 = await boxOnScreen(win, 'ant-p1');
      expect(p1.free, 'nothing but the 3D view lies on the box').toBe(true);
      await win.mouse.click(p1.x, p1.y);
      await expect
        .poll(() =>
          win.evaluate(
            () => (window as unknown as Inspect).__stratlas.antennas.getState().selected,
          ),
        )
        .toBe('ant-p1');
      await expect(tab('rf')).toHaveAttribute('aria-selected', 'true');
      // the list updated behind it
      await tab('measure').click();
      await expect(rowOf(group, 'ant-p1')).toHaveAttribute('aria-selected', 'true');
      await expect(win.getByTestId('antenna-details')).toHaveCount(1);
    });

    test('right-click on a unit in 3D and on its row gives the same actions', async ({
      win,
      dataRoot,
    }) => {
      await writeRfProject(dataRoot.projectDir, { cloud: true });
      await openTiny(win);
      await viewTower(win);
      const group = await projectAntennas(win);
      await group.getByTestId('antenna-filter-all').click();
      const menu = win.getByTestId('antenna-menu');

      await rowOf(group, 'ant-p2').locator('.antenna-name').click({ button: 'right' });
      await expect(menu).toBeVisible();
      const fromRow = await menuLabels(menu);
      expect(fromRow).toEqual(expect.arrayContaining(['Fly to', 'Accept', 'Reject', 'Delete']));
      await evidence(win, 'd-row-menu');
      await win.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);

      const at = await boxOnScreen(win, 'ant-p2');
      expect(at.free, 'nothing but the 3D view lies on the box').toBe(true);
      await win.mouse.click(at.x, at.y, { button: 'right' });
      await expect(menu).toBeVisible();
      expect(await menuLabels(menu)).toEqual(fromRow);
      await evidence(win, 'e-3d-menu');
      await win.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    });

    test('bulk: tick two, Reject', async ({ win, dataRoot }) => {
      const dir = dataRoot.projectDir;
      await writeRfProject(dir, { cloud: true });
      await openTiny(win);
      const group = await projectAntennas(win);
      await group.getByTestId('antenna-filter-all').click();
      await expect(win.getByTestId('antenna-bulk')).toHaveCount(0);
      await rowOf(group, 'ant-p1').locator('input.antenna-tick').check();
      await rowOf(group, 'ant-p3').locator('input.antenna-tick').check();
      const bulk = win.getByTestId('antenna-bulk');
      await expect(bulk).toBeVisible();
      await expect(bulk).toContainText('2');
      await evidence(win, 'f-bulk-bar');
      await bulk.getByTestId('antenna-bulk-reject').click();
      await expect(bulk).toHaveCount(0);
      await expect
        .poll(() =>
          savedFile(dir).then((f) =>
            f.units.filter((u) => u.status === 'rejected').map((u) => u.id),
          ),
        )
        .toEqual(['ant-p1', 'ant-p3']);
      // the count is the units not rejected
      await expect(group.locator('.wb-section-count')).toHaveText('2');
    });

    test('the notch Measure group opens Project with TOOLS at the top', async ({
      win,
      dataRoot,
    }) => {
      await writeRfProject(dataRoot.projectDir, { cloud: true });
      await openTiny(win);
      const bar = await openIslandTools(win);
      await bar.getByRole('tab', { name: 'Measure', exact: true }).focus();
      await win.keyboard.press('Enter');
      await expect(win.locator('.right #wb-tab-measure')).toHaveAttribute('aria-selected', 'true');
      await expect(island(win)).not.toHaveAttribute('data-state', 'tools');
      const caption = win.getByTestId('project-tools-caption');
      await expect(caption).toBeVisible();
      // the tools lead the view: their caption sits at the top of the scrolling bench
      await expect
        .poll(() =>
          caption.evaluate((el) => {
            const scroller = el.closest('.wb-scroll');
            return scroller
              ? Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
              : 9999;
          }),
        )
        .toBeLessThanOrEqual(8);
      await evidence(win, 'g-tools-at-top');
    });
  });

  test.describe('with the pipeline', () => {
    test.use({ appEnv: PIPELINE_ENV });
    test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

    test('deletes a detected antenna once confirmed and a re-run does not bring it back', async ({
      win,
      dataRoot,
    }) => {
      test.setTimeout(420_000);
      const dir = dataRoot.projectDir;
      await writeTelecomTower(dir);
      await openTiny(win);
      await measureControl(win, 'telecom-tool-clearance');
      const detect = win.getByTestId('detect-antennas');
      await expect(detect).toBeEnabled({ timeout: 60_000 });
      await detect.click();
      if (await processingChip(win).isVisible()) await evidence(win, 'h-job-running');
      const group = win.getByTestId('wb-section-project-antennas');
      const rows = group.getByTestId('antenna-row');
      await expect.poll(() => rows.count(), { timeout: 180_000 }).toBe(8);
      await expect(detect).toBeEnabled();

      // the second unit of the list: its name, id, centre and crop as they were detected
      const victim = rows.nth(1);
      const id = await victim.locator('xpath=..').getAttribute('data-row-id');
      const name = (await victim.locator('.antenna-name').textContent()) ?? '';
      expect(id).not.toBeNull();
      expect(name).not.toBe('');
      const before = await savedFile(dir);
      const unit = before.units.find((u) => u.id === id);
      if (!unit) throw new Error(`no unit ${id ?? ''} on disk`);
      const [cx, cy, cz] = unit.box.centre;
      const runBefore = before.run.id;

      await victim.getByTestId('antenna-row-delete').click();
      const dlg = win.getByTestId('antenna-delete-confirm');
      await expect(dlg).toBeVisible();
      await expect(dlg).toContainText(name);
      await evidence(win, 'i-delete-confirm');
      await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dlg).toHaveCount(0);
      await expect(rows).toHaveCount(7);
      await expect(group.locator(`[data-row-id="${id ?? ''}"]`)).toHaveCount(0);

      // gone from the inventory, its crop removed, and remembered in the sidecar
      await expect
        .poll(() => savedFile(dir).then((f) => f.units.some((u) => u.id === id)))
        .toBe(false);
      if (unit.crop) expect(await exists(join(dir, unit.crop))).toBe(false);
      const record = async () =>
        AntennaDeletionsFile.parse(
          JSON.parse(await readFile(join(dir, ANTENNA_DELETIONS_FILE), 'utf8')),
        );
      await expect.poll(() => record().then((f) => f.deletions.map((d) => d.unitId))).toEqual([id]);

      // a new detection run: the deleted unit is not found again
      await detect.click();
      await expect
        .poll(() => savedFile(dir).then((f) => f.run.id), { timeout: 180_000 })
        .not.toBe(runBefore);
      await expect(detect).toBeEnabled({ timeout: 60_000 });
      const after = await savedFile(dir);
      expect(after.units.length).toBe(7);
      const near = after.units.filter(
        (u) => Math.hypot(u.box.centre[0] - cx, u.box.centre[1] - cy, u.box.centre[2] - cz) < 0.3,
      );
      expect(near, 'no unit within 0.3 m of the deleted one').toEqual([]);
      expect((await record()).deletions.map((d) => d.unitId)).toEqual([id]);
      await expect(rows).toHaveCount(7);
      await evidence(win, 'j-after-rerun');
    });
  });
});
