/**
 * No frame of the 3D view waits for a shader program (engine `stage/programWarmup.ts`).
 *
 * The first use of a program asks the driver questions that wait for the graphics process: for
 * the compiler on a graphics card, for everything already sent to be drawn on a software
 * renderer, where the frame of a tileset's first tile took 3.9 s on a CI runner. The stage now
 * makes the programs of a new tile, and of the view with the cutaway switched, ahead of the frame
 * and asks about them outside it.
 *
 * Asserted here is that mechanism, not a frame time (which a slow runner would decide): between
 * the import of a tileset and its first tile on screen, and around the cutaway being switched on
 * and off, no program is made or first asked about inside a frame, while programs are made ahead
 * (so the test would notice if nothing new were needed). The tileset is a hand written one, a
 * single glTF tile in Earth centred coordinates, so no pipeline Python is needed.
 */
import { toWgs84 } from '@aio/geo';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, tinyManifest } from './fixtures';
import { gridGlb } from './gridGlb';
import { enuTileset } from './m10Fixtures';

test.setTimeout(180_000);

/** A program the renderer made or first asked the driver about. */
interface ProgramEvent {
  what: 'made' | 'asked';
  /** three's SHADER_TYPE: the material class the program is for. */
  type: string;
  /** Inside a frame of the stage (`WebGLRenderer.render`). */
  inFrame: boolean;
}

interface Stage {
  scene: {
    getObjectByName(n: string): {
      children: unknown[];
      traverse(cb: (o: { material?: { clippingPlanes?: unknown[] | null } }) => void): void;
    } | null;
  };
  renderer: {
    render(...a: unknown[]): void;
    info: { programs: unknown[] | null };
  };
  raycast(x: number, y: number): { object: { userData: Record<string, unknown> } } | null;
  setSection(p: object): void;
  setViewPreset(p: string): void;
  onFrame(cb: () => void): () => void;
  requestRender(): void;
  clippingPlanes: unknown[];
  /** Objects and section switches waiting for their shader programs. */
  compiling: number;
}

interface W {
  __stratlas: { stage(): Stage | null };
  __programs: ProgramEvent[];
}

/**
 * Record every program the stage's renderer makes (`linkProgram`) and first asks about
 * (`getProgramInfoLog`, the first question of three's first use), with whether that happened
 * inside a frame.
 */
const watchPrograms = (win: Page) =>
  win.evaluate(() => {
    const w = window as unknown as W;
    const stage = w.__stratlas.stage();
    if (!stage) throw new Error('no stage');
    const events: ProgramEvent[] = [];
    w.__programs = events;
    let frames = 0;
    const render = stage.renderer.render.bind(stage.renderer);
    stage.renderer.render = (...a) => {
      frames += 1;
      try {
        render(...a);
      } finally {
        frames -= 1;
      }
    };
    const sources = new WeakMap<object, string>();
    const types = new WeakMap<object, string>();
    type Call = (this: unknown, ...args: unknown[]) => unknown;
    const proto = WebGL2RenderingContext.prototype as unknown as Record<string, Call>;
    /** Look at the arguments of every WebGL call of that name, then make the call. */
    const before = (name: string, seen: (target: object, arg: unknown) => void) => {
      const original = proto[name];
      if (!original) throw new Error(`no WebGL call named ${name}`);
      proto[name] = function (...args) {
        if (typeof args[0] === 'object' && args[0] !== null) seen(args[0], args[1]);
        return original.apply(this, args);
      };
    };
    before('shaderSource', (shader, source) => {
      if (typeof source === 'string') sources.set(shader, source);
    });
    before('attachShader', (program, shader) => {
      const source = typeof shader === 'object' && shader !== null ? sources.get(shader) : '';
      const type = /#define SHADER_TYPE (\w+)/.exec(source ?? '')?.[1];
      if (type) types.set(program, type);
    });
    before('linkProgram', (program) => {
      events.push({ what: 'made', type: types.get(program) ?? '?', inFrame: frames > 0 });
    });
    before('getProgramInfoLog', (program) => {
      events.push({ what: 'asked', type: types.get(program) ?? '?', inFrame: frames > 0 });
    });
  });

/** The programs recorded since the last call. */
const programsSince = (win: Page) =>
  win.evaluate(() => (window as unknown as W).__programs.splice(0));

/** The layer under the middle of the view, or null. */
const hitInTheMiddle = (win: Page) =>
  win.evaluate(() => {
    const s = (window as unknown as W).__stratlas.stage();
    const id = s?.raycast(0, 0)?.object.userData.layerId;
    return typeof id === 'string' ? id : null;
  });

const programCount = (win: Page) =>
  win.evaluate(
    () => (window as unknown as W).__stratlas.stage()?.renderer.info.programs?.length ?? 0,
  );

const setSection = (win: Page, patch: object) =>
  win.evaluate((p) => {
    (window as unknown as W).__stratlas.stage()?.setSection(p);
  }, patch);

/** Nothing compiles any more and a frame asked for now has been drawn. */
async function settled(win: Page): Promise<void> {
  await expect
    .poll(() => win.evaluate(() => (window as unknown as W).__stratlas.stage()?.compiling ?? 0), {
      timeout: 60_000,
    })
    .toBe(0);
  await win.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const s = (window as unknown as W).__stratlas.stage();
        if (!s) {
          resolve();
          return;
        }
        // called as the draw starts: the animation frame after it comes once the draw has ended
        const off = s.onFrame(() => {
          off();
          requestAnimationFrame(() => {
            resolve();
          });
        });
        s.requestRender();
      }),
  );
}

async function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
  }, path);
}

/** The shadow pass picks its depth programs inside the frame; they are not made ahead. */
const SHADOW_PASS = ['MeshDepthMaterial', 'MeshDistanceMaterial'];
const inFrame = (events: ProgramEvent[]) =>
  events.filter((e) => e.inFrame && !SHADOW_PASS.includes(e.type));
const madeAhead = (events: ProgramEvent[]) => events.filter((e) => e.what === 'made' && !e.inFrame);

test('the first tile and the cutaway are drawn without a frame that waits for a shader program', async ({
  app,
  win,
  dataRoot,
}) => {
  // another program's export: one tile over the project origin, in Earth centred coordinates
  const [lon, lat] = toWgs84(tinyManifest().origin, 32639);
  const exported = join(dataRoot.base, 'Site export');
  await mkdir(exported, { recursive: true });
  await writeFile(join(exported, 'tile.glb'), gridGlb());
  await writeFile(
    join(exported, 'tileset.json'),
    JSON.stringify(enuTileset(lon, lat, 0, 'tile.glb', 40)),
  );

  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
  // the project's own first frames make their programs as before; they are not the subject
  await expect
    .poll(() =>
      win.evaluate(
        () =>
          (window as unknown as W).__stratlas.stage()?.scene.getObjectByName('layer:quad') != null,
      ),
    )
    .toBe(true);
  await win.evaluate(() => {
    (window as unknown as W).__stratlas.stage()?.setViewPreset('top');
  });
  await settled(win);
  await expect
    .poll(async () => {
      const before = await programCount(win);
      await win.waitForTimeout(500);
      await settled(win);
      return (await programCount(win)) - before;
    })
    .toBe(0);
  await watchPrograms(win);

  // Import 3D Tiles: the site view streams the new tileset
  await answerOpenDialog(app, join(exported, 'tileset.json'));
  await win.keyboard.press('Control+K');
  await expect(win.getByRole('dialog', { name: 'Command search' })).toBeVisible();
  await win.keyboard.type('Import 3D Tiles');
  await win.keyboard.press('Enter');
  const card = win.getByTestId('tileset-import');
  await expect(card.getByRole('textbox', { name: 'Tileset name' })).toHaveValue('Site export');
  await card.getByRole('button', { name: 'Import' }).click();
  await expect(card).toContainText('Imported Site export', { timeout: 60_000 });
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (window as unknown as W).__stratlas
              .stage()
              ?.scene.getObjectByName('tileset:Site-export')?.children.length ?? 0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await settled(win);
  // on screen and pickable in the middle of the view
  expect(await hitInTheMiddle(win)).toBe('tileset:Site-export');
  const tile = await programsSince(win);
  // the tile needed a program of its own, made before the frame that first drew it
  expect(madeAhead(tile).length, JSON.stringify(tile)).toBeGreaterThan(0);
  expect(inFrame(tile), JSON.stringify(tile)).toEqual([]);

  // the cutaway on: every material that takes the section planes needs another program
  const shared = await win.evaluate(() => {
    const s = (window as unknown as W).__stratlas.stage();
    if (!s) throw new Error('no stage');
    s.setSection({ enabled: true, mode: 'vertical', bearingDeg: 90, offset: 0 });
    let n = 0;
    s.scene.getObjectByName('tileset:Site-export')?.traverse((o) => {
      if (o.material?.clippingPlanes === s.clippingPlanes) n += 1;
    });
    return { n, planes: s.clippingPlanes.length };
  });
  // what was asked for holds at once, whatever is still compiling
  expect(shared.n).toBeGreaterThan(0);
  expect(shared.planes).toBe(1);
  await settled(win);
  const cutOn = await programsSince(win);
  expect(madeAhead(cutOn).length, JSON.stringify(cutOn)).toBeGreaterThan(0);
  expect(inFrame(cutOn), JSON.stringify(cutOn)).toEqual([]);

  // off and on again: every program exists, nothing is made at all
  await setSection(win, { enabled: false });
  await settled(win);
  await setSection(win, { enabled: true });
  await settled(win);
  const again = await programsSince(win);
  expect(
    again.filter((e) => e.what === 'made'),
    JSON.stringify(again),
  ).toEqual([]);
  expect(inFrame(again), JSON.stringify(again)).toEqual([]);
});
