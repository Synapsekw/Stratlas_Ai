/**
 * Drone telemetry and photo markers on the real fusion projects (Al-Zour, HCl, DAMAC): the
 * tactical trace of the playing clip (flown trail, distance ticks, HUD, D to turn it off and on,
 * remembered per project) and one photo marker per place with a count. Runs only where the real
 * data holds the projects (realData.ts); skipped elsewhere. Each test runs on a temporary copy of
 * its project (@realdata). QUADRION_SHOTS=<folder> saves screenshots (telemetry-*.png, icons-*.png).
 */
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { expect, realDataTest } from './fixtures';
import { hasRealProject } from './realData';

const SHOTS = process.env.QUADRION_SHOTS;
const has = hasRealProject;

const test = realDataTest([], { size: [1440, 900] });

test.setTimeout(240_000);

interface V3 {
  x: number;
  y: number;
  z: number;
}
interface Hooks {
  __stratlas: {
    workspace: {
      getState(): {
        nowMs: number;
        playing: boolean;
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
        setActiveClip(id: string): void;
        setTime(ms: number): void;
        play(): void;
        pause(): void;
      };
    };
    stage(): {
      restoreView(v: { position: number[]; target: number[] }, animate?: boolean): void;
    } | null;
    videoRig(): {
      currentPose(): { pos: V3 } | null;
      trace: {
        lastReadout: { distanceM: number; step: number; ticks: number; labels: number } | null;
        group: { visible: boolean };
      };
    } | null;
  };
}

async function open(win: Page, card: string) {
  await win.getByTestId('project-card').filter({ hasText: card }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 60_000 });
  // the stage alone, wide: no sidebar
  await win.keyboard.press('Control+b');
}

/** Put the playhead `s` seconds into a clip and make it active (paused). */
async function seekClip(win: Page, clip: string, s: number) {
  await win.evaluate(
    ([id, t]) => {
      const ws = (window as unknown as Hooks).__stratlas.workspace.getState();
      const l = ws.project?.manifest.layers.find((x) => x.id === id);
      if (!l?.flight) throw new Error(`no clip ${id}`);
      ws.pause();
      ws.setActiveClip(id);
      ws.setTime(l.flight.startUtcMs + (l.offsetMs ?? 0) + t * 1000);
    },
    [clip, s] as const,
  );
}

const pose = (win: Page) =>
  win.evaluate(() => {
    const p = (window as unknown as Hooks).__stratlas.videoRig()?.currentPose()?.pos;
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  });

/** The calibrated drone position `s` seconds into a clip (leaves the playhead there). */
async function poseAt(win: Page, clip: string, s: number): Promise<V3> {
  await seekClip(win, clip, s);
  await expect.poll(async () => (await pose(win)) !== null).toBe(true);
  await win.waitForTimeout(200);
  const p = await pose(win);
  if (!p) throw new Error('no pose');
  return p;
}

async function view(win: Page, position: number[], target: number[]) {
  await win.evaluate(
    ([p, t]) => {
      (window as unknown as Hooks).__stratlas
        .stage()
        ?.restoreView({ position: p, target: t }, false);
    },
    [position, target] as const,
  );
}

/** Frame the trail from the clip start to `s` seconds: a three-quarter view from `azDeg`. */
async function frameTrail(win: Page, clip: string, s: number, azDeg = 225, zoom = 1) {
  const a = await poseAt(win, clip, 0);
  const b = await poseAt(win, clip, s);
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const d = (Math.hypot(a.x - b.x, a.z - b.z) * 1.15 + 20) * zoom;
  const az = (azDeg * Math.PI) / 180;
  const el = (38 * Math.PI) / 180;
  await view(
    win,
    [
      m.x + d * Math.cos(el) * Math.sin(az),
      m.y * 0.5 + d * Math.sin(el),
      m.z + d * Math.cos(el) * Math.cos(az),
    ],
    [m.x, m.y * 0.5, m.z],
  );
}

async function hideVideoWindow(win: Page) {
  if (await win.locator('.vwin').count()) await win.keyboard.press('w');
  await expect(win.locator('.vwin')).toHaveCount(0);
}

async function shot(win: Page, name: string) {
  if (!SHOTS) return;
  // no toolbar tooltip from a focused button
  await win.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await win.mouse.move(5, 890);
  await win.waitForTimeout(2500);
  await win.screenshot({ path: join(SHOTS, name) });
}

const hudValue = (win: Page, id: string) =>
  win.evaluate(
    (k) =>
      Number(
        document.querySelector<HTMLElement>(`[data-trace-hud] [data-hud="${k}"]`)?.dataset.value ??
          NaN,
      ),
    id,
  );

const readout = (win: Page) =>
  win.evaluate(() => (window as unknown as Hooks).__stratlas.videoRig()?.trace.lastReadout ?? null);

/** Play the active clip for about `ms` of video time, then pause. */
async function playFor(win: Page, ms: number) {
  const t0 = await win.evaluate(() => {
    const ws = (window as unknown as Hooks).__stratlas.workspace.getState();
    ws.play();
    return ws.nowMs;
  });
  await expect
    .poll(
      () => win.evaluate(() => (window as unknown as Hooks).__stratlas.workspace.getState().nowMs),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(t0 + ms);
  await win.evaluate(() => {
    (window as unknown as Hooks).__stratlas.workspace.getState().pause();
  });
}

/** Photo or panorama icons on the stage now, with their counts. */
const icons = (win: Page, kind: 'photo' | 'pano') =>
  win.evaluate(
    (k) =>
      [...document.querySelectorAll<HTMLElement>(`[data-markers=${k}] .aio-mk`)]
        .filter((e) => e.style.display !== 'none')
        .map((e) => {
          const r = e.getBoundingClientRect();
          return { count: Number(e.dataset.count), x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
    kind,
  );

async function telemetryFollowsTheClip(win: Page, clip: string, at: number, labels = true) {
  const hud = win.locator('[data-trace-hud]');
  // a view of the flown trail, where the ticks come at the right spacing
  await frameTrail(win, clip, at + 5);
  await seekClip(win, clip, at);
  await expect(hud).toBeVisible();
  // the HUD reads the pose at the playhead
  await expect.poll(async () => Math.abs((await hudValue(win, 'clip')) - at)).toBeLessThan(0.5);
  // distance ticks along the flown part, with labels
  await expect.poll(async () => (await readout(win))?.ticks ?? 0).toBeGreaterThan(0);
  // (labels give way to callouts and markers; over open water some always show)
  if (labels) await expect(win.locator('[data-trace-tick]:visible').first()).toBeVisible();
  const d0 = await hudValue(win, 'distance');
  expect(d0).toBeGreaterThan(0);
  // playing on: the distance flown grows, and the clip time with it
  const c0 = await hudValue(win, 'clip');
  await playFor(win, 4000);
  await expect.poll(() => hudValue(win, 'clip'), { timeout: 20_000 }).toBeGreaterThan(c0 + 3);
  expect(await hudValue(win, 'distance')).toBeGreaterThan(d0);
  for (const k of ['el', 'speed', 'gimbal'])
    expect(Number.isFinite(await hudValue(win, k))).toBe(true);

  // D turns it off and on (the toolbar button follows), independent of the flight paths
  const tool = win.getByRole('button', { name: /drone telemetry/i });
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await win.locator('[data-scene-view] canvas').click({ position: { x: 5, y: 400 } });
  await win.keyboard.press('d');
  await expect(hud).toBeHidden();
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  expect(
    await win.evaluate(
      () => (window as unknown as Hooks).__stratlas.videoRig()?.trace.group.visible,
    ),
  ).toBe(false);
  // remembered for the project
  expect(await win.evaluate(() => localStorage.getItem('stratlas.stagePrefs') ?? '')).toContain(
    '"telemetry":false',
  );
  await tool.click();
  await expect(hud).toBeVisible();
}

test.describe('@realdata alzour', () => {
  test.skip(!has('alzour'), 'Al-Zour not found');
  test.use({ realProjects: ['alzour'] });

  test('telemetry trace follows the playing clip and turns off and on', async ({ win }) => {
    await open(win, 'Al-Zour');
    await telemetryFollowsTheClip(win, 'clip-DJI_0668', 20);

    await frameTrail(win, 'clip-DJI_0668', 45);
    await shot(win, 'telemetry-alzour-with-video.png');
    await hideVideoWindow(win);
    await shot(win, 'telemetry-alzour-overview.png');
    await frameTrail(win, 'clip-DJI_0668', 45, 160, 0.45);
    await shot(win, 'telemetry-alzour-close.png');
    // a long clip over the plant: the shadow runs over the model
    await frameTrail(win, 'clip-DJI_0684', 150, 200, 1.1);
    await shot(win, 'telemetry-alzour-plant.png');
  });

  test('one photo marker per place, a merged one lists its photos', async ({ win }) => {
    await open(win, 'Al-Zour');
    await win.keyboard.press('h');
    await win.waitForTimeout(2500);
    const all = await icons(win, 'photo');
    // 12 photos taken from 5 places; never more icons than places
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThanOrEqual(5);
    expect(all.reduce((n, i) => n + i.count, 0)).toBeLessThanOrEqual(12);
    await shot(win, 'icons-alzour-site.png');

    // close to the hover point of DJI_0679 to DJI_0682: one icon with a count of four
    await view(win, [-850, 190, -260], [-882.6, 126.9, -315.6]);
    await win.waitForTimeout(1000);
    const here = (await icons(win, 'photo')).find((i) => i.count === 4);
    expect(here).toBeDefined();
    await shot(win, 'icons-alzour-place.png');
    if (!here) return;
    await win.mouse.move(here.x, here.y);
    await expect(win.locator('[data-markers=photo] .aio-mk-tip')).toContainText('4 photos');
    if (SHOTS) {
      await win.waitForTimeout(1500);
      await win.screenshot({ path: join(SHOTS, 'icons-alzour-hover.png') });
    }
    await win.mouse.click(here.x, here.y);
    const list = win.getByTestId('marker-list');
    await expect(list.getByRole('option')).toHaveCount(4);
    if (SHOTS) {
      await win.waitForTimeout(1500);
      await win.screenshot({ path: join(SHOTS, 'icons-alzour-list.png') });
    }
  });
});

/** Frame times (ms, rAF stamps) over `ms` while whatever runs keeps running: p50, p95, worst. */
const frameTimes = (win: Page, ms: number) =>
  win.evaluate(
    (dur) =>
      new Promise<{ frames: number; p50: number; p95: number; worst: number }>((done) => {
        const stamps: number[] = [];
        const step = (now: number) => {
          stamps.push(now);
          if (now - (stamps[0] ?? now) < dur) requestAnimationFrame(step);
          else {
            const dts = stamps
              .slice(1)
              .map((t, i) => t - (stamps[i] ?? t))
              .sort((x, y) => x - y);
            const pct = (q: number) =>
              dts[Math.min(dts.length - 1, Math.ceil(q * dts.length) - 1)] ?? 0;
            done({ frames: dts.length, p50: pct(0.5), p95: pct(0.95), worst: dts.at(-1) ?? 0 });
          }
        };
        requestAnimationFrame(step);
      }),
    ms,
  );

test.describe('@realdata alzour playback perf', () => {
  test.skip(!has('alzour') || !process.env.QUADRION_TRACE_PERF, 'set QUADRION_TRACE_PERF=1');
  test.use({ realProjects: ['alzour'] });
  test('frame time while a clip plays over the plant, telemetry on and off', async ({ win }) => {
    await open(win, 'Al-Zour');
    await frameTrail(win, 'clip-DJI_0684', 150, 200, 1.1);
    await hideVideoWindow(win);
    // the full-resolution cloud streams in first
    await win.waitForTimeout(15_000);
    const run = async (label: string) => {
      await seekClip(win, 'clip-DJI_0684', 100);
      await win.evaluate(() => {
        (window as unknown as Hooks).__stratlas.workspace.getState().play();
      });
      await win.waitForTimeout(1500);
      const r = await frameTimes(win, 8000);
      await win.evaluate(() => {
        (window as unknown as Hooks).__stratlas.workspace.getState().pause();
      });
      process.stdout.write(
        `alzour playback, telemetry ${label}: ${String(r.frames)} frames, p50 ${r.p50.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms
`,
      );
      return r;
    };
    const on = await run('on');
    await win.locator('[data-scene-view] canvas').click({ position: { x: 5, y: 400 } });
    await win.keyboard.press('d');
    const off = await run('off');
    expect(on.p95).toBeLessThan(Math.max(20, off.p95 + 2));
  });
});

test.describe('@realdata hcl', () => {
  test.skip(!has('hcl'), 'HCl not found');
  test.use({ realProjects: ['hcl'] });

  test('telemetry inside the tank, photo places merged with counts', async ({ win }) => {
    await open(win, 'HCl');
    await telemetryFollowsTheClip(win, 'video-101', 120, false);
    await win.getByRole('button', { name: 'See inside the asset: cut or transparent' }).click();
    await win.getByTestId('cutaway-panel').getByRole('button', { name: 'Transparent' }).click();
    await win.keyboard.press('Escape');
    await frameTrail(win, 'video-101', 150, 200, 0.7);
    await hideVideoWindow(win);
    await shot(win, 'telemetry-hcl.png');

    // 257 photos: far fewer icons, some carrying counts
    await win.keyboard.press('h');
    await win.waitForTimeout(2500);
    const all = await icons(win, 'photo');
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThan(60);
    expect(all.some((i) => i.count > 1)).toBe(true);
    await shot(win, 'icons-hcl.png');
  });
});

test.describe('@realdata damac', () => {
  test.skip(!has('damac'), 'DAMAC not found');
  test.use({ realProjects: ['damac'] });

  test('1,182 photos draw as merged places', async ({ win }) => {
    await open(win, 'DAMAC');
    await win.keyboard.press('h');
    await win.waitForTimeout(4000);
    await shot(win, 'icons-damac.png');
    const all = await icons(win, 'photo');
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThan(150);
  });
});
