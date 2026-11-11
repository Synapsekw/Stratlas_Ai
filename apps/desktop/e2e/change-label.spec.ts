/**
 * Label with AI on a change region (V4 change labels), on the change demo (synthetic, no client
 * data). A region set over truth's first imagery change is written into the working copy (the
 * pipeline that finds regions is change-area.spec's subject, not this one's); the Changes tab
 * lists it; Label with AI sends a crop of the region on each date's ortho through the Compare
 * route and the row shows the label, which is saved on the region in the set file and survives
 * reopening.
 *
 * Stand-in: the cloud is the scripted test model (`QUADRION_AI_TEST_PROVIDER=1` with the isolated
 * profile): no key, no network. It answers a choice field with its first choice, "material
 * added". Never `@realdata`.
 */
import { ChangeSet, type ChangeSetInput } from '@aio/schema';
import type { Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openChangeDemo, test } from './fixtures';
import { openBench } from './island';

test.setTimeout(180_000);
test.use({ appEnv: { QUADRION_AI_TEST_PROVIDER: '1' } });

const SET_ID = 'd1-d2-e2e-label';
const REGION = 'region:e2e-1';

interface RasterTruth {
  expected: { id: string; verdict: string; outlineLocal: [number, number][] }[];
}

/** Cloud AI on, set in Settings as a person does (a new install starts on; this says so). */
async function cloudOn(win: Page): Promise<void> {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'Privacy and cloud' }).click();
  const cloud = win.getByRole('switch', { name: 'Allow cloud AI' });
  if ((await cloud.getAttribute('aria-checked')) !== 'true') await cloud.click();
  await expect(cloud).toHaveAttribute('aria-checked', 'true');
}

/** One region set over truth's first imagery change, in the project's local frame. */
function regionSet(raster: RasterTruth, from: string, to: string): ChangeSetInput {
  const change = raster.expected[0];
  if (!change) throw new Error('no imagery change in truth.json');
  const xs = change.outlineLocal.map((p) => p[0]);
  const zs = change.outlineLocal.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  return ChangeSet.parse({
    schema: 'aio.change/1',
    id: SET_ID,
    from,
    to,
    producer: 'change.raster',
    createdAt: '2026-11-11T08:00:00Z',
    items: [
      {
        kind: 'region',
        id: REGION,
        verdict: 'changed',
        label: `Changed area of ${String((x1 - x0) * (z1 - z0))} m²`,
        at: [(x0 + x1) / 2, 0, (z0 + z1) / 2],
        bounds: { min: [x0, 0, z0], max: [x1, 0, z1] },
        outlineLocal: change.outlineLocal.map(([x, z]) => [x, 0, z]),
        areaM2: (x1 - x0) * (z1 - z0),
      },
    ],
  });
}

test('Label with AI names what changed in a region and keeps it on the set', async ({
  demoProject,
}) => {
  const { win, root, truth } = demoProject;
  await mkdir(join(root, 'change'), { recursive: true });
  const file = join(root, 'change', `${SET_ID}.json`);
  await writeFile(
    file,
    JSON.stringify(
      regionSet(
        truth.changes.raster as unknown as RasterTruth,
        truth.captures.from,
        truth.captures.to,
      ),
      null,
      1,
    ),
  );
  await cloudOn(win);
  await openChangeDemo(win);
  const panel = await openBench(win, 'changes');
  await expect(panel.getByTestId('change-panel')).toBeVisible();

  const row = panel.locator(`[data-testid="change-row"][data-id="${REGION}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('change-ai-label')).toHaveCount(0);
  await row.click();
  const run = panel.getByTestId('change-ai-label-run');
  await expect(run).toBeEnabled();
  await expect(run).toHaveText('Label with AI');
  await run.click();

  const chip = row.getByTestId('change-ai-label');
  await expect(chip).toHaveAttribute('data-kind', 'material-added');
  await expect(chip).toContainText('AI: Material added');
  await expect(panel.getByTestId('change-ai-label-error')).toHaveCount(0);
  await expect(run).toHaveText('Label again');

  // saved on the region in the set file, with the model and the time
  await expect
    .poll(async () => {
      const set = ChangeSet.parse(JSON.parse(await readFile(file, 'utf8')));
      const item = set.items.find((i) => i.id === REGION);
      return item?.kind === 'region' ? item.aiLabel : undefined;
    })
    .toMatchObject({ kind: 'material-added', model: expect.any(String) });

  // and shown again after the project is opened anew
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await openChangeDemo(win);
  const again = await openBench(win, 'changes');
  await expect(
    again.locator(`[data-testid="change-row"][data-id="${REGION}"]`).getByTestId('change-ai-label'),
  ).toHaveAttribute('data-kind', 'material-added');
});
