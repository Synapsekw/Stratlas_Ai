/**
 * The agent drives the camera on the real HCl tank and Al-Zour plant (scripted test model, no
 * network): named places, issues, photos, coordinates, the drone at a time, standard views, orbit
 * and zoom, from a focused video window, on a Map-only stage (the map pans; 3D-only moves open the
 * 3D view) and in split view. The projects are copied into a temporary data root
 * (copied, agentProjects.ts); skipped on machines without them.
 */
import { toWgs84 } from '@aio/geo';
import type { ElectronApplication, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copiedDataRoot, hasRealProject, realProject, type ProjectCopy } from './agentProjects';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

test.setTimeout(240_000);

type V3 = [number, number, number];

interface Hook {
  __stratlas: {
    workspace: {
      getState(): {
        focus(w: string): void;
        project: { manifest: { origin: V3 } } | null;
        issues: { code: string; sightings: { on: string; geom: { type: string; p?: V3 } }[] }[];
      };
    };
    stage(): {
      saveView(): { position: V3; target: V3 };
      contentBounds(): { min: { toArray(): V3 }; max: { toArray(): V3 } } | null;
      scene: {
        getObjectByName(n: string): unknown;
      };
    } | null;
  };
}

interface Run {
  data: ProjectCopy;
  app: ElectronApplication;
  win: Page;
  network: NetworkGuard;
}

async function open(id: string, name: string, packs: string[] = []): Promise<Run> {
  const data = await copiedDataRoot(id, packs);
  const app = await launchApp(data, { STRATLAS_AI_TEST_PROVIDER: '1' });
  try {
    const network = new NetworkGuard();
    await network.attach(app);
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
    await win.getByTestId('project-card').filter({ hasText: name }).click();
    await expect(win.locator('.crumbs')).toContainText(name);
    return { data, app, win, network };
  } catch (e) {
    await app.close().catch(() => undefined);
    await data.dispose();
    throw e;
  }
}

async function close(run: Run) {
  try {
    expect(await run.network.outbound(), 'the app made network requests').toEqual([]);
  } finally {
    await run.app.close().catch(() => undefined);
    await run.data.dispose();
  }
}

const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });

let previewed = false;
let lastPreview = '';

/** Send a message (with `#tool` lines for the scripted model) and wait for its answer. */
async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  await expect(box).toBeEnabled({ timeout: 60_000 });
  const replies = await agent(win)
    .getByText(/^Tool \w+ returned/)
    .count();
  await box.fill(text);
  await box.press('Enter');
  if (!previewed) {
    // the first send shows what leaves the machine: the window context with the site summary
    const dialog = win.getByRole('dialog', { name: /Send to/ });
    await expect(dialog).toContainText('"site"');
    lastPreview = await dialog.innerText();
    await dialog.getByRole('button', { name: 'Send' }).click();
    previewed = true;
  }
  await expect
    .poll(
      () =>
        agent(win)
          .getByText(/^Tool \w+ returned/)
          .count(),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(replies);
  const last = await agent(win)
    .getByText(/^Tool \w+ returned/)
    .last()
    .innerText();
  expect(last, 'the tool failed').not.toContain('error-text');
  return last;
}

const view = (win: Page) =>
  win.evaluate(() => {
    const v = (window as unknown as Hook).__stratlas.stage()?.saveView();
    if (!v) throw new Error('no 3D stage');
    return v;
  });

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));

/** Wait until the camera's target (or position) is within `tol` metres of `want`. */
async function cameraAt(
  win: Page,
  want: readonly number[],
  tol: number,
  what: 'target' | 'position' = 'target',
) {
  await expect
    .poll(async () => dist((await view(win))[what], want), { timeout: 15_000 })
    .toBeLessThan(tol);
}

/** Centre of the named nodes' bounds in the live scene (local frame). */
const nodesCentre = (win: Page, names: string[]) =>
  win.evaluate((ns) => {
    interface Box {
      expandByObject(o: unknown): Box;
      isEmpty(): boolean;
      min: { toArray(): V3 };
      max: { toArray(): V3 };
    }
    const s = (window as unknown as Hook).__stratlas.stage();
    const content = s?.contentBounds() as unknown as Box | null;
    if (!s || !content) throw new Error('nothing loaded');
    // three.js Box3 from the bundle, through an instance the stage hands out
    const box = new (content.constructor as new () => Box)();
    for (const n of ns) {
      const o = s.scene.getObjectByName(n);
      if (o) box.expandByObject(o);
    }
    if (box.isEmpty()) throw new Error(`no nodes ${ns.join(', ')}`);
    const lo = box.min.toArray();
    const hi = box.max.toArray();
    return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] as V3;
  }, names);

async function waitForNode(win: Page, name: string) {
  await expect
    .poll(
      () =>
        win.evaluate(
          (n) => Boolean((window as unknown as Hook).__stratlas.stage()?.scene.getObjectByName(n)),
          name,
        ),
      { timeout: 120_000 },
    )
    .toBe(true);
}

async function pressKey(win: Page, key: string) {
  await win.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await win.keyboard.press(key);
}

test.describe('agent camera on HCl', () => {
  test.skip(!hasRealProject('hcl'), 'HCl project not found');

  test('issue, named nozzle from the video window, photo eye and undo', async () => {
    previewed = false;
    const run = await open('hcl', 'HCl Tank');
    const { win } = run;
    try {
      await waitForNode(win, 'Shell_Course_1_Outer');

      // "go to issue F05": the middle of its 3D sightings, close up
      await ask(win, 'go to issue F05 #tool fly_to {"target":{"kind":"issue","id":"F05"}}');
      const f05 = await win.evaluate(() => {
        const i = (window as unknown as Hook).__stratlas.workspace
          .getState()
          .issues.find((x) => x.code === 'F05');
        const pts = (i?.sightings ?? []).flatMap((s) =>
          s.on === 'mesh' && s.geom.type === 'spoint' && s.geom.p ? [s.geom.p] : [],
        );
        // the middle of the box around every sighting
        const mid = (k: 0 | 1 | 2) =>
          (Math.min(...pts.map((p) => p[k])) + Math.max(...pts.map((p) => p[k]))) / 2;
        return [mid(0), mid(1), mid(2)] as V3;
      });
      await cameraAt(win, f05, 0.05);
      const v = await view(win);
      expect(dist(v.position, v.target)).toBeLessThan(15);

      // the agent bound to the video window still drives the camera
      await win.evaluate(() => {
        (window as unknown as Hook).__stratlas.workspace.getState().focus('video');
      });
      await expect(agent(win).locator('.ag-bind')).toContainText('Video');
      const found = await ask(
        win,
        'fly to nozzle N11 #tool find_places {"query":"nozzle N11","limit":3} #tool fly_to {"target":{"kind":"place","name":"nozzle N11"}}',
      );
      expect(found).toContain('fly_to');
      const tag = JSON.parse(readFileSync(join(realProject('hcl'), 'manifest.json'), 'utf8')) as {
        layers: { kind: string; tags?: { node: string; tag: string }[] }[];
      };
      const n11 = tag.layers.find((l) => l.kind === 'mesh')?.tags?.find((t) => t.tag === 'N11');
      if (!n11) throw new Error('no N11 tag');
      await cameraAt(win, await nodesCentre(win, [n11.node]), 0.05);
      const before = await view(win);

      // "show me the photo of F02": stand where its first photo (106_0172) was taken
      await ask(win, 'photo of F02 #tool fly_to {"target":{"kind":"place","name":"photo of F02"}}');
      const photo = JSON.parse(readFileSync(join(realProject('hcl'), 'manifest.json'), 'utf8')) as {
        layers: { kind: string; items?: { id: string; pos?: V3 }[] }[];
      };
      const pos = photo.layers
        .find((l) => l.kind === 'photos')
        ?.items?.find((i) => i.id === '106_0172')?.pos;
      if (!pos) throw new Error('no photo 106_0172');
      await cameraAt(win, pos, 0.01, 'position');

      // Undo puts the camera back where it was before the photo
      await agent(win).getByRole('button', { name: 'Undo' }).last().click();
      await cameraAt(win, before.position, 0.05, 'position');
    } finally {
      await close(run);
    }
  });
});

test.describe('agent camera on Al-Zour', () => {
  test.skip(!hasRealProject('alzour'), 'Al-Zour project not found');

  test('tank, jetty, coordinates, drone time, views, map and split', async () => {
    previewed = false;
    const run = await open('alzour', 'Al-Zour', ['kuwait']);
    const { win } = run;
    try {
      await waitForNode(win, '20-T-0003');
      const manifest = JSON.parse(
        readFileSync(join(realProject('alzour'), 'manifest.json'), 'utf8'),
      ) as {
        origin: V3;
        layers: {
          id: string;
          kind: string;
          tags?: { node: string; tag: string; area?: string }[];
          flight?: { src: { path: string }; startUtcMs: number };
          offsetMs?: number;
          positionOffsetM?: V3;
        }[];
      };
      const origin = manifest.origin;

      // "fly to tank 3": find_places, then fly_to the id it returned
      const found = await ask(win, 'fly to tank 3 #tool find_places {"query":"tank 3","limit":3}');
      expect(found).toContain('asset:20-T-0003');
      // the model knew the site before searching: CRS, origin, areas with example tags
      for (const part of ['EPSG:32639 (UTM 39N, WGS84)', '20 · LNG tanks', '20-T-000', 'latLon'])
        expect(lastPreview).toContain(part);
      await ask(win, 'go #tool fly_to {"target":{"kind":"place","name":"asset:20-T-0003"}}');
      const tank3 = await nodesCentre(win, ['20-T-0003']);
      await cameraAt(win, tank3, 0.05);

      // "show me the jetty": the jetty area as a whole
      await ask(win, 'show me the jetty #tool fly_to {"target":{"kind":"place","name":"jetty"}}');
      const jettyNodes = (manifest.layers.find((l) => l.kind === 'mesh')?.tags ?? [])
        .filter((t) => t.area?.includes('Jetty'))
        .map((t) => t.node);
      await cameraAt(win, await nodesCentre(win, jettyNodes), 0.1);

      // "fly to 29.07N 48.08E" style: latitude and longitude of tank 1's centre
      const tank1 = await nodesCentre(win, ['20-T-0001']);
      const [lon, lat] = toWgs84([origin[0] + tank1[0], origin[1] - tank1[2], 0], 32639);
      await ask(
        win,
        `coordinates #tool fly_to {"target":{"kind":"place","name":"${lat.toFixed(7)}N ${lon.toFixed(7)}E"},"view":"top","distanceM":150}`,
      );
      await expect
        .poll(async () => {
          const t = (await view(win)).target;
          return Math.hypot(t[0] - tank1[0], t[2] - tank1[2]);
        })
        .toBeLessThan(0.5);
      let v = await view(win);
      expect(v.position[1] - v.target[1]).toBeGreaterThan(149);

      // "go to where the drone was at 13:25": flight 1 at 10:25:00 UTC, clip DJI_0658's calibration
      await ask(win, 'drone at 13:25 #tool fly_to {"target":{"kind":"clip","at":"13:25"}}');
      const clip = manifest.layers.find((l) => l.id === 'clip-DJI_0658');
      if (!clip?.flight) throw new Error('no clip-DJI_0658');
      const flight = JSON.parse(
        readFileSync(join(realProject('alzour'), clip.flight.src.path), 'utf8'),
      ) as { samples: { t: number; pos: V3 }[] };
      const t = Date.UTC(2023, 1, 21, 10, 25, 0) - clip.flight.startUtcMs;
      const i = flight.samples.findIndex((s) => s.t >= t);
      const a = flight.samples[i - 1];
      const b = flight.samples[i];
      if (!a || !b) throw new Error('flight does not cover 10:25');
      const k = (t - a.t) / (b.t - a.t);
      const off = clip.positionOffsetM ?? [0, 0, 0];
      const drone: V3 = [0, 1, 2].map(
        (j) => (a.pos[j] ?? 0) + ((b.pos[j] ?? 0) - (a.pos[j] ?? 0)) * k + (off[j] ?? 0),
      ) as V3;
      await cameraAt(win, drone, 0.05, 'position');

      // "top view", "zoom out to the whole site", orbit and zoom
      await ask(win, 'whole site #tool frame_all {}');
      const site = await win.evaluate(() => {
        const b = (window as unknown as Hook).__stratlas.stage()?.contentBounds();
        if (!b) throw new Error('no content');
        const lo = b.min.toArray();
        const hi = b.max.toArray();
        return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] as V3;
      });
      await cameraAt(win, site, 0.5);
      await ask(win, 'top view #tool set_view {"view":"top"}');
      await expect
        .poll(async () => {
          const w = await view(win);
          return Math.hypot(w.position[0] - w.target[0], w.position[2] - w.target[2]);
        })
        .toBeLessThan(1);
      await ask(
        win,
        'from the south #tool fly_to {"target":{"kind":"place","name":"tank 3"},"view":"south"}',
      );
      await cameraAt(win, tank3, 0.05);
      v = await view(win);
      const d0 = dist(v.position, v.target);
      await ask(win, 'orbit #tool orbit {"yawDeg":90}');
      await expect
        .poll(async () => {
          const w = await view(win);
          // from the south to the west of the tank
          return w.target[0] - w.position[0];
        })
        .toBeGreaterThan(d0 * 0.8);
      await ask(win, 'closer #tool zoom {"factor":2}');
      await expect
        .poll(async () => {
          const w = await view(win);
          return dist(w.position, w.target);
        })
        .toBeLessThan(d0 * 0.55);

      // Map only: fly_to pans the map to the place
      await pressKey(win, '2');
      await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'map');
      const mapCentre = () =>
        win.evaluate(() => {
          const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
            (Element & { __aioMap: { getCenter(): { lng: number; lat: number } } }) | undefined;
          const c = el?.__aioMap.getCenter();
          return c ? [c.lng, c.lat] : null;
        });
      // the map has started (a pack is installed in the test data root)
      await expect.poll(mapCentre, { timeout: 30_000 }).not.toBeNull();
      await ask(win, 'show tank 1 #tool fly_to {"target":{"kind":"place","name":"20-T-0001"}}');
      const [lon1, lat1] = toWgs84([origin[0] + tank1[0], origin[1] - tank1[2], 0], 32639);
      await expect
        .poll(mapCentre, { timeout: 15_000 })
        .toEqual([expect.closeTo(lon1, 4), expect.closeTo(lat1, 4)]);
      // a 3D-only move opens the 3D view
      await ask(win, 'orbit #tool orbit {"yawDeg":-45}');
      await expect(win.locator('.stage')).toHaveAttribute('data-mode', '3d');

      // Split: the agent on the map pane moves the 3D camera too
      await pressKey(win, '3');
      await expect(win.locator('.stage')).toHaveAttribute('data-mode', 'split');
      await win.evaluate(() => {
        (window as unknown as Hook).__stratlas.workspace.getState().focus('map');
      });
      await ask(win, 'go to tank 2 #tool fly_to {"target":{"kind":"place","name":"tank 2"}}');
      await cameraAt(win, await nodesCentre(win, ['20-T-0002']), 0.05);
    } finally {
      await close(run);
    }
  });
});
