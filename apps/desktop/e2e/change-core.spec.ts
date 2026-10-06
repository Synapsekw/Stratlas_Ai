/**
 * M8 Change core (C1): Compare dates, Show changes, the Changes register of a synthetic two-date
 * project (no client data), a click flying both views, "Close as resolved", "Make issue" and the
 * reviews kept after reopening. The zero-network guard of the fixture stays on.
 *
 * The project is built here until C8's two-date demo lands; then this spec switches to C8's
 * `twoDateProject` fixture and asserts the counts of its `truth.json`.
 */
import { localToProject, toWgs84 } from '@aio/geo';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, tinyGlb, tinyManifest } from './fixtures';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DOWN = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const ORIGIN: [number, number, number] = [500000, 3200000, 0];
const EPSG = 32639;

type V3 = [number, number, number];
const lonLat = (p: V3) => {
  const [lon, lat] = toWgs84(localToProject(p, ORIGIN), EPSG);
  return [lon, lat];
};

const issue = (code: string, layer: string, p: V3, extra: Record<string, unknown> = {}) => ({
  id: `i-${code.toLowerCase()}`,
  code,
  classId: 'corrosion',
  severityModelId: 'sev',
  severity: 2,
  status: 'reviewed',
  title: `Synthetic ${code}`,
  note: '',
  author: 'e2e',
  createdAt: '2026-06-02T10:00:00Z',
  updatedAt: '2026-06-02T10:00:00Z',
  sightings: [{ on: 'mesh', layer, geom: { type: 'spoint', p, n: [0, 1, 0] } }],
  source: 'human',
  ...extra,
});
const area = (v: number) => ({ measurements: [{ kind: 'area', value: v, unit: 'm2' }] });

const track = (name: string, a: V3, b: V3) => ({
  type: 'Feature',
  properties: { name },
  geometry: { type: 'LineString', coordinates: [lonLat(a), lonLat(b)] },
});

/** The synthetic two-date site: a model, a posed photo set and a map layer per date. */
async function twoDateProject(root: string): Promise<string> {
  const dir = join(root, 'projects', 'e2e-change');
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'vectors'), { recursive: true });
  for (const d of ['d1', 'd2']) await writeFile(join(dir, 'models', `${d}.glb`), tinyGlb());
  const photos = (d: string) => ({
    kind: 'photos',
    id: `photos-${d}`,
    name: 'Inspection photos',
    visible: true,
    capture: d,
    items: [0, 20].map((x, i) => ({
      id: `${d}-p${String(i)}`,
      src: { path: `photos/${d}-p${String(i)}.jpg` },
      pos: [x, 50, 0],
      q: DOWN,
      lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.5 },
    })),
  });
  const layers = ['d1', 'd2'].flatMap((d) => [
    {
      kind: 'mesh',
      id: `model-${d}`,
      name: 'Site model',
      visible: true,
      capture: d,
      src: { path: `models/${d}.glb` },
      transform: IDENTITY,
    },
    photos(d),
    {
      kind: 'vector',
      id: `tracks-${d}`,
      name: 'Site tracks',
      visible: true,
      capture: d,
      src: { path: `vectors/tracks-${d}.geojson` },
      format: 'geojson',
    },
  ]);
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      ...tinyManifest(),
      id: 'e2e-change',
      name: 'E2E change site',
      origin: ORIGIN,
      captures: [
        { id: 'd1', label: 'First survey', date: '2026-01-01' },
        { id: 'd2', label: 'Second survey', date: '2026-06-01' },
      ],
      layers,
      severityModels: [
        {
          id: 'sev',
          name: 'Levels',
          levels: [1, 2, 3].map((v) => ({
            value: v,
            label: `Level ${String(v)}`,
            color: '#888888',
            criteria: '',
          })),
        },
      ],
      classCatalogues: [
        {
          id: 'cat',
          name: 'Defects',
          assetType: 'site',
          classes: [
            { id: 'corrosion', label: 'Corrosion', color: '#aa5500', severityModel: 'sev' },
          ],
        },
      ],
    }),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({
      schema: 'aio.issues/1',
      issues: [
        // grown: 1 m2 to 1.5 m2
        issue('F01', 'model-d1', [0, 0, 0], area(1)),
        issue('F11', 'model-d2', [0.2, 0, 0], area(1.5)),
        // resolved: gone, and a second-survey photo looked there
        issue('F02', 'model-d1', [10, 0, 0]),
        // unchanged
        issue('F03', 'model-d1', [20, 0, -5], area(1)),
        issue('F13', 'model-d2', [20, 0, -5], area(1)),
        // new
        issue('F12', 'model-d2', [5, 0, 8]),
      ],
    }),
  );
  const fc = (...features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
  await writeFile(
    join(dir, 'vectors', 'tracks-d1.geojson'),
    fc(track('Fence', [0, 0, 10], [30, 0, 10])),
  );
  await writeFile(
    join(dir, 'vectors', 'tracks-d2.geojson'),
    fc(track('Fence', [0, 0, 13], [30, 0, 13]), track('New track', [0, 0, -20], [30, 0, -20])),
  );
  return dir;
}

interface Inspect {
  __stratlas: {
    workspace: {
      getState(): {
        issues: {
          id: string;
          code: string;
          status: string;
          capture?: string;
          resolvedIn?: string;
        }[];
        camera: { target: { kind: string; p?: number[] } } | null;
        lastCamera: { target: { kind: string; p?: number[] } } | null;
      };
    };
    graphics(): { getState(): { tier: string; setOverride(t: string | null): void } };
    compare(): {
      second: unknown;
      changes: {
        main: { id: string; verdict: string; ghost: boolean; selected: boolean }[];
        second: { id: string; verdict: string; ghost: boolean; selected: boolean }[];
      };
    };
  };
}

const ws = (win: Page) =>
  win.evaluate(() => {
    const w = window as unknown as Inspect;
    const s = w.__stratlas.workspace.getState();
    return { issues: s.issues, last: s.lastCamera?.target ?? null };
  });
const pins = (win: Page) =>
  win.evaluate(() => (window as unknown as Inspect).__stratlas.compare().changes);

async function openProject(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'E2E change site' }).first().click();
  await expect(win.locator('[data-scene-view=""] canvas')).toBeVisible();
}

test('compare dates, show changes, review and make an issue', async ({ win, dataRoot }) => {
  test.setTimeout(120_000);
  const dir = await twoDateProject(dataRoot.root);
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await openProject(win);
  // two 3D views need the Medium tier (CI's software GPU is Low)
  await win.evaluate(() => {
    const g = (window as unknown as Inspect).__stratlas.graphics().getState();
    if (g.tier === 'low') g.setOverride('medium');
  });

  await win.getByTestId('compare-dates').click();
  await expect(win.locator('[data-scene-view] canvas')).toHaveCount(2);
  await win.getByTestId('compare-show-changes').click();
  await expect(win.getByTestId('compare-show-changes')).toHaveAttribute('aria-pressed', 'true');
  const panel = win.getByTestId('change-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('change-from')).toHaveValue('d1');
  await expect(panel.getByTestId('change-to')).toHaveValue('d2');

  await panel.getByTestId('change-run').click();
  await expect(panel.locator('[data-testid="change-row"][data-kind="issue"]')).toHaveCount(4);
  const verdicts = await panel
    .locator('[data-testid="change-row"][data-kind="issue"]')
    .evaluateAll((els): Record<string, string | null> =>
      Object.fromEntries(
        els.map((e) => [e.getAttribute('data-id') ?? '', e.getAttribute('data-verdict')]),
      ),
    );
  expect(verdicts).toEqual({
    'issue:F12': 'new',
    'issue:F01': 'grown',
    'issue:F02': 'resolved',
    'issue:F03': 'unchanged',
  });
  const vectors = await panel
    .locator('[data-testid="change-row"][data-kind="vector"]')
    .evaluateAll((els) => els.map((e) => [e.getAttribute('data-verdict'), e.textContent]));
  expect(vectors.map((v) => v[0]).sort()).toEqual(['added', 'moved']);
  expect(vectors.find((v) => v[0] === 'moved')?.[1]).toMatch(/Fence moved 3(\.0\d)? m/);

  // pins on both views: the new issue is a ghost on the earlier date
  await expect
    .poll(async () => {
      const p = await pins(win);
      return [
        p.main.find((m) => m.id === 'issue:F12')?.ghost,
        p.second.find((m) => m.id === 'issue:F12')?.ghost,
      ];
    })
    .toEqual([true, false]);

  // click the new issue: both views fly to it and it is outlined on both dates
  await panel.locator('[data-testid="change-row"][data-id="issue:F12"]').click();
  await expect
    .poll(async () => (await ws(win)).last)
    .toEqual({
      kind: 'point',
      p: [5, 0, 8],
      distance: 25,
    });
  await expect
    .poll(async () => {
      const p = await pins(win);
      return [
        p.main.find((m) => m.id === 'issue:F12')?.selected,
        p.second.find((m) => m.id === 'issue:F12')?.selected,
      ];
    })
    .toEqual([true, true]);

  // a person closes the resolved issue; nothing closed it before
  expect((await ws(win)).issues.find((i) => i.code === 'F02')?.status).toBe('reviewed');
  await panel.locator('[data-testid="change-row"][data-id="issue:F02"]').click();
  await panel.getByTestId('change-close-resolved').click();
  await panel.getByTestId('change-close-yes').click();
  await expect
    .poll(async () => (await ws(win)).issues.find((i) => i.code === 'F02'))
    .toMatchObject({ status: 'closed', resolvedIn: 'd2' });

  // make an issue from the added track: a draft issue on the later date
  const added = panel.locator('[data-testid="change-row"][data-verdict="added"]');
  await added.click();
  await panel.getByTestId('change-make-issue').click();
  await expect.poll(async () => (await ws(win)).issues.length).toBe(7);
  const made = (await ws(win)).issues.find(
    (i) => !['F01', 'F11', 'F02', 'F03', 'F13', 'F12'].includes(i.code),
  );
  expect(made).toMatchObject({ status: 'draft', capture: 'd2' });
  await expect(added).toHaveAttribute('data-status', 'confirmed');

  // the reviews and issues are on disk, and survive reopening
  await expect
    .poll(async () => {
      const text = await readFile(join(dir, 'issues.json'), 'utf8').catch(() => '');
      return text.includes('"resolvedIn": "d2"');
    })
    .toBe(true);
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await openProject(win);
  await win.getByTestId('tab-changes').click();
  const again = win.getByTestId('change-panel');
  await expect(again.locator('[data-testid="change-row"][data-id="issue:F02"]')).toHaveAttribute(
    'data-status',
    'confirmed',
  );
  await expect(again.locator('[data-testid="change-row"][data-verdict="added"]')).toHaveAttribute(
    'data-status',
    'confirmed',
  );
  await expect
    .poll(async () => (await ws(win)).issues.find((i) => i.code === 'F02')?.status)
    .toBe('closed');

  // "Belongs to date...": a layer's explicit survey date, saved in the manifest
  await win.evaluate(() => {
    const w = window as unknown as {
      __stratlas: { workspace: { getState(): { select(s: unknown): void } } };
    };
    w.__stratlas.workspace
      .getState()
      .select({ kind: 'layer', id: 'photos-d1', layer: 'photos-d1' });
  });
  await win.getByRole('tab', { name: 'Selection' }).click();
  const picker = win.getByTestId('layer-survey-date').locator('select');
  await expect(picker).toHaveValue('d1');
  await picker.selectOption('d2');
  await expect
    .poll(async () => {
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
        layers: { id: string; capture?: string }[];
      };
      return m.layers.find((l) => l.id === 'photos-d1')?.capture;
    })
    .toBe('d2');
});
