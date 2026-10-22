/**
 * Antenna flagging in the real app: on the synthetic monopole (an inventory with no units yet)
 * the person outlines the radio unit `radio-180` on the cloud, the real `telecom.flag` job
 * measures it, a typed azimuth is set on it, and a detection re-run and a reload keep both.
 * The cloud has 2500 points per m2 because at the 1500 of `telecom-antennas.spec.ts` the radio's
 * faces are too thin to measure, flagged or detected; at 2500 detection finds it too, so this
 * spec cannot tell a re-run that absorbed the radio from one that missed it. Both paths are
 * pinned in python (`test_flagged_absorbs_a_new_unit_of_another_kind` and
 * `test_flagged_unmatched_is_not_flagged_missing` in `test_telecom_merge.py`,
 * `test_rerun_keeps_flagged_and_typed` in `test_telecom_flag_pipeline.py`). Reset to measured is
 * checked on the centre height, because an "other" unit has no measured azimuth.
 */
import type { EngineStage } from '@aio/engine';
import { AntennasFile, type AntennaUnit } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { PIPELINE_ENV, expect, hasPipelinePython, test } from './fixtures';
import { measureControl } from './island';
import { writeAntennaInventory, writeTelecomTower, type TowerTruthUnit } from './telecomFixtures';

type Vec3 = [number, number, number];

interface Inspect {
  __stratlas: { stage(): EngineStage | null };
}

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'needs the pipeline Python (uv sync --frozen in python/)');

/** Screenshots for a person to look at, only when AIO_EVIDENCE_DIR names a folder (never on CI). */
const EVIDENCE = process.env.AIO_EVIDENCE_DIR;

async function evidence(win: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await mkdir(EVIDENCE, { recursive: true });
  await win.screenshot({ path: join(EVIDENCE, `${name}.png`) });
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

const savedFile = async (dir: string) =>
  AntennasFile.parse(JSON.parse(await readFile(join(dir, 'telecom', 'antennas.json'), 'utf8')));

const flaggedUnit = async (dir: string): Promise<AntennaUnit | undefined> =>
  (await savedFile(dir).catch(() => null))?.units.find((u) => u.origin === 'flagged');

const sceneHas = (win: Page, name: string) =>
  win.evaluate(
    (n) => Boolean((window as unknown as Inspect).__stratlas.stage()?.scene.getObjectByName(n)),
    name,
  );

/**
 * A unit's (across, up, outward normal) in the local frame (x east, y up, z south), as
 * `unit_axes` in `antenna_synth.py` builds them: north is -z, azimuths turn clockwise from above.
 */
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

/** `p + q * k`. */
const add = (p: Vec3, q: Vec3, k: number): Vec3 => [
  p[0] + q[0] * k,
  p[1] + q[1] * k,
  p[2] + q[2] * k,
];

/** The 8 corners of a truth unit's box, local frame. */
function boxCorners(u: TowerTruthUnit): Vec3[] {
  const [a, b, n] = unitAxes(u);
  const out: Vec3[] = [];
  for (const sa of [-1, 1])
    for (const sb of [-1, 1])
      for (const sn of [-1, 1]) {
        const at = add(
          add(add(u.centre, a, (sa * u.widthM) / 2), b, (sb * u.heightM) / 2),
          n,
          (sn * u.depthM) / 2,
        );
        out.push(at);
      }
  return out;
}

/** Convex hull of 2D points (monotone chain), counter-clockwise in screen terms. */
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

test('flags an antenna on the cloud, types its values and keeps them through a re-run', async ({
  win,
  dataRoot,
}) => {
  test.setTimeout(420_000);
  const dir = dataRoot.projectDir;
  const truth = await writeTelecomTower(dir, 2500);
  await writeAntennaInventory(dir);
  const radio = truth.units.find((u) => u.name === 'radio-180');
  if (!radio) throw new Error('the synth has no radio-180');
  await openTiny(win);

  const detect = win.getByTestId('detect-antennas');
  // enabled once the cloud has loaded
  await expect(detect).toBeEnabled({ timeout: 60_000 });
  const panel = win.getByTestId('antenna-panel');
  await expect(win.getByTestId('antenna-flag')).toBeVisible();
  await expect(panel.getByTestId('antenna-row')).toHaveCount(0);

  // look at the radio unit from 3 m out along its face
  const [, , normal] = unitAxes(radio);
  const eye = add(radio.centre, normal, 3);
  await win.evaluate(
    ([position, target]) => {
      (window as unknown as Inspect).__stratlas.stage()?.restoreView({ position, target }, false);
    },
    [eye, radio.centre] as const,
  );

  await win.getByTestId('antenna-flag').click();
  await expect(win.getByTestId('antenna-flag-hint')).toBeVisible();

  // the truth box on screen (CSS px), from the stage camera
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
  }, boxCorners(radio));
  expect(screen, 'the stage is up').not.toBeNull();
  const outline = grow(hull(screen ?? []), 6);
  expect(outline.length).toBeGreaterThanOrEqual(3);
  for (const [x, y] of outline) await win.mouse.click(x, y);
  await evidence(win, 'a-flag-outline');
  await win.keyboard.press('Enter');

  const bar = win.getByTestId('antenna-flag-bar');
  await expect(bar).toBeVisible();
  const kept = Number((await bar.textContent())?.match(/(\d+) points kept/)?.[1] ?? 0);
  expect(kept, 'points kept inside the outline').toBeGreaterThan(0);
  await expect.poll(() => sceneHas(win, 'antenna-flag-points')).toBe(true);
  await evidence(win, 'b-flag-preview');
  await win.getByTestId('antenna-flag-confirm').click();
  await expect.poll(() => sceneHas(win, 'antenna-flag-points')).toBe(false);

  // the job measures it into the inventory: one row, flagged by you
  const rows = panel.getByTestId('antenna-row');
  await expect(rows.getByTestId('antenna-origin')).toHaveCount(1, { timeout: 180_000 });
  await expect.poll(() => flaggedUnit(dir).then((u) => u?.status)).toBe('accepted');
  const flagged = await flaggedUnit(dir);
  if (!flagged) throw new Error('no flagged unit on disk');
  // project ENZ is local (x, -z, y)
  const want: Vec3 = [radio.centre[0], -radio.centre[2], radio.centre[1]];
  const off = Math.hypot(...add(flagged.box.centre, want, -1));
  expect(off, 'the flagged box centre lies on the radio unit (m)').toBeLessThan(0.3);
  // measured, not the placeholder a too-thin outline gets
  expect(flagged.widthM?.basis).toBe('measured');
  expect(flagged.kind).toBe('other');

  // type the azimuth on its card
  const row = rows.filter({ has: win.getByTestId('antenna-origin') });
  const card = win.getByTestId('antenna-card');
  if (!(await card.isVisible())) await row.click();
  await expect(card).toBeVisible();
  const typed = card.getByTestId('antenna-typed');
  if ((await typed.getAttribute('open')) === null) await typed.locator('summary').click();
  const azInput = card.getByTestId('antenna-typed-azimuthGridDeg');
  await azInput.fill('271');
  await azInput.press('Enter');
  const azValue = card.locator('[data-value="azimuth"]');
  await expect(azValue).toHaveAttribute('data-basis', 'user');
  await expect
    .poll(() => flaggedUnit(dir).then((u) => u?.azimuthGridDeg))
    .toMatchObject({ value: 271, basis: 'user' });
  await evidence(win, 'c-flag-card');
  await expectAccessible(win, 'Antenna card', { include: '[data-testid="antenna-card"]' });
  await expectAccessible(win, 'Antenna inventory', { include: '[data-testid="antenna-panel"]' });

  // a detection re-run finds the 8 others and the radio again: the flagged unit stays, no twin
  await detect.click();
  await expect
    .poll(() => savedFile(dir).then((f) => f.run.id), { timeout: 180_000 })
    .not.toBe('run-e2e-empty');
  await panel.getByTestId('antenna-filter-all').click();
  await expect(rows).toHaveCount(9, { timeout: 60_000 });
  await expect(rows.getByTestId('antenna-origin')).toHaveCount(1);
  const after = await savedFile(dir);
  expect(after.units).toHaveLength(9);
  const kept1 = after.units.find((u) => u.origin === 'flagged');
  expect(kept1?.id).toBe(flagged.id);
  expect(kept1?.azimuthGridDeg).toMatchObject({ value: 271, basis: 'user' });
  expect(kept1?.widthM?.basis).toBe('measured');
  const near = after.units.filter(
    (u) => Math.hypot(...add(u.box.centre, flagged.box.centre, -1)) < 0.3,
  );
  expect(near.map((u) => u.id)).toEqual([flagged.id]);

  // and a reload reads both back
  await win.reload();
  await expect(
    win.locator('[data-testid="project-card"], [data-scene-view] canvas').first(),
  ).toBeVisible();
  if (await win.getByTestId('project-card').first().isVisible()) await openTiny(win);
  else await openTelecom(win);
  const panel2 = win.getByTestId('antenna-panel');
  await panel2.getByTestId('antenna-filter-all').click();
  const rows2 = panel2.getByTestId('antenna-row');
  await expect(rows2).toHaveCount(9);
  const row2 = rows2.filter({ has: win.getByTestId('antenna-origin') });
  await expect(row2).toHaveCount(1);
  await row2.click();
  const card2 = win.getByTestId('antenna-card');
  await expect(card2).toBeVisible();
  await expect(card2.locator('[data-value="azimuth"]')).toHaveAttribute('data-basis', 'user');

  // an "other" unit has no measured azimuth to go back to; its measured centre height has: a
  // typed one replaces it, and Reset to measured brings it back
  const typed2 = card2.getByTestId('antenna-typed');
  if ((await typed2.getAttribute('open')) === null) await typed2.locator('summary').click();
  await expect(card2.getByTestId('antenna-typed-reset-azimuthGridDeg')).toHaveCount(0);
  const altitude = card2.locator('[data-value="altitude"]');
  const centre = card2.getByTestId('antenna-typed-centreHeightM');
  await centre.fill((flagged.box.centre[2] + 0.5).toFixed(2));
  await centre.press('Enter');
  await expect(altitude).toHaveAttribute('data-basis', 'user');
  await expect
    .poll(() => flaggedUnit(dir).then((u) => u?.measured?.centreHeightM?.basis))
    .toBe('measured');
  await evidence(win, 'd-flag-card-typed-centre');
  await card2.getByTestId('antenna-typed-reset-centreHeightM').click();
  await expect(altitude).not.toHaveAttribute('data-basis', 'user');
  await expect.poll(() => flaggedUnit(dir).then((u) => u?.centreHeightM?.basis)).not.toBe('user');
  const reset = await flaggedUnit(dir);
  expect(reset?.centreHeightM?.value).toBeCloseTo(flagged.box.centre[2], 2);
  expect(reset?.measured?.centreHeightM).toBeUndefined();
  // the typed azimuth stays the person's
  expect(reset?.azimuthGridDeg).toMatchObject({ value: 271, basis: 'user' });
});
