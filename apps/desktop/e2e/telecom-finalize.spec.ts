/**
 * The telecom section as finalized (plan 2026-11-22-telecom-finalize, section 4 "e2e specs" and
 * the founder's test list in section 5), in the real app at the CI size:
 *
 * - without the pipeline, on the synthetic RF inventory (`rfFixtures.ts`: three accepted panels
 *   and a draft on a small tower cloud): the review rule from the four routes, a failed delete's
 *   reason in the Antennas group, Open in Coverage on an antenna, a delete undone with its photo
 *   crop, its sector place and its RF settings, Redraw outline from a folded group, the kind
 *   picker and a dish's one diameter label;
 * - with the pipeline (the development venv, as `telecom-antennas.spec.ts` runs its job): Detect
 *   antennas from the empty list, a coverage run with one run button, the Coverage plan group's
 *   count and the plan-changed line after a save and a reopen, and a flag on a survey date lined
 *   up with a turn.
 *
 * All data is synthetic; nothing here reads a real project.
 */
import type { EngineStage } from '@aio/engine';
import {
  ANTENNA_DELETIONS_FILE,
  AntennaDeletionsFile,
  AntennasFile,
  ProjectManifest,
  RfSectorsFile,
  captureLineUpShift,
  shiftLocal,
  type AntennaUnit,
} from '@aio/schema';
import type { Locator, Page } from '@playwright/test';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { PIPELINE_ENV, expect, hasPipelinePython, test } from './fixtures';
import { measureControl } from './island';
import { expectBench, openSection, panelTab } from './panel';
import { RF_DRAFT, RF_PANELS, readRfSectors, rfAntennas, writeRfProject } from './rfFixtures';
import {
  projectAntennas,
  writeAntennaInventory,
  writeTelecomTower,
  type TowerTruthUnit,
} from './telecomFixtures';

type Vec3 = [number, number, number];

interface Inspect {
  __stratlas: {
    stage(): EngineStage | null;
    workbench: { getState(): { open(id: string): void } };
    antennas: {
      setState(patch: Record<string, unknown>): void;
      getState(): { selected: string | null; flagging: { unit: string | null } | null };
    };
  };
}

/**
 * Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI);
 * the assertions never depend on them.
 */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `telecom-finalize-${name}.png`) });
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

const unitOnDisk = (dir: string, id: string) =>
  savedFile(dir)
    .then((f) => f.units.find((u) => u.id === id))
    .catch(() => undefined);

const statusOnDisk = (dir: string, id: string) => unitOnDisk(dir, id).then((u) => u?.status);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** The row of a unit in the group, by its id. */
const rowOf = (group: Locator, id: string) =>
  group.locator(`[data-row-id="${id}"] [data-testid="antenna-row"]`);

/** Select a unit through the store, with every unit listed (the details open under its row). */
const selectUnit = (win: Page, id: string | null) =>
  win.evaluate((unit) => {
    (window as unknown as Inspect).__stratlas.antennas.setState(
      unit === null ? { selected: null } : { selected: unit, filter: 'all' },
    );
  }, id);

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

/** Look at the RF fixture's crown from a few metres out; `labelsOff` so nothing lies on a box. */
async function viewTower(win: Page, labelsOff = true): Promise<void> {
  await expect(win.getByTestId('antenna-labels-control')).toBeVisible({ timeout: 30_000 });
  if (labelsOff)
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

/** Tick a row's box with the mouse, where it is drawn (clear of the panel handle). */
async function tick(row: Locator): Promise<void> {
  const box = row.locator('input.antenna-tick');
  await box.scrollIntoViewIfNeeded();
  const free = await box.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === el;
  });
  expect(free, 'the tick takes the click where it is drawn').toBe(true);
  await box.click();
  await expect(box).toBeChecked();
}

/** A small JPEG as a detection's photo crop would be. */
async function writeCrop(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await sharp({ create: { width: 64, height: 96, channels: 3, background: '#4a7fb0' } })
    .jpeg()
    .toFile(path);
}

/** The RF fixture with its own inventory (cloud and Telecom towers type as `writeRfProject`). */
async function writeRfInventory(dir: string, units: AntennaUnit[]): Promise<void> {
  await writeRfProject(dir, { cloud: true });
  const file = rfAntennas();
  await writeFile(
    join(dir, 'telecom', 'antennas.json'),
    JSON.stringify(AntennasFile.parse({ ...file, units })),
  );
}

test.describe('telecom finalized: the antenna list', () => {
  test('Accept twice from each route: the first press accepts, the second returns to Draft', async ({
    win,
    dataRoot,
  }) => {
    const dir = dataRoot.projectDir;
    await writeRfProject(dir, { cloud: true, allDraft: true });
    await openTiny(win);
    const group = await projectAntennas(win);
    await group.getByTestId('antenna-filter-all').click();
    const status = (id: string) => rowOf(group, id).getAttribute('data-status');
    /** The unit reads `want` in its row and on disk. */
    const expectStatus = async (id: string, want: 'accepted' | 'draft') => {
      await expect(rowOf(group, id)).toHaveAttribute('data-status', want);
      await expect.poll(() => statusOnDisk(dir, id)).toBe(want);
    };
    const details = win.getByTestId('antenna-details');

    // 1. the details' Accept button
    const [p1, p2, p3] = RF_PANELS;
    for (const want of ['accepted', 'draft'] as const) {
      await selectUnit(win, p1);
      await expect(rowOf(group, p1)).toHaveAttribute('aria-selected', 'true');
      await details.getByTestId('antenna-details-accept').click();
      await expectStatus(p1, want);
    }

    // 2. the A key, with the unit selected and its row in focus
    for (const want of ['accepted', 'draft'] as const) {
      await selectUnit(win, p2);
      await expect(rowOf(group, p2)).toHaveAttribute('aria-selected', 'true');
      await rowOf(group, p2).focus();
      await win.keyboard.press('a');
      await expectStatus(p2, want);
    }

    // 3. the bulk bar, on two ticked units
    await selectUnit(win, null);
    const bulk = win.getByTestId('antenna-bulk');
    for (const want of ['accepted', 'draft'] as const) {
      await tick(rowOf(group, p3));
      await tick(rowOf(group, RF_DRAFT));
      await expect(bulk).toContainText('2');
      await bulk.getByTestId('antenna-bulk-accept').click();
      await expectStatus(p3, want);
      await expectStatus(RF_DRAFT, want);
      if (await bulk.isVisible()) await bulk.getByTestId('antenna-bulk-clear').click();
      await expect(bulk).toHaveCount(0);
    }
    await evidence(win, 'a-bulk-twice');

    // 4. the right-click menu on a row
    const menu = win.getByTestId('antenna-menu');
    for (const want of ['accepted', 'draft'] as const) {
      await rowOf(group, p1).locator('.antenna-name').click({ button: 'right' });
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: 'Accept', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await expectStatus(p1, want);
    }
    // every unit ends where it started
    for (const id of [...RF_PANELS, RF_DRAFT]) expect(await status(id)).toBe('draft');
  });

  test('a failed delete says why in the Antennas group, where it was asked', async ({
    win,
    dataRoot,
  }) => {
    const dir = dataRoot.projectDir;
    await writeRfProject(dir, { cloud: true });
    await openTiny(win);
    const group = await projectAntennas(win);
    await group.getByTestId('antenna-filter-all').click();
    await expect(group.getByTestId('antenna-group-message')).toHaveCount(0);
    // the inventory cannot be written any more (read-only on disk): the delete must fail
    const file = join(dir, 'telecom', 'antennas.json');
    await chmod(file, 0o444);
    try {
      await rowOf(group, 'ant-p2').getByTestId('antenna-row-delete').click();
      const dlg = win.getByTestId('antenna-delete-confirm');
      await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dlg).toHaveCount(0);
      const message = group.getByTestId('antenna-group-message');
      await expect(message).toBeVisible();
      await expect(message).toContainText('not deleted');
      await evidence(win, 'b-failed-delete-message');
      // the unit is still listed and still on disk
      await expect(rowOf(group, 'ant-p2')).toHaveCount(1);
      expect(await unitOnDisk(dir, 'ant-p2')).toBeDefined();
    } finally {
      await chmod(file, 0o666);
    }
  });

  test('Open in Coverage on an antenna opens Coverage on that unit', async ({ win, dataRoot }) => {
    await writeRfProject(dataRoot.projectDir, { cloud: true });
    await openTiny(win);
    const group = await projectAntennas(win);
    await group.getByTestId('antenna-filter-all').click();
    await rowOf(group, 'ant-p2').locator('.antenna-name').click({ button: 'right' });
    const menu = win.getByTestId('antenna-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Open in Coverage', exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expectBench(win, 'rf');
    const bench = win.locator('.rf-bench');
    await expect(bench).toBeVisible();
    // the unit's own settings are open in step 2
    await expect(bench.getByTestId('rf-unit-ant-p2')).toBeVisible({ timeout: 30_000 });
    await expect(bench.locator('[data-testid^="rf-unit-"]')).toHaveCount(1);
    await evidence(win, 'c-open-in-coverage');
  });

  test('a delete undone brings the unit back with its crop, its sector and its RF settings', async ({
    win,
    dataRoot,
  }) => {
    const dir = dataRoot.projectDir;
    const crop = 'telecom/crops/ant-p2.jpg';
    const units = rfAntennas().units.map((u) => (u.id === 'ant-p2' ? { ...u, crop } : u));
    await writeRfInventory(dir, units);
    await writeCrop(join(dir, crop));
    const settings = {
      antennaId: 'ant-p2',
      equipment: { kind: 'aau', aau: 'generic-aau-64t64r-n78' },
      etiltDeg: 4,
      active: true,
      carriers: [{ id: 'c1', tech: 'nr', band: 'n78', bandwidthMhz: 100, feederLossDb: 0 }],
    };
    await mkdir(join(dir, 'rf'), { recursive: true });
    await writeFile(
      join(dir, 'rf', 'sectors.json'),
      JSON.stringify(
        RfSectorsFile.parse({
          schema: 'aio.rf-sectors/1',
          sectors: [{ id: 'sec-alpha', name: 'Alpha', antennaIds: ['ant-p1', 'ant-p2'] }],
          antennas: [settings],
          study: {},
        }),
      ),
    );
    await openTiny(win);
    const group = await projectAntennas(win);
    await group.getByTestId('antenna-filter-all').click();
    const shown = win.getByTestId('antenna-details').getByTestId('antenna-crop');
    const cropLoaded = () =>
      shown.evaluate(
        (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth,
      );
    await selectUnit(win, 'ant-p2');
    await expect(shown).toBeVisible();
    await expect.poll(cropLoaded).toBe(64);

    // delete from the details, confirmed
    await win.getByTestId('antenna-details').getByTestId('antenna-details-delete').click();
    const dlg = win.getByTestId('antenna-delete-confirm');
    await expect(win.getByTestId('antenna-delete-sector')).toContainText('Alpha');
    await dlg.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    await expect(rowOf(group, 'ant-p2')).toHaveCount(0);
    await expect.poll(() => unitOnDisk(dir, 'ant-p2')).toBeUndefined();
    await expect.poll(() => exists(join(dir, crop))).toBe(false);
    const record = async () =>
      AntennaDeletionsFile.parse(
        JSON.parse(await readFile(join(dir, ANTENNA_DELETIONS_FILE), 'utf8')),
      ).deletions.map((d) => d.unitId);
    await expect.poll(() => record().catch(() => null)).toEqual(['ant-p2']);
    await expect
      .poll(() => readRfSectors(dir).then((f) => f?.sectors[0]?.antennaIds))
      .toEqual(['ant-p1']);
    await expect
      .poll(() => readRfSectors(dir).then((f) => f?.antennas.map((a) => a.antennaId)))
      .toEqual([]);

    // the Undo notice names the unit; Undo brings everything back
    const notice = win.getByTestId('antenna-undo');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('P2 deleted');
    await evidence(win, 'd-undo-notice');
    await win.getByTestId('antenna-undo-button').click();
    await expect(rowOf(group, 'ant-p2')).toHaveCount(1);
    await expect.poll(() => unitOnDisk(dir, 'ant-p2').then((u) => u?.crop)).toBe(crop);
    await expect.poll(() => exists(join(dir, crop))).toBe(true);
    await expect.poll(() => record().catch(() => [])).toEqual([]);
    await expect
      .poll(() => readRfSectors(dir).then((f) => [...(f?.sectors[0]?.antennaIds ?? [])].sort()))
      .toEqual(['ant-p1', 'ant-p2']);
    await expect
      .poll(() => readRfSectors(dir).then((f) => f?.antennas.find((a) => a.antennaId === 'ant-p2')))
      .toMatchObject({ equipment: settings.equipment, etiltDeg: 4 });
    // and the row shows the crop again
    await selectUnit(win, 'ant-p2');
    await expect(rowOf(group, 'ant-p2')).toHaveAttribute('aria-selected', 'true');
    await expect(shown).toBeVisible();
    await expect.poll(cropLoaded).toBe(64);
    await evidence(win, 'e-undone-with-crop');
  });

  test('Redraw outline from 3D with the group folded opens the group and can be cancelled', async ({
    win,
    dataRoot,
  }) => {
    await writeRfProject(dataRoot.projectDir, { cloud: true });
    await openTiny(win);
    const group = await projectAntennas(win);
    const head = group.locator('.wb-section-head').first();
    await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await viewTower(win);
    const at = await boxOnScreen(win, 'ant-p2');
    expect(at.free, 'nothing but the 3D view lies on the box').toBe(true);
    await win.mouse.click(at.x, at.y, { button: 'right' });
    const menu = win.getByTestId('antenna-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Redraw outline', exact: true }).click();
    await expect(menu).toHaveCount(0);
    // the group opens and shows the tool, so it can be left
    await expect(panelTab(win, 'project')).toHaveAttribute('aria-selected', 'true');
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    const hint = win.getByTestId('antenna-flag-hint');
    await expect(hint).toBeVisible();
    await expect
      .poll(() =>
        win.evaluate(() => (window as unknown as Inspect).__stratlas.antennas.getState().flagging),
      )
      .toEqual({ unit: 'ant-p2' });
    await evidence(win, 'f-redraw-from-folded');
    await win.getByTestId('antenna-flag-cancel').click();
    await expect(hint).toHaveCount(0);
    await expect
      .poll(() =>
        win.evaluate(() => (window as unknown as Inspect).__stratlas.antennas.getState().flagging),
      )
      .toBeNull();
    // the unit is as it was
    await expect(rowOf(group, 'ant-p2')).toHaveCount(1);
  });

  test('the kind picker changes the kind as entered by you', async ({ win, dataRoot }) => {
    const dir = dataRoot.projectDir;
    await writeRfProject(dir, { cloud: true });
    await openTiny(win);
    await projectAntennas(win);
    await selectUnit(win, 'ant-p3');
    const details = win.getByTestId('antenna-details');
    const pick = details.getByTestId('antenna-details-kind-pick');
    await expect(pick).toHaveValue('panel');
    await expect(details.getByTestId('antenna-details-kind-basis')).toContainText('from geometry');
    await pick.selectOption('short');
    await expect
      .poll(() => unitOnDisk(dir, 'ant-p3').then((u) => [u?.kind, u?.kindBasis]))
      .toEqual(['short', 'user']);
    await expect(details.getByTestId('antenna-details-kind-basis')).toContainText('entered by you');
    await expect(pick).toHaveValue('short');
    // and a reopen reads it back
    await reopenTiny(win);
    await projectAntennas(win);
    await selectUnit(win, 'ant-p3');
    await expect(win.getByTestId('antenna-details-kind-pick')).toHaveValue('short');
  });

  test('a selected dish shows one diameter label, no width, height or depth', async ({
    win,
    dataRoot,
  }) => {
    const dir = dataRoot.projectDir;
    const measured = (value: number) => ({ value, basis: 'measured' as const });
    const units = rfAntennas().units.map((u): AntennaUnit => {
      if (u.id !== RF_DRAFT) return u;
      return {
        ...u,
        kind: 'dish',
        box: { ...u.box, extents: [0.3, 0.3, 0.2] },
        widthM: measured(0.6),
        heightM: measured(0.6),
        depthM: measured(0.4),
        elevationDeg: measured(1),
        diameterM: measured(0.6),
      };
    });
    await writeRfInventory(dir, units);
    await openTiny(win);
    await projectAntennas(win);
    await viewTower(win, false);
    await win
      .getByTestId('antenna-labels-control')
      .getByRole('button', { name: 'Selected', exact: true })
      .click();
    await selectUnit(win, RF_DRAFT);
    const dims = win.locator(`.antenna-labels .sv-label[data-key^="${RF_DRAFT}:dim:"]`);
    await expect(dims).toHaveCount(1);
    await expect(dims.first()).toHaveAttribute('data-key', `${RF_DRAFT}:dim:diameter`);
    await expect(dims.first()).toHaveText('Diameter 0.60 m');
    // a panel keeps its three
    await selectUnit(win, 'ant-p1');
    await expect(win.locator('.antenna-labels .sv-label[data-key^="ant-p1:dim:"]')).toHaveCount(3);
    await expect(dims).toHaveCount(0);
    await evidence(win, 'g-panel-dims');
  });
});

/** The finished runs on disk (`rf/runs/<id>/run.json`, status done), oldest first. */
async function doneRuns(projectDir: string): Promise<string[]> {
  const root = join(projectDir, 'rf', 'runs');
  const ids = await readdir(root).catch(() => [] as string[]);
  const done: { id: string; at: string }[] = [];
  for (const id of ids) {
    const run = (await readFile(join(root, id, 'run.json'), 'utf8')
      .then((s) => JSON.parse(s) as { status?: string; createdAt?: string })
      .catch(() => null)) ?? { status: undefined };
    if (run.status === 'failed') throw new Error(`rf.coverage run ${id} failed`);
    if (run.status === 'done') done.push({ id, at: run.createdAt ?? '' });
  }
  return done.sort((a, b) => a.at.localeCompare(b.at)).map((d) => d.id);
}

/** The Coverage tab, opened as the stage chip does, and its bench. */
async function openCoverage(win: Page): Promise<Locator> {
  await win.evaluate(() => {
    (window as unknown as Inspect).__stratlas.workbench.getState().open('rf');
  });
  await expectBench(win, 'rf');
  const bench = win.locator('.rf-bench');
  await expect(bench).toBeVisible();
  return bench;
}

/** A unit's (across, up, outward normal) in the local frame, as `antenna_synth.py` builds them. */
function unitAxes(u: TowerTruthUnit): [Vec3, Vec3, Vec3] {
  const rot = (v: Vec3, deg: number): Vec3 => {
    const t = (deg * Math.PI) / 180;
    return [v[0] * Math.cos(t) - v[2] * Math.sin(t), v[1], v[0] * Math.sin(t) + v[2] * Math.cos(t)];
  };
  const lin = (p: Vec3, q: Vec3, a: number, b: number): Vec3 => [
    p[0] * a + q[0] * b,
    p[1] * a + q[1] * b,
    p[2] * a + q[2] * b,
  ];
  const d = ((u.downtiltDeg ?? 0) * Math.PI) / 180;
  const p = ((u.plumbDeg ?? 0) * Math.PI) / 180;
  let across: Vec3 = [1, 0, 0];
  let up: Vec3 = [0, 1, 0];
  let normal: Vec3 = [0, 0, -1];
  [normal, up] = [
    lin(normal, up, Math.cos(d), -Math.sin(d)),
    lin(up, normal, Math.cos(d), Math.sin(d)),
  ];
  [up, across] = [
    lin(up, across, Math.cos(p), -Math.sin(p)),
    lin(across, up, Math.cos(p), Math.sin(p)),
  ];
  return [rot(across, u.azimuthDeg), rot(up, u.azimuthDeg), rot(normal, u.azimuthDeg)];
}

const add = (p: Vec3, q: Vec3, k: number): Vec3 => [
  p[0] + q[0] * k,
  p[1] + q[1] * k,
  p[2] + q[2] * k,
];

function boxCorners(u: TowerTruthUnit): Vec3[] {
  const [a, b, n] = unitAxes(u);
  const out: Vec3[] = [];
  for (const sa of [-1, 1])
    for (const sb of [-1, 1])
      for (const sn of [-1, 1])
        out.push(
          add(
            add(add(u.centre, a, (sa * u.widthM) / 2), b, (sb * u.heightM) / 2),
            n,
            (sn * u.depthM) / 2,
          ),
        );
  return out;
}

/** Convex hull of 2D points (monotone chain). */
function hull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list: [number, number][]) => {
    const out: [number, number][] = [];
    for (const p of list) {
      for (;;) {
        const [o, a] = out.slice(-2);
        if (!o || !a || cross(o, a, p) > 0) break;
        out.pop();
      }
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...chain(pts), ...chain([...pts].reverse())];
}

/** Each hull vertex moved `px` further out from the hull's middle. */
function grow(poly: [number, number][], px: number): [number, number][] {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const len = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / len) * px, y + ((y - cy) / len) * px];
  });
}

test.describe('telecom finalized: with the pipeline', () => {
  test.use({ appEnv: PIPELINE_ENV });
  test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

  test('the empty Antennas list offers Detect antennas, and it fills the list', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(300_000);
    await writeTelecomTower(dataRoot.projectDir);
    await openTiny(win);
    const group = await projectAntennas(win);
    await expect(group).toContainText('No antennas yet');
    const detect = group.getByTestId('antenna-empty-detect');
    await expect(detect).toBeVisible();
    await expect(detect).toBeEnabled({ timeout: 60_000 });
    await evidence(win, 'h-empty-list-detect');
    await detect.click();
    // seed 3: the 8 antennas of the synthetic monopole (as telecom-antennas.spec.ts)
    const rows = win.getByTestId('antenna-panel').getByTestId('antenna-row');
    await expect.poll(() => rows.count(), { timeout: 180_000 }).toBe(8);
    await expect(group.getByTestId('antenna-empty-detect')).toHaveCount(0);
    expect((await savedFile(dataRoot.projectDir)).units).toHaveLength(8);
    // the same tool stays in Tools > Measure > Telecom
    await measureControl(win, 'telecom-tool-clearance');
    await expect(win.getByTestId('detect-antennas')).toBeEnabled({ timeout: 60_000 });
  });

  test('coverage: one run button, the plan group counts the run, the plan changed after a save and a reopen', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(420_000);
    const dir = dataRoot.projectDir;
    await writeRfProject(dir, { cloud: true });
    await openTiny(win);
    let bench = await openCoverage(win);
    // a small study keeps the job short: 1 km at 20 m
    const head = bench.getByTestId('rf-advanced');
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
    const study = bench.getByTestId('rf-study');
    for (const [name, value] of [
      ['Radius', '1000'],
      ['Grid', '20'],
    ] as const) {
      await study.getByRole('spinbutton', { name, exact: true }).fill(value);
      await study.getByRole('spinbutton', { name, exact: true }).press('Enter');
    }
    // the rules' plan, Apply and run (no AI provider in a test run)
    const chip = win.getByTestId('rf-chip');
    await chip.getByTestId('rf-chip-autoplan').click();
    const dlg = win.getByTestId('rf-autoplan');
    await expect(dlg).toHaveAttribute('data-phase', 'review');
    await dlg.getByTestId('rf-autoplan-apply-run').click();
    await expect(dlg).toBeHidden();
    await expect.poll(() => doneRuns(dir), { timeout: 240_000 }).toHaveLength(1);

    // step 3 has one run button, and nothing changed since the run
    const run = bench.getByTestId('rf-run');
    await expect(run).toHaveText('Run coverage', { timeout: 30_000 });
    await expect(run).toHaveCount(1);
    await expect(bench.getByRole('button', { name: 'Save as new run' })).toHaveCount(0);
    await expect(bench.getByTestId('rf-plan-changed')).toHaveCount(0);
    await expect(chip).not.toContainText('plan changed since this run');

    // Project > Coverage plan counts the finished run
    await openSection(win, 'project', 'project.inThisProject');
    const plan = win.getByTestId('wb-section-project-coverage');
    await expect(plan.locator('.wb-section-count')).toHaveText('1');
    await evidence(win, 'i-coverage-plan-count');

    // change a power and Save
    bench = await openCoverage(win);
    const rows = bench.locator('[data-testid^="rf-step-sector-sec-"]');
    await expect(rows.first()).toBeVisible();
    const rowHead = rows.first().locator('.rf-step-row-head');
    if ((await rowHead.getAttribute('aria-expanded')) !== 'true') await rowHead.click();
    const power = bench.locator('[data-testid^="rf-unit-"]').getByTestId('rf-power');
    await power.fill('40');
    await power.press('Enter');
    await bench.getByTestId('rf-save').click();
    await expect
      .poll(() =>
        readRfSectors(dir).then((f) =>
          f?.antennas.some((a) => a.carriers.some((c) => c.powerDbmPerPort === 40)),
        ),
      )
      .toBe(true);
    await expect(bench.getByTestId('rf-plan-changed')).toHaveText(
      'The plan changed since this run. Run coverage again to see it.',
    );
    await expect(chip).toContainText('plan changed since this run');

    // close and open the project again: step 3 and the stage chip still say so
    await reopenTiny(win);
    bench = await openCoverage(win);
    await expect(bench.getByTestId('rf-plan-changed')).toHaveText(
      'The plan changed since this run. Run coverage again to see it.',
      { timeout: 30_000 },
    );
    await expect(win.getByTestId('rf-chip')).toContainText('plan changed since this run', {
      timeout: 30_000,
    });
    await expect(bench.getByTestId('rf-run')).toHaveCount(1);
    await openSection(win, 'project', 'project.inThisProject');
    await expect(
      win.getByTestId('wb-section-project-coverage').locator('.wb-section-count'),
    ).toHaveText('1');
    await evidence(win, 'j-plan-changed-after-reopen');
  });

  test('flag antenna on a survey date lined up with a turn: measured where the view draws it, the box drawn turned', async ({
    win,
    dataRoot,
  }) => {
    test.setTimeout(420_000);
    const dir = dataRoot.projectDir;
    const truth = await writeTelecomTower(dir, 2500);
    // the cloud is the later date, lined up with a shift and a 2 degree turn about a pivot 40 m
    // west of the tower: the view draws it turned (about 1.4 m at the crown)
    const file = join(dir, 'manifest.json');
    const manifest = ProjectManifest.parse(JSON.parse(await readFile(file, 'utf8')));
    const later = {
      id: 'later',
      label: 'Later survey',
      date: '2026-06-01',
      lineUp: { eastM: 0.5, northM: 0, with: 'capture-1', at: '2026-06-02T09:00:00Z' },
      lineUpTurn: { rotationDeg: 2, scale: 1, pivotE: -40, pivotN: 0 },
    };
    const turned = ProjectManifest.parse({
      ...manifest,
      captures: [...manifest.captures, later],
      layers: manifest.layers.map((l) => (l.id === 'tower-cloud' ? { ...l, capture: 'later' } : l)),
    });
    await writeFile(file, JSON.stringify(turned));
    await writeAntennaInventory(dir, 'later');
    const capture = turned.captures.find((c) => c.id === 'later');
    if (!capture) throw new Error('no later capture');
    const shift = captureLineUpShift(capture, turned.origin);
    expect(shift?.turn?.rotationDeg).toBe(2);
    const drawn = (p: Vec3): Vec3 => shiftLocal(p, shift);
    const radio = truth.units.find((u) => u.name === 'radio-180');
    if (!radio) throw new Error('the synth has no radio-180');

    await openTiny(win);
    await measureControl(win, 'telecom-tool-clearance');
    await expect(win.getByTestId('detect-antennas')).toBeEnabled({ timeout: 60_000 });
    const group = await projectAntennas(win);
    await expect(group.getByTestId('antenna-row')).toHaveCount(0);

    // look at the radio where the view draws it, from 3 m out along its face
    const [, , normal] = unitAxes(radio);
    await win.evaluate(
      ([position, target]) => {
        (window as unknown as Inspect).__stratlas.stage()?.restoreView({ position, target }, false);
      },
      [drawn(add(radio.centre, normal, 3)), drawn(radio.centre)] as const,
    );
    await group.getByTestId('antenna-flag').click();
    await expect(win.getByTestId('antenna-flag-hint')).toBeVisible();
    const screen = await win.evaluate((corners) => {
      const stage = (window as unknown as Inspect).__stratlas.stage();
      if (!stage) return null;
      const cam = stage.camera;
      cam.updateMatrixWorld();
      const r = stage.renderer.domElement.getBoundingClientRect();
      return corners.map(([x, y, z]): [number, number] => {
        const v = cam.position.clone().set(x, y, z).project(cam);
        return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
      });
    }, boxCorners(radio).map(drawn));
    expect(screen, 'the stage is up').not.toBeNull();
    const outline = grow(hull(screen ?? []), 6);
    for (const [x, y] of outline) await win.mouse.click(x, y);
    await win.keyboard.press('Enter');
    const bar = win.getByTestId('antenna-flag-bar');
    await expect(bar).toBeVisible();
    const kept = Number((await bar.textContent())?.match(/(\d+) points kept/)?.[1] ?? 0);
    expect(kept, 'points kept inside the outline').toBeGreaterThan(100);
    await evidence(win, 'k-turned-flag-preview');
    await win.getByTestId('antenna-flag-confirm').click();

    const rows = group.getByTestId('antenna-row');
    await expect(rows).toHaveCount(1, { timeout: 180_000 });
    await expect
      .poll(async () => (await savedFile(dir)).units.find((u) => u.origin === 'flagged')?.status)
      .toBe('accepted');
    const flagged = (await savedFile(dir)).units.find((u) => u.origin === 'flagged');
    if (!flagged) throw new Error('no flagged unit on disk');
    // stored in the date's own frame: where the radio is in the file (project ENZ = local x, -z, y)
    const want: Vec3 = [radio.centre[0], -radio.centre[2], radio.centre[1]];
    const off = Math.hypot(...add(flagged.box.centre, want, -1));
    expect(off, 'the flagged box centre lies on the radio in the file (m)').toBeLessThan(0.3);
    expect(flagged.widthM?.basis, 'measured, not a placeholder').toBe('measured');
    expect(flagged.support).toBeGreaterThan(100);

    // drawn turned with its cloud: at the drawn radio, its axes turned by the date's turn
    const box = await win.evaluate((id) => {
      const mesh = (window as unknown as Inspect).__stratlas
        .stage()
        ?.scene.getObjectByName(`antenna-box:${id}`);
      if (!mesh) return null;
      mesh.updateWorldMatrix(true, false);
      const e = mesh.matrixWorld.elements;
      const col = (k: number): Vec3 => {
        const v: Vec3 = [e[4 * k] ?? 0, e[4 * k + 1] ?? 0, e[4 * k + 2] ?? 0];
        const n = Math.hypot(...v) || 1;
        return [v[0] / n, v[1] / n, v[2] / n];
      };
      return { at: [e[12], e[13], e[14]] as Vec3, axes: [col(0), col(1), col(2)] };
    }, flagged.id);
    expect(box, 'the flagged unit is drawn').not.toBeNull();
    const c = flagged.box.centre;
    const local: Vec3 = [c[0], c[2], -c[1]];
    const at = drawn(local);
    expect(
      Math.hypot(...add(box?.at ?? [0, 0, 0], at, -1)),
      'drawn at the turned place (m)',
    ).toBeLessThan(0.05);
    const deg = (p: Vec3, q: Vec3) =>
      (Math.acos(Math.min(1, Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2]))) * 180) / Math.PI;
    for (const [k, a] of flagged.box.axes.entries()) {
      const stored: Vec3 = [a[0], a[2], -a[1]];
      const tip = drawn(add(local, stored, 1));
      const turnedAxis = add(tip, at, -1);
      const n = Math.hypot(...turnedAxis) || 1;
      const expected: Vec3 = [turnedAxis[0] / n, turnedAxis[1] / n, turnedAxis[2] / n];
      const drawnAxis = box?.axes[k] ?? [0, 0, 0];
      expect(deg(drawnAxis, expected), `axis ${String(k)} is turned with the date`).toBeLessThan(
        0.2,
      );
      // a horizontal axis is visibly turned against the stored one
      if (Math.abs(stored[1]) < 0.3)
        expect(deg(drawnAxis, stored), `axis ${String(k)} differs by the turn`).toBeGreaterThan(
          1.5,
        );
    }
    await evidence(win, 'l-turned-flag-done');
  });
});
