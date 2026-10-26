/**
 * THROWAWAY DESIGN SPIKE (feat/pile-3d-look): screenshots of the pile looks in the real app on
 * the quarry demo, for the founder. Not a test: it only captures PNGs into SPIKE_OUT.
 */
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { volumesView } from './island';
import { focusPile } from './measureCard';
import { openDemo } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

const OUT = process.env.SPIKE_OUT ?? join(process.cwd(), 'spike-out');
const SP1 = 'Stockpile SP1';
const SP1_ID = 'm-sp1';

type Look = 'current' | 'A' | 'B' | 'C';

async function setLook(win: Page, look: Look): Promise<void> {
  await win.evaluate((l) => {
    (window as unknown as { __pileLook: string }).__pileLook = l;
  }, look);
  await win.waitForTimeout(1500);
  console.warn(
    `LOOK ${look}: ${String(await win.evaluate(() => (window as unknown as { __pileLookDebug?: string }).__pileLookDebug))}`,
  );
  if (look !== 'current')
    await expect
      .poll(
        () =>
          win.evaluate(
            () =>
              (window as unknown as { __pileLookParts?: () => number }).__pileLookParts?.() ?? 0,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
}

async function fly(win: Page, factor: number, elevation = 38, azimuth = 200): Promise<void> {
  await win.evaluate(
    ([f, e, a]) => {
      (window as unknown as { __pileFly: (f: number, e: number, a: number) => void }).__pileFly(
        f,
        e,
        a,
      );
    },
    [factor, elevation, azimuth] as const,
  );
  await win.waitForTimeout(3_500);
}

test('spike: pile looks', async ({ quarryProject, win }) => {
  test.setTimeout(900_000);
  await mkdir(OUT, { recursive: true });
  await openDemo(win, quarryProject.name, quarryProject.id);
  const view = await volumesView(win);
  await expect(view.getByTestId('volumes-pile')).toHaveCount(4, { timeout: 60_000 });
  const strip = win.getByRole('region', { name: 'Survey dates chart' });
  await expect(strip.locator('[data-survey][data-state="ready"]')).toHaveCount(3, {
    timeout: 360_000,
  });
  await focusPile(win, SP1);
  await win.waitForTimeout(4_000);
  const scene = win.locator('[data-scene-view]').first();
  if (process.env.SPIKE_DUMP) {
    const dump = await win.evaluate(() => {
      interface O {
        name: string;
        type: string;
        visible: boolean;
        renderOrder: number;
        children: O[];
        material?: {
          depthTest: boolean;
          opacity: number;
          type: string;
          color?: { getHexString(): string };
        };
      }
      const st = (window as unknown as { __spikeStage: { scene: O } }).__spikeStage;
      const out: string[] = [];
      const walk = (o: O, path: string) => {
        if (!o.visible) return;
        const p = path + '/' + (o.name || o.type);
        if (o.material)
          out.push(
            p +
              ' ' +
              o.type +
              ' ro=' +
              String(o.renderOrder) +
              ' ' +
              o.material.type +
              ' dt=' +
              String(o.material.depthTest) +
              ' op=' +
              String(o.material.opacity) +
              ' c=' +
              (o.material.color?.getHexString() ?? ''),
          );
        for (const c of o.children) walk(c, p);
      };
      walk(st.scene, '');
      return out.slice(0, 150).join('\n');
    });
    console.warn(dump);
    return;
  }

  for (const look of ['current', 'A', 'B', 'C'] as const) {
    await setLook(win, look);
    await fly(win, 1);
    await scene.screenshot({ path: join(OUT, `${look}-close.png`) });
    await fly(win, 2.8, 42, 215);
    await win.screenshot({ path: join(OUT, `${look}-wide.png`) });
  }

  // the right-click menu on the pile in 3D, look A
  await setLook(win, 'A');
  await fly(win, 1);
  const label = win.locator(`[data-scene-view] .sv-labels .sv-label[data-id="${SP1_ID}"]`).first();
  const at = await label.evaluate((el) => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
    const r = el.parentElement?.getBoundingClientRect();
    return m && r ? { x: r.left + Number(m[1]), y: r.top + Number(m[2]) } : null;
  });
  if (!at) throw new Error('no label anchor');
  await win.mouse.click(at.x, at.y + 6, { button: 'right' });
  const menu = win.getByTestId('measure-menu');
  await expect(menu).toBeVisible();
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(OUT, 'menu.png') });
  const items = await menu.getByRole('menuitem').allInnerTexts();
  console.warn(`MENU ITEMS: ${JSON.stringify(items)}`);
  // the placeholder Edit boundary enters the vertex edit
  await menu.getByRole('menuitem', { name: 'Edit boundary' }).click();
  await win.waitForTimeout(1_500);
  await scene.screenshot({ path: join(OUT, 'edit-boundary.png') });
});
