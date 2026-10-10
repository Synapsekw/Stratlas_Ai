/**
 * Annotations follow their survey date in the real app: hiding a date with its folder eye takes
 * that date's issues off the 3D view and the map, showing it brings them back, a single layer
 * shown again brings back what is marked on it, and the date bar's focus does the same as the
 * eyes. Issues of no date stay, and the register keeps every issue throughout.
 *
 * Runs on `e2e-three-dates` (4 Sep, 2 Oct, 6 Nov 2024) with a model common to every date and one
 * issue per kind of tie to a date. Off-screen, zero network.
 */
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openProject, test as base } from './fixtures';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A pin just above the tiny quad model (x 0 to 1, z -1 to 0). */
const pinAt = (layer: string, x: number, z: number) => ({
  on: 'mesh',
  layer,
  geom: { type: 'spoint', p: [x, 0.02, z], n: [0, 1, 0] },
});

const issue = (id: string, code: string, sighting: unknown, capture?: string) => ({
  id,
  code,
  classId: 'crack',
  severityModelId: 'sev',
  severity: 2,
  status: 'reviewed',
  title: `Crack ${code}`,
  note: '',
  author: 'E2E Reviewer',
  createdAt: '2024-11-07T08:00:00.000Z',
  updatedAt: '2024-11-07T08:00:00.000Z',
  source: 'human',
  sightings: [sighting],
  ...(capture ? { capture } : {}),
});

/** One issue per tie to a date: marked on a date's model, named by `capture`, and undated. */
const ISSUES = [
  issue('on-nov', 'F01', pinAt('quad-nov', 0.2, -0.2)),
  issue('on-sep', 'F02', pinAt('quad-sep', 0.8, -0.2)),
  // marked on the model common to every date, of October by its capture field
  issue('of-oct', 'F03', pinAt('plinth', 0.2, -0.8), 'oct'),
  issue('undated', 'F04', pinAt('plinth', 0.8, -0.8)),
];

/**
 * The three-date project with a model common to every date, a severity model and the issues
 * above, written before the app starts (list `datedIssues` before `win`).
 */
const test = base.extend<{ datedIssues: { id: string } }>({
  datedIssues: async ({ dataRoot, threeDateProject }, use) => {
    const dir = join(dataRoot.root, 'projects', threeDateProject.id);
    const file = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')) as {
      layers: unknown[];
      severityModels: unknown[];
      classCatalogues: unknown[];
    };
    manifest.layers.push({
      kind: 'mesh',
      id: 'plinth',
      name: 'Plinth',
      visible: true,
      src: { path: 'models/quad.glb' },
      transform: IDENTITY,
    });
    manifest.severityModels = [
      {
        id: 'sev',
        name: 'Severity',
        levels: [
          { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Monitor' },
          { value: 2, label: 'Moderate', color: '#f08c3c', criteria: 'Plan' },
        ],
      },
    ];
    manifest.classCatalogues = [
      {
        id: 'cat',
        name: 'Classes',
        assetType: 'facade',
        classes: [{ id: 'crack', label: 'Crack', color: '#ee3f4b', severityModel: 'sev' }],
      },
    ];
    await writeFile(file, JSON.stringify(manifest, null, 2));
    await writeFile(
      join(dir, 'issues.json'),
      JSON.stringify({ schema: 'aio.issues/1', issues: ISSUES }, null, 2),
    );
    await use(threeDateProject);
  },
});

test.setTimeout(120_000);

interface Layout {
  items: { members: { issueId: string }[] }[];
}

interface Probe {
  __stratlas: {
    workspace: { getState(): { issues: { id: string }[]; hidden: Record<string, true> } };
    stage(): {
      scene: { getObjectByName(name: string): { userData: { layout?: Layout } } | undefined };
    } | null;
  };
}

interface MapHost {
  __aioMap: {
    loaded(): boolean;
    getSource(id: string): { getData(): Promise<unknown> } | undefined;
  };
}

/** Ids of the issues the 3D pin overlay holds (in a pin or a count badge), sorted. */
const pins3d = (win: Page) =>
  win.evaluate(() => {
    const stage = (window as unknown as Probe).__stratlas.stage();
    const layout = stage?.scene.getObjectByName('annotate-issue-pins')?.userData.layout;
    return layout
      ? layout.items.flatMap((i) => i.members.map((m) => m.issueId)).sort()
      : ['no pin layout yet'];
  });

/** Ids of the issues in the map's issue sources (points, shaped points and the selected), sorted. */
const pinsMap = (win: Page) =>
  win.evaluate(async () => {
    const host = [...document.querySelectorAll('div')].find((d) => '__aioMap' in d) as
      (HTMLElement & MapHost) | undefined;
    const map = host?.__aioMap;
    if (!map?.loaded()) return ['map not loaded yet'];
    const ids: string[] = [];
    for (const id of ['aio-issues', 'aio-issues-far', 'aio-issues-focus']) {
      const data = (await map.getSource(id)?.getData()) as
        { features?: { properties?: { issueId?: string } }[] } | undefined;
      if (!data?.features) return [`no ${id} source yet`];
      for (const f of data.features) ids.push(f.properties?.issueId ?? '?');
    }
    return ids.sort();
  });

/** How many issues the workspace holds: hiding a date never removes one. */
const issueCount = (win: Page) =>
  win.evaluate(() => (window as unknown as Probe).__stratlas.workspace.getState().issues.length);

async function open(win: Page, id: string) {
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: 'E2E three dates' }).first().click();
  await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(id);
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 30_000 });
}

/** The eye of a date folder ("Hide everything from 6 Nov 2024"). */
const folderEye = (win: Page, date: string) =>
  // the folder's menu button shares the eye's look, so the eye is picked by its state attribute
  win.getByTestId(`date-folder-${date}`).locator('.dfolder-row .eye[data-visibility]');

test.describe('annotations follow their survey date', () => {
  test('the folder eye hides and shows the issues of its date in the 3D view', async ({
    datedIssues,
    win,
  }) => {
    await open(win, datedIssues.id);
    // opens on 6 Nov: September and October are off, and so are their issues
    await expect(win.getByTestId('date-bar-open')).toContainText('6 Nov 2024');
    await expect.poll(() => pins3d(win), { timeout: 30_000 }).toEqual(['on-nov', 'undated']);

    // each date's issues sit in its folder; the undated one under Every date
    const issuesRow = (folder: string) =>
      win.getByTestId(`date-folder-${folder}`).locator('.titem', { hasText: 'Issues' });
    await expect(issuesRow('nov')).toHaveCount(1);
    await expect(issuesRow('nov').locator('.tm')).toHaveText('1');
    await expect(issuesRow('every')).toHaveCount(1);
    await expect(issuesRow('every').locator('.tm')).toHaveText('1');

    // hide 6 Nov with its folder eye: its issue goes, the undated one stays
    await expect(folderEye(win, 'nov')).toHaveAttribute('aria-label', /Hide everything from/);
    await folderEye(win, 'nov').click();
    await expect(folderEye(win, 'nov')).toHaveAttribute('data-visibility', 'none');
    await expect.poll(() => pins3d(win)).toEqual(['undated']);
    // a hidden date's issue stays out even while it is selected
    await win.evaluate(() => {
      const ws = (
        window as unknown as {
          __stratlas: {
            workspace: { getState(): { select(s: { kind: string; id: string } | null): void } };
          };
        }
      ).__stratlas.workspace;
      ws.getState().select({ kind: 'issue', id: 'on-nov' });
    });
    await expect.poll(() => pins3d(win)).toEqual(['undated']);

    // show it again: the issue is back
    await folderEye(win, 'nov').click();
    await expect(folderEye(win, 'nov')).toHaveAttribute('data-visibility', 'all');
    await expect.poll(() => pins3d(win)).toEqual(['on-nov', 'undated']);

    // one layer of a hidden date shown again brings back the issue marked on it
    await win
      .getByTestId('date-folder-sep')
      .getByRole('button', { name: /Expand/ })
      .click();
    const sepSite = win
      .getByTestId('date-folder-sep')
      .locator('.titem', { hasText: 'Site' })
      .locator('.eye');
    const sepModel = win
      .getByTestId('date-folder-sep')
      .locator('.titem', { hasText: 'Quad' })
      .locator('.eye');
    // the site outline alone: September is on screen, but the issue is marked on its model
    await sepSite.click();
    await expect(win.getByTestId('date-on-sep')).toHaveText('1 on');
    await expect.poll(() => pins3d(win)).toEqual(['on-nov', 'undated']);
    await sepModel.click();
    await expect.poll(() => pins3d(win)).toEqual(['on-nov', 'on-sep', 'undated']);
    await sepModel.click();
    await sepSite.click();
    await expect.poll(() => pins3d(win)).toEqual(['on-nov', 'undated']);

    // an issue tied to a date only by its capture field follows any layer of that date
    await win
      .getByTestId('date-folder-oct')
      .getByRole('button', { name: /Expand/ })
      .click();
    await win
      .getByTestId('date-folder-oct')
      .locator('.titem', { hasText: 'Site' })
      .locator('.eye')
      .click();
    await expect.poll(() => pins3d(win)).toEqual(['of-oct', 'on-nov', 'undated']);
    await folderEye(win, 'oct').click(); // mixed: shows the rest of October
    await folderEye(win, 'oct').click(); // then hides it all
    await expect(folderEye(win, 'oct')).toHaveAttribute('data-visibility', 'none');
    await expect.poll(() => pins3d(win)).toEqual(['on-nov', 'undated']);

    // nothing was removed: the register still holds every issue
    expect(await issueCount(win)).toBe(ISSUES.length);
    await win.getByRole('tab', { name: /Issues/ }).click();
    for (const i of ISSUES) await expect(win.getByText(i.title).first()).toBeVisible();
  });

  test('the date bar focus and the map follow the same rule', async ({ datedIssues, win }) => {
    await open(win, datedIssues.id);
    await expect.poll(() => pins3d(win), { timeout: 30_000 }).toEqual(['on-nov', 'undated']);

    // focusing September swaps the dates, and their issues with them
    await win.getByTestId('date-name-sep').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('4 Sep 2024');
    await expect.poll(() => pins3d(win)).toEqual(['on-sep', 'undated']);

    // the map draws the same issues
    const bar = win.getByRole('toolbar', { name: 'Stage tools' });
    await bar.getByRole('button', { name: 'Map' }).click();
    await expect(win.locator('.maplibregl-canvas').first()).toBeVisible();
    await expect.poll(() => pinsMap(win), { timeout: 30_000 }).toEqual(['on-sep', 'undated']);

    await folderEye(win, 'sep').click();
    await expect(folderEye(win, 'sep')).toHaveAttribute('data-visibility', 'none');
    await expect.poll(() => pinsMap(win)).toEqual(['undated']);
    await folderEye(win, 'sep').click();
    await expect.poll(() => pinsMap(win)).toEqual(['on-sep', 'undated']);

    // October by its capture field: on the map once October is focused
    await win.getByTestId('date-name-oct').click();
    await expect(win.getByTestId('date-bar-open')).toContainText('2 Oct 2024');
    await expect.poll(() => pinsMap(win)).toEqual(['of-oct', 'undated']);
    expect(await issueCount(win)).toBe(ISSUES.length);
  });
});
