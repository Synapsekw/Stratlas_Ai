/**
 * Findings on a model end to end, on the change demo (synthetic; pnpm demo:change --quick): two
 * detections of the oil stain on the yard, one per survey date, accepted in the review (the stain
 * is a decal of the model and lies in the clouds, while the survey markers are painted on the
 * rendered ground only, which no mesh holds); the offer to connect them to a model; the later one
 * placed on the later mesh (an outline drawn instead of its pin, a click on it opening the photo
 * it was projected from) and on the later point cloud (a prism and a point selection file); the
 * earlier one on the earlier mesh, the match suggestion, and Same giving both one track.
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

interface S {
  on: string;
  layer: string;
  photo?: string;
  geom?: { type: string; src?: { path?: string } };
  from?: { sighting: number };
}
interface IssueLite {
  id: string;
  code: string;
  title: string;
  track?: string;
  sightings: S[];
}
/** The bits of a three.js Vector3 the spec uses to project a point to the screen. */
interface V3 {
  x: number;
  y: number;
  clone(): V3;
  set(x: number, y: number, z: number): V3;
  project(camera: unknown): V3;
}
interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: IssueLite[];
        select(s: null): void;
        upsertIssue(i: IssueLite): void;
        flyTo(t: { kind: 'point'; p: [number, number, number]; distance: number }): void;
      };
    };
    stage(): {
      scene: { getObjectByName(n: string): { userData: Record<string, unknown> } | undefined };
      camera: { position: V3 };
    } | null;
    evidence: { getState(): { open: { issueId: string; index: number } | null } };
  };
}

/**
 * One waiting detection of the demo issue `issueId` (seen in a photo of `date`), in its own pass
 * file: the inner 40 % of the issue's photo box. That box is wider than the round stain, and the
 * demo mesh holds no ground around the stain's decal, so every edge of the detection must lie on
 * the stain for its rays to hit the model.
 */
async function draftPass(root: string, date: 'd1' | 'd2', issueId: string): Promise<void> {
  const src = JSON.parse(
    await readFile(join(root, 'detections', `markers-${date}.json`), 'utf8'),
  ) as {
    detections: Record<string, unknown>[];
  } & Record<string, unknown>;
  type Demo = IssueLite & { classId: string };
  const all = JSON.parse(await readFile(join(root, 'issues.json'), 'utf8')) as
    { issues: Demo[] } | Demo[];
  const issue = (Array.isArray(all) ? all : all.issues).find((i) => i.id === issueId);
  const seen = issue?.sightings.find((x) => x.on === 'image' && x.layer === `photos-${date}`);
  const box = seen?.geom as { x: number; y: number; w: number; h: number } | undefined;
  if (!issue || !seen?.photo || !box) throw new Error(`${issueId} has no photo box on ${date}`);
  const template = src.detections[0];
  if (!template) throw new Error(`the ${date} marker pass has no detection to copy`);
  const d = {
    ...template,
    id: `e2e-${date}`,
    photo: seen.photo,
    class: issue.classId,
    bbox: [
      Math.round(box.x + 0.3 * box.w),
      Math.round(box.y + 0.3 * box.h),
      Math.round(box.x + 0.7 * box.w),
      Math.round(box.y + 0.7 * box.h),
    ],
    status: 'draft',
    note: issue.title,
  };
  const pass = { ...src, producer: 'e2e', detections: [d] };
  await writeFile(join(root, 'detections', `e2e-${date}.json`), JSON.stringify(pass, null, 2));
}

const issues = (win: Page) =>
  win.evaluate(() => (window as unknown as Inspect).__stratlas.workspace.getState().issues);

/** Right-click the issue in the scene's issue list and place it on `layer`. */
async function placeFromList(win: Page, code: string, layer: string): Promise<void> {
  await win
    .getByRole('tablist', { name: 'Context' })
    .getByRole('tab', { name: /Issues/ })
    .click();
  // the list is virtual (only rows in view exist): search for the code to bring its row up
  const register = win.getByTestId('issue-register');
  await register.getByRole('searchbox', { name: 'Search issues' }).fill(code);
  const row = register.getByRole('option', { name: new RegExp(`^${code} `) });
  await row.click({ button: 'right' });
  await win.getByTestId('issue-place-on-model').click();
  await expect(win.getByTestId('place-offer')).toBeVisible();
  await win.getByTestId('place-layer').selectOption(layer);
  await win.getByTestId('place-go').click();
  await expect(win.getByTestId('place-result-text')).toContainText('Placed 1 of 1 on', {
    timeout: 60_000,
  });
}

/** The overlay's area of an issue, in canvas pixels, once the camera has settled on it. */
async function areaOnScreen(win: Page, issueId: string): Promise<{ x: number; y: number }> {
  let at = { x: -1, y: -1 };
  let last = '';
  await expect
    .poll(
      async () => {
        const a = await win.evaluate((id) => {
          const g = (window as unknown as Inspect).__stratlas
            .stage()
            ?.scene.getObjectByName('annotate-issue-pins');
          const list = (g?.userData.areas ?? []) as {
            issueId: string;
            x: number | null;
            y: number | null;
          }[];
          return list.find((x) => x.issueId === id && x.x !== null) ?? null;
        }, issueId);
        if (a?.x == null || a.y === null) return false;
        const now = `${Math.round(a.x)},${Math.round(a.y)}`;
        const still = now === last;
        last = now;
        at = { x: a.x, y: a.y };
        return still;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  return at;
}

test('places accepted findings on the mesh and the cloud, and matches them across dates', async ({
  demoProject,
}) => {
  test.setTimeout(300_000);
  const { win, root, truth } = demoProject;
  // the ground stain seen on both dates (on the yard, y about 0)
  interface Item {
    verdict: string;
    from?: string;
    to?: string;
    at: number[];
  }
  const items = (truth.changes.issue as { items?: Item[] }).items ?? [];
  const stain = items.find((i) => i.verdict === 'unchanged' && (i.at[1] ?? 1) < 0.1);
  if (!stain?.from || !stain.to) throw new Error('the change demo has no stain on both dates');
  await draftPass(root, 'd1', stain.from);
  await draftPass(root, 'd2', stain.to);
  const before = new Set((await issues(win)).map((i) => i.id));

  // 1. accept both in the review: the offer to connect them appears
  await win.locator('.nav-item', { hasText: 'Detections' }).click();
  await expect(win.getByTestId('det-counts')).toContainText('2 waiting', { timeout: 60_000 });
  await win.getByTestId('det-accept-all').click();
  await win.getByTestId('det-batch-ok').click();
  await expect(win.getByTestId('place-offer')).toContainText('Connect 2 findings to a model?');
  await win.getByTestId('place-not-now').click();
  await expect(win.getByTestId('place-offer')).toHaveCount(0);
  const fresh = (await issues(win)).filter((i) => !before.has(i.id));
  const later = fresh.find((i) => i.sightings.some((s) => s.layer === 'photos-d2'));
  const earlier = fresh.find((i) => i.sightings.some((s) => s.layer === 'photos-d1'));
  if (!later || !earlier) throw new Error('the two accepted findings are not there');

  // the later finding is also marked on another photo of its date, with a box larger than the
  // stain's along the top edge, where the photo looks past the model (so it misses the mesh and
  // the stain's box stays the one placed). The evidence ranks the largest box first, so the
  // photo the area came from is the second of its photos: opening the first one fails below.
  await win.evaluate((id) => {
    const ws = (window as unknown as Inspect).__stratlas.workspace.getState();
    const issue = ws.issues.find((x) => x.id === id);
    if (!issue) return;
    const other = {
      on: 'image',
      layer: 'photos-d2',
      photo: 'p01',
      geom: { type: 'box', x: 2, y: 2, w: 200, h: 20 },
    };
    ws.upsertIssue({ ...issue, sightings: [other, ...issue.sightings] });
  }, later.id);
  await expect
    .poll(async () => (await issues(win)).find((i) => i.id === later.id)?.sightings[0]?.photo)
    .toBe('p01');

  // 2. the later finding on the later mesh: an outline instead of its pin
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible({ timeout: 60_000 });
  await placeFromList(win, later.code, 'model-d2');
  await expect
    .poll(async () =>
      (await issues(win)).find((i) => i.id === later.id)?.sightings.map((s) => s.geom?.type),
    )
    .toContain('spolygon');
  const placed = (await issues(win)).find((i) => i.id === later.id);
  // on that mesh it has the outline only: no automatic pin beside it, no second outline
  expect(placed?.sightings.filter((s) => s.layer === 'model-d2').map((s) => s.geom?.type)).toEqual([
    'spolygon',
  ]);
  await win.getByTestId('place-dismiss').click();

  // 3. hovering shows its title, a click opens its photo beside the 3D view
  // look at the outline from 6 m with nothing selected, so the click below is a new pick
  await win.evaluate((id) => {
    const ws = (window as unknown as Inspect).__stratlas.workspace.getState();
    const outline = ws.issues
      .find((x) => x.id === id)
      ?.sightings.find((s) => s.geom?.type === 'spolygon')?.geom as
      { points?: number[][] } | undefined;
    const pts = outline?.points ?? [];
    const mean = (k: number) => pts.reduce((a, p) => a + (p[k] ?? 0), 0) / Math.max(pts.length, 1);
    ws.select(null);
    ws.flyTo({ kind: 'point', p: [mean(0), mean(1), mean(2)], distance: 6 });
  }, later.id);
  const canvas = win.locator('[data-scene-view] canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no 3D canvas');
  const centre = await areaOnScreen(win, later.id);
  // the demo's own pin of the stain stands on the outline's centre (a pin wins over an area):
  // try points from the centre out towards each outline corner on screen, and take the first
  // the overlay itself reports as over the area (the canvas title is the finding's)
  const tries = await win.evaluate(
    ({ id, c }) => {
      const st = (window as unknown as Inspect).__stratlas.stage();
      const ws = (window as unknown as Inspect).__stratlas.workspace.getState();
      const el = document.querySelector('[data-scene-view] canvas');
      const pts =
        (
          ws.issues.find((x) => x.id === id)?.sightings.find((s) => s.geom?.type === 'spolygon')
            ?.geom as { points?: [number, number, number][] } | undefined
        )?.points ?? [];
      if (!st || !el) return [c];
      const corners = pts.map((p) => {
        const v = st.camera.position.clone().set(p[0], p[1], p[2]).project(st.camera);
        return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
      });
      const out = [c];
      for (const f of [0.3, 0.5, 0.7, 0.85])
        for (const k of corners) out.push({ x: c.x + f * (k.x - c.x), y: c.y + f * (k.y - c.y) });
      return out;
    },
    { id: later.id, c: centre },
  );
  let at: { x: number; y: number } | null = null;
  for (const p of tries) {
    await win.mouse.move(box.x + p.x, box.y + p.y);
    if ((await canvas.getAttribute('title')) === later.title) {
      at = p;
      break;
    }
  }
  if (!at) throw new Error(`no point over ${later.code}'s outline shows its title on hover`);
  await expect(canvas).toHaveAttribute('title', later.title);
  await win.mouse.click(box.x + at.x, box.y + at.y);
  // it opens the photo the outline was projected from, not the finding's first photo
  const now = (await issues(win)).find((i) => i.id === later.id);
  const fromIndex = now?.sightings.find((s) => s.geom?.type === 'spolygon')?.from?.sighting;
  const source = fromIndex === undefined ? undefined : now?.sightings[fromIndex];
  expect(source).toMatchObject({ on: 'image', layer: 'photos-d2', photo: 'p03' });
  // the evidence steps through the finding's photos largest box first: p01 (200 x 20), then p03
  const area = (p: string) =>
    (now?.sightings ?? [])
      .filter((s) => s.on === 'image' && s.photo === p)
      .map((s) => s.geom as unknown as { w: number; h: number })
      .reduce((a, g) => Math.max(a, g.w * g.h), 0);
  expect(area('p01')).toBeGreaterThan(area('p03'));
  await expect
    .poll(() =>
      win.evaluate(() => (window as unknown as Inspect).__stratlas.evidence.getState().open),
    )
    .toMatchObject({ issueId: later.id, index: 1 });
  await win.keyboard.press('Escape');

  // 4. the same finding on the later point cloud: a prism and its point selection file
  await placeFromList(win, later.code, 'cloud-d2');
  const onCloud =
    (await issues(win))
      .find((i) => i.id === later.id)
      ?.sightings.filter((s) => s.layer === 'cloud-d2') ?? [];
  expect(onCloud.map((s) => s.geom?.type).sort()).toEqual(['polygon3', 'selection']);
  const sel = onCloud.find((s) => s.geom?.type === 'selection')?.geom?.src?.path ?? '';
  expect(sel).toMatch(/^selections\/.+\.sel$/);
  await access(join(root, sel));
  // the mesh outline is untouched by the cloud placement
  expect(
    (await issues(win))
      .find((i) => i.id === later.id)
      ?.sightings.filter((s) => s.layer === 'model-d2')
      .map((s) => s.geom?.type),
  ).toEqual(['spolygon']);
  await win.getByTestId('place-dismiss').click();

  // 5. the earlier finding on the earlier mesh: "looks like" the later one; Same tracks both
  await placeFromList(win, earlier.code, 'model-d1');
  await expect(win.getByTestId('place-match')).toContainText(
    `${earlier.code} looks like ${later.code} from`,
  );
  const tracks = async () => {
    const list = await issues(win);
    return [
      list.find((i) => i.id === earlier.id)?.track,
      list.find((i) => i.id === later.id)?.track,
    ];
  };
  const [a0, b0] = await tracks();
  expect(a0 !== undefined && a0 === b0).toBe(false);
  await win.getByTestId('place-same').click();
  await expect(win.getByTestId('place-matched')).toBeVisible();
  await expect
    .poll(async () => {
      const list = await issues(win);
      const a = list.find((i) => i.id === earlier.id)?.track;
      const b = list.find((i) => i.id === later.id)?.track;
      return a !== undefined && a === b;
    })
    .toBe(true);
});
