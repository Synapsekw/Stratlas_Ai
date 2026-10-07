/**
 * Al-Zour lens calibration on the real project, outside the CI suite. Needs
 * STRATLAS_B2_ALZOUR=<plan.json> and STRATLAS_B2_OUT=<folder for screenshots>.
 *
 * The plan lists, per clip, the video time and point pairs: a pixel in the video frame and the
 * pixel of the same feature in the rendered model, both in screenshot coordinates of the
 * calibration view. With `"save": false` (default) it only takes the screenshots (model only,
 * video only, overlay) and fits; with `"save": true` it saves the fitted lens to the clips of the
 * same frame size through the app (manifest.json.bak is written first, the manifest validated).
 *
 * It runs on a temporary copy of the real project (realData.ts, @realdata), never on the project
 * itself: with `"save": true` the saved manifest is copied to STRATLAS_B2_OUT as
 * `alzour-manifest-<tag>.json`, for the founder to review and apply by hand.
 */
import { expect, test, type Page } from '@playwright/test';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realProject } from './fixtures';
import { hasRealProject, missingRealProject } from './realData';

const PLAN = process.env.STRATLAS_B2_ALZOUR ?? '';
const OUT = process.env.STRATLAS_B2_OUT ?? '';
test.skip(!PLAN || !OUT, 'Al-Zour calibration: set STRATLAS_B2_ALZOUR and STRATLAS_B2_OUT');
test.skip(!hasRealProject('alzour'), missingRealProject('alzour'));
test.setTimeout(600_000);

interface ClipPlan {
  clip: string;
  /** Video time in seconds. */
  t: number;
  /** [frameX, frameY, modelX, modelY] in screenshot pixels. */
  pairs?: [number, number, number, number][];
  /** Lens to show (degrees) instead of the saved one, for an after screenshot. */
  show?: number;
  /** Render the model alone at each of these lenses (degrees), for a field of view sweep. */
  sweep?: number[];
}
interface Plan {
  save?: boolean;
  tag?: string;
  clips: ClipPlan[];
}

interface Ws {
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
      };
    };
  };
}

async function setRange(loc: ReturnType<Page['getByLabel']>, v: number) {
  await loc.evaluate((el, val) => {
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc?.set?.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);
}

async function setClipTime(win: Page, clip: string, t: number) {
  await win.evaluate(
    ([id, tt]) => {
      const ws = (window as unknown as Ws).__stratlas.workspace.getState();
      const l = ws.project?.manifest.layers.find((x) => x.id === id);
      if (!l?.flight) throw new Error(`no clip ${id}`);
      ws.pause();
      ws.setActiveClip(id);
      ws.setTime(l.flight.startUtcMs + (l.offsetMs ?? 0) + tt * 1000);
    },
    [`clip-${clip}`, t] as const,
  );
}

test('@realdata calibrate the Al-Zour clips against the plant model', async () => {
  const plan = JSON.parse(await readFile(PLAN, 'utf8')) as Plan;
  const tag = plan.tag ?? 'run';
  const run = await realProject('alzour', { prefix: 'aio-b2-alzour-' });
  try {
    const { win } = run;
    await win.getByTestId('project-card').filter({ hasText: 'Al-Zour' }).first().click();
    await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 60_000 });
    await win.keyboard.press('Control+b');
    await win.keyboard.press('Control+Alt+b');
    await win.waitForTimeout(8000);
    for (const c of plan.clips) {
      await setClipTime(win, c.clip, c.t);
      await win.keyboard.press('Control+K');
      await win.keyboard.type('Calibrate video');
      await win.keyboard.press('Enter');
      const panel = win.getByTestId('calibrate-video');
      await expect(panel).toBeVisible();
      await panel.getByLabel('Clip', { exact: true }).selectOption(`clip-${c.clip}`);
      await setClipTime(win, c.clip, c.t);
      if (c.show !== undefined) {
        await panel.getByLabel('Horizontal field of view in degrees').fill(String(c.show));
      }
      const hide = win.getByRole('button', { name: 'Hide the video window' });
      if (await hide.count()) await hide.first().click();
      await win.mouse.move(5, 890);
      await win.waitForTimeout(6000);
      const opacity = panel.getByLabel('Frame opacity');
      const frame = win.getByTestId('calibration-frame');
      const box = await frame.boundingBox();
      process.stdout.write(`${c.clip} frame box ${JSON.stringify(box)}\n`);
      const name = `${tag}-${c.clip}-${String(c.t)}`;
      await setRange(opacity, 0);
      await win.waitForTimeout(800);
      await win.screenshot({ path: join(OUT, `${name}-model.png`) });
      await setRange(opacity, 1);
      await win.waitForTimeout(800);
      await win.screenshot({ path: join(OUT, `${name}-video.png`) });
      await setRange(opacity, 0.5);
      await win.waitForTimeout(500);
      await win.screenshot({ path: join(OUT, `${name}-overlay.png`) });
      for (const f of c.sweep ?? []) {
        await panel.getByLabel('Horizontal field of view in degrees').fill(String(f));
        await setRange(opacity, 0);
        await win.mouse.move(5, 890);
        await win.waitForTimeout(700);
        await win.screenshot({ path: join(OUT, `${name}-sweep-${f.toFixed(2)}.png`) });
      }
      if (c.pairs?.length) {
        for (const [fx, fy, mx, my] of c.pairs) {
          await panel.getByTestId('add-pair').click();
          await win.mouse.click(fx, fy);
          await win.mouse.click(mx, my);
          await win.waitForTimeout(150);
        }
        await panel.getByTestId('fit-lens').click();
        const stats = (await panel.getByTestId('lens-stats').innerText()).replace(/\s+/g, ' ');
        const fov = await panel.getByLabel('Horizontal field of view in degrees').inputValue();
        process.stdout.write(
          `${c.clip} t=${String(c.t)} pairs=${String(c.pairs.length)} fit hfov=${fov} | ${stats}\n`,
        );
        await win.waitForTimeout(800);
        await win.screenshot({ path: join(OUT, `${name}-fitted.png`) });
        if (plan.save) {
          await panel.getByTestId('calibration-save').click();
          await expect(panel).toContainText('Saved:');
          process.stdout.write(`${c.clip}: ${await panel.locator('.say').last().innerText()}\n`);
        }
      }
      if (plan.save && !c.pairs?.length && c.show !== undefined) {
        await panel.getByTestId('calibration-save').click();
        await expect(panel).toContainText('Saved:');
        process.stdout.write(`${c.clip}: ${await panel.locator('.say').last().innerText()}
`);
      }
      await panel.getByRole('button', { name: 'Close' }).click();
    }
    if (plan.save)
      await copyFile(
        join(run.data.projectDir, 'manifest.json'),
        join(OUT, `alzour-manifest-${tag}.json`),
      );
  } finally {
    await run.close();
  }
});
