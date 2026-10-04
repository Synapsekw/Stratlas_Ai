/**
 * Al-Zour guided orientation calibration on a copy of the real project, outside the CI suite
 * (client data never enters git). Needs:
 *   STRATLAS_A1_DATA=<data root holding projects/alzour, a copy: the test saves into it>
 *   STRATLAS_A1_PLAN=<plan.json>  STRATLAS_A1_OUT=<folder for screenshots>
 *
 * The plan names a clip, a frame time with point pairs to fit (normalised frame point and the
 * feature's E N H, typed into the panel) and a second frame time with held-out pairs:
 *   { "clip": "DJI_0665", "fit": { "t": 20, "pairs": [{ "image": [u, v], "enh": [E, N, H] }] },
 *     "heldOut": { "t": 45, "pairs": [...] }, "tag": "guided", "save": true, "shotsOnly": false }
 *
 * Steps: a tank-rim view of the projected video (before); the held-out pairs' errors with the
 * saved calibration; the guided fit (orientation and position) from the fit pairs; the held-out
 * errors again; save to the clips of the flight; the tank-rim view again (after). Errors are
 * printed and must drop.
 */
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_ENTRY } from './fixtures';

const DATA = process.env.STRATLAS_A1_DATA ?? '';
const PLAN = process.env.STRATLAS_A1_PLAN ?? '';
const OUT = process.env.STRATLAS_A1_OUT ?? '';
test.skip(!DATA || !PLAN || !OUT, 'Al-Zour orientation: set STRATLAS_A1_DATA, _PLAN and _OUT');
test.setTimeout(600_000);

interface Pair {
  image: [number, number];
  enh: [number, number, number];
}
interface Plan {
  clip: string;
  fit: { t: number; pairs: Pair[] };
  heldOut: { t: number; pairs: Pair[] };
  tag?: string;
  save?: boolean;
  shotsOnly?: boolean;
}

interface Hooks {
  __stratlas: {
    workspace: {
      getState: () => {
        project: {
          manifest: {
            layers: {
              id: string;
              kind: string;
              offsetMs?: number;
              flight?: { startUtcMs: number };
            }[];
          };
        } | null;
        setActiveClip: (id: string) => void;
        setTime: (ms: number) => void;
        pause: () => void;
        setLayerVisible: (id: string, v: boolean) => void;
      };
    };
    stage: () => {
      camera: {
        position: { set: (x: number, y: number, z: number) => unknown; clone: () => V3 };
        lookAt: (x: number, y: number, z: number) => void;
        updateMatrixWorld: () => void;
      };
      controls: { target: { set: (x: number, y: number, z: number) => void }; update: () => void };
      raycastRay: (o: V3, d: V3) => { point: { x: number; y: number; z: number } } | null;
      requestRender: () => void;
    } | null;
    videoRig: () => {
      loggedPose: () => {
        pos: [number, number, number];
        q: [number, number, number, number];
      } | null;
    } | null;
  };
}
interface V3 {
  set: (x: number, y: number, z: number) => V3;
  normalize: () => V3;
}

async function setClipTime(win: Page, clip: string, t: number) {
  await win.evaluate(
    ([id, tt]) => {
      const ws = (window as unknown as Hooks).__stratlas.workspace.getState();
      const l = ws.project?.manifest.layers.find((x) => x.id === id);
      if (!l?.flight) throw new Error(`no clip ${id}`);
      ws.pause();
      ws.setActiveClip(id);
      ws.setTime(l.flight.startUtcMs + (l.offsetMs ?? 0) + tt * 1000);
    },
    [`clip-${clip}`, t] as const,
  );
}

/**
 * A free view of the front tank from beside the drone (same viewpoint whatever the calibration:
 * it is built from the logged pose), with the clip's frame projected onto the model.
 */
async function tankRimShot(win: Page, path: string) {
  await win.evaluate(() => {
    const s = (window as unknown as Hooks).__stratlas;
    const stage = s.stage();
    const pose = s.videoRig()?.loggedPose();
    if (!stage || !pose) throw new Error('no stage or pose');
    const [qx, qy, qz, qw] = pose.q;
    const rot = (v: [number, number, number]): [number, number, number] => {
      const [x, y, z] = v;
      const ix = qw * x + qy * z - qz * y;
      const iy = qw * y + qz * x - qx * z;
      const iz = qw * z + qx * y - qy * x;
      const iw = -qx * x - qy * y - qz * z;
      return [
        ix * qw - iw * qx - iy * qz + iz * qy,
        iy * qw - iw * qy - iz * qx + ix * qz,
        iz * qw - iw * qz - ix * qy + iy * qx,
      ];
    };
    // the ray through the frame point of the front tank wall
    const d = rot([-0.17, 0.08, -1]);
    const o = stage.camera.position.clone().set(...pose.pos);
    const dir = stage.camera.position
      .clone()
      .set(...d)
      .normalize();
    const hit = stage.raycastRay(o, dir);
    if (!hit) throw new Error('nothing in view');
    const t = hit.point;
    // from the drone's side, closer in, a little lower
    const [px, py, pz] = pose.pos;
    const back = { x: px - t.x, y: py - t.y, z: pz - t.z };
    const a = (35 * Math.PI) / 180;
    const bx = back.x * Math.cos(a) - back.z * Math.sin(a);
    const bz = back.x * Math.sin(a) + back.z * Math.cos(a);
    stage.camera.position.set(t.x + bx * 0.45, t.y + back.y * 0.3, t.z + bz * 0.45);
    stage.controls.target.set(t.x, t.y, t.z);
    stage.controls.update();
    stage.requestRender();
  });
  await win.mouse.move(5, 890);
  await win.waitForTimeout(4000);
  await win.screenshot({ path });
}

async function addPairs(win: Page, panel: Locator, pairs: Pair[]) {
  const frame = win.getByTestId('calibration-frame');
  const box = await frame.boundingBox();
  if (!box) throw new Error('no frame');
  for (const p of pairs) {
    await panel.getByTestId('add-pair').click();
    await win.mouse.click(box.x + p.image[0] * box.width, box.y + p.image[1] * box.height);
    await panel.getByLabel('Feature coordinate').fill(p.enh.map((v) => v.toFixed(3)).join(' '));
    await panel.getByLabel('Feature coordinate').press('Enter');
    await expect(panel.getByLabel('Feature coordinate')).toHaveCount(0);
  }
}

/** Errors (pixels) of table rows `from` onwards. */
async function rowErrors(panel: Locator, from = 0): Promise<number[]> {
  const cells = await panel.getByTestId('pair-row').locator('td.r').allInnerTexts();
  return cells
    .map((c) => Number(/([\d.]+) px/.exec(c)?.[1] ?? NaN))
    .filter((v) => !Number.isNaN(v))
    .slice(from);
}

const rms = (v: number[]) => Math.sqrt(v.reduce((m, x) => m + x * x, 0) / Math.max(1, v.length));

test('guided orientation calibration of an Al-Zour clip', async () => {
  const plan = JSON.parse(await readFile(PLAN, 'utf8')) as Plan;
  const tag = plan.tag ?? 'guided';
  const user = await mkdtemp(join(tmpdir(), 'aio-a1-alzour-'));
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: {
      ...(process.env as Record<string, string>),
      STRATLAS_DATA: DATA,
      STRATLAS_USER_DATA: user,
    },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.getByTestId('project-card').filter({ hasText: 'Al-Zour' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 60_000 });
    await win.keyboard.press('Control+b');
    await win.keyboard.press('Control+Alt+b');
    // the projection drapes onto the plant model; clouds and photos only clutter the view
    await win.evaluate(() => {
      const ws = (window as unknown as Hooks).__stratlas.workspace.getState();
      for (const l of ws.project?.manifest.layers ?? [])
        if (['pointcloud', 'photos', 'panoramas'].includes(l.kind)) ws.setLayerVisible(l.id, false);
    });
    const hide = win.getByRole('button', { name: 'Hide the video window' });
    if (await hide.count()) await hide.first().click();
    await setClipTime(win, plan.clip, plan.fit.t);
    await win.waitForTimeout(8000);
    await tankRimShot(win, join(OUT, `orient-${tag}-before.png`));
    if (plan.shotsOnly) return;

    await win.keyboard.press('Control+K');
    await win.keyboard.type('Calibrate video');
    await win.keyboard.press('Enter');
    const panel = win.getByTestId('calibrate-video');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Clip', { exact: true }).selectOption(`clip-${plan.clip}`);

    // held-out errors with the saved calibration
    await setClipTime(win, plan.clip, plan.heldOut.t);
    await win.waitForTimeout(3000);
    await addPairs(win, panel, plan.heldOut.pairs);
    const before = await rowErrors(panel);
    await panel.getByRole('button', { name: 'Clear' }).click();

    // the guided fit on one frame
    await setClipTime(win, plan.clip, plan.fit.t);
    await win.waitForTimeout(3000);
    await win.screenshot({ path: join(OUT, `orient-${tag}-panel-before.png`) });
    await addPairs(win, panel, plan.fit.pairs);
    await expect(panel.getByTestId('fit-position')).toBeChecked();
    await panel.getByTestId('fit-lens').click();
    const fitted = await rowErrors(panel);
    const stats = (await panel.getByTestId('lens-stats').innerText()).replace(/\s+/g, ' ');
    const said = await panel.locator('p.say').last().innerText();
    await win.mouse.move(5, 890);
    await win.waitForTimeout(1500);
    await win.screenshot({ path: join(OUT, `orient-${tag}-panel-after.png`) });

    // the same held-out pairs under the fitted calibration (not refitted)
    await setClipTime(win, plan.clip, plan.heldOut.t);
    await win.waitForTimeout(3000);
    await addPairs(win, panel, plan.heldOut.pairs);
    const after = await rowErrors(panel, plan.fit.pairs.length);

    process.stdout.write(
      [
        `${plan.clip}: ${said}`,
        `fit pairs (${String(fitted.length)}): rms ${rms(fitted).toFixed(1)} px | ${stats}`,
        `held-out t=${String(plan.heldOut.t)} s (${String(before.length)} pairs): before rms ${rms(before).toFixed(1)} px, after rms ${rms(after).toFixed(1)} px`,
        `before ${before.map((v) => v.toFixed(0)).join(' ')}`,
        `after  ${after.map((v) => v.toFixed(0)).join(' ')}`,
        '',
      ].join('\n'),
    );
    expect(after).toHaveLength(before.length);
    expect(rms(after)).toBeLessThan(rms(before) / 2);

    if (plan.save) {
      await panel.getByTestId('calibration-save').click();
      await expect(panel).toContainText('Saved:');
      process.stdout.write(`${await panel.locator('p.say').last().innerText()}\n`);
    }
    await panel.getByRole('button', { name: 'Close' }).click();
    await setClipTime(win, plan.clip, plan.fit.t);
    await win.waitForTimeout(4000);
    await tankRimShot(win, join(OUT, `orient-${tag}-after.png`));
  } finally {
    await app.close();
    await rm(user, { recursive: true, force: true });
  }
});
