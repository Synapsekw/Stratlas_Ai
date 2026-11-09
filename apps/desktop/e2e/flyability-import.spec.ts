import { ProjectManifest } from '@aio/schema';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  expect,
  hasPdal,
  hasPipelinePython,
  PIPELINE_ENV,
  processingChip,
  test,
  tinyManifest,
  VENV_PYTHON,
} from './fixtures';
import { stageModeButton } from './island';
import { hasRealData, REALDATA, realDataPath } from './realData';

/**
 * The Flyability Inspector import end to end, on a synthetic export (python/tests/flyability_synth.py,
 * a 10 x 6 x 4 m room with two flights and three findings, one of them placed where the cloud
 * disagrees; no client data) against the development pipeline runtime (Python with aio_pipelines
 * and PDAL, as the Bentley import spec). The project starts empty, so the first inspection is its
 * only space: no space crumb, the Layers column holds the clouds and the Flight lines group, and
 * the Issues list holds the findings. Move point survives a re-import of the same export, and a
 * second inspection makes a second space (the crumb, one space's layers at a time, no Map).
 *
 * Without the pipeline Python or PDAL the specs skip with the reason. Run them the CI way
 * (CONTRIBUTING.md, "End to end the way CI runs it") with QUADRION_E2E_PYTHON set to the venv
 * Python. The real-data case needs a real export in `<real data root>/flyability`.
 */
const SYNTH = join(import.meta.dirname, '..', '..', '..', 'python', 'tests', 'flyability_synth.py');
const REPO = join(import.meta.dirname, '..', '..', '..');
const SPACE_NAME = 'Synthetic room';

interface Synth {
  root: string;
  inspection_id: string;
  flight_ids: string[];
  poi_ids: string[];
}

interface IssueLite {
  id: string;
  code: string;
  sightings: { on: string; layer: string; geom: { type: string; p?: number[] } }[];
  external?: { locationCheck: string; poi: string };
}

let scratch = '';
let first: Synth;

/** Same-length replacement of every id of the export, so a second inspection can sit beside it. */
async function cloneAsSecond(src: string, dst: string): Promise<string> {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const swap = (id: string) => (id.startsWith('f') ? 'e' : 'f') + id.slice(1);
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const e of await readdir(from, { withFileTypes: true })) {
      const target = join(to, e.name.replace(uuid, swap));
      if (e.isDirectory()) {
        await walk(join(from, e.name), target);
        continue;
      }
      const bytes = (await readFile(join(from, e.name))).toString('latin1').replace(uuid, swap);
      const text = /\.(json|backup)$/.test(e.name)
        ? bytes.replaceAll(SPACE_NAME, 'Second chamber')
        : bytes;
      await writeFile(target, Buffer.from(text, 'latin1'));
    }
  };
  await walk(src, dst);
  return dst;
}

test.describe('Flyability Inspector import', () => {
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!hasPdal(), 'the clouds need PDAL (AIO_PDAL)');
  test.use({ appEnv: PIPELINE_ENV });

  test.beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'aio-fly-'));
    first = JSON.parse(
      // as dense as the pipeline tests' cloud: sparser, no camera ray meets a wall (all "no-hit")
      execFileSync(VENV_PYTHON, ['-I', SYNTH, join(scratch, 'one'), '--points', '100000'], {
        cwd: REPO,
        encoding: 'utf8',
      }).trim(),
    ) as Synth;
  });

  test.afterAll(async () => {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test.beforeEach(async ({ dataRoot }) => {
    // an empty project: the inspection will be its only space
    const m = ProjectManifest.parse({ ...tinyManifest(), layers: [] });
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(m, null, 2));
  });

  const manifestOf = async (dir: string) =>
    ProjectManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));

  const issuesOf = async (dir: string): Promise<IssueLite[]> => {
    try {
      const raw = JSON.parse(await readFile(join(dir, 'issues.json'), 'utf8')) as
        { issues: IssueLite[] } | IssueLite[];
      return Array.isArray(raw) ? raw : raw.issues;
    } catch {
      return [];
    }
  };
  const flyIssues = async (dir: string) => (await issuesOf(dir)).filter((i) => i.external);

  /** Every open dialog answers with this folder. */
  async function answerFolder(app: ElectronApplication, folder: string): Promise<void> {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, folder);
  }

  async function openTinyProject(win: Page): Promise<void> {
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.getByTestId('crumb-project')).toBeVisible({ timeout: 30_000 });
  }

  /** The project's right-click menu (the Layers header), "Flyability Inspector export...". */
  async function openPicker(win: Page): Promise<void> {
    await win.locator('.sb-tree .tree-h .caps').click({ button: 'right' });
    await win.getByTestId('ctx-item-project.addInspector').click();
    await expect(win.getByTestId('inspector-list')).toBeVisible({ timeout: 30_000 });
  }

  /** The jobs of the open project have run to the end (the chip is back to idle or hidden). */
  async function jobsSettled(win: Page): Promise<void> {
    const running = ['one', 'many'];
    await expect
      .poll(
        async () => running.includes((await processingChip(win).getAttribute('data-state')) ?? ''),
        {
          timeout: 20_000,
        },
      )
      .toBe(true)
      .catch(() => undefined);
    await expect
      .poll(
        async () => {
          if ((await processingChip(win).count()) === 0) return true;
          return !running.includes((await processingChip(win).getAttribute('data-state')) ?? '');
        },
        { timeout: 180_000 },
      )
      .toBe(true);
  }

  /** Pick the folder, import everything the picker offers, wait for the job to finish. */
  async function importFolder(app: ElectronApplication, win: Page, folder: string): Promise<void> {
    await answerFolder(app, folder);
    await openPicker(win);
    await win.getByTestId('inspector-import').click();
    await expect(win.getByTestId('inspector-list')).toBeHidden();
    await jobsSettled(win);
  }

  /** Unfold the Point clouds group (kind groups start folded) so the cloud rows are drawn. */
  async function openCloudGroup(win: Page): Promise<void> {
    const group = win.getByTestId('tree-group-toggle-pointclouds');
    await expect(group).toBeVisible({ timeout: 30_000 });
    if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
  }

  /** The Issues screen's register filtered to one code; its row. */
  async function issueRow(win: Page, code: string) {
    await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).first().click();
    const register = win.getByTestId('issue-register');
    await register.getByRole('searchbox', { name: 'Search issues' }).fill(code);
    return register.getByRole('row', { name: new RegExp(`^(Select ${code} )?${code} `) });
  }

  test('imports a synthetic export as a space with clouds, paths and findings', async ({
    dataRoot,
    app,
    win,
  }) => {
    test.setTimeout(300_000);
    await openTinyProject(win);
    await answerFolder(app, first.root);
    await openPicker(win);

    // one inspection with its two flights and its three findings
    const row = win.getByTestId(`inspector-row-${first.inspection_id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('3 findings');
    for (const id of first.flight_ids)
      await expect(win.getByTestId(`inspector-flight-${id}`)).toBeVisible();
    await expect(win.getByTestId(`inspector-imported-${first.inspection_id}`)).toHaveCount(0);

    await win.getByTestId('inspector-import').click();
    await expect(win.getByTestId('inspector-list')).toBeHidden();

    // the job finishes: the space, its clouds and flight lines, and the findings are on disk
    await expect
      .poll(async () => (await flyIssues(dataRoot.projectDir)).length, { timeout: 240_000 })
      .toBe(3);
    await expect
      .poll(
        async () => {
          const m = await manifestOf(dataRoot.projectDir);
          return m.layers.some((l) => l.kind === 'flightline');
        },
        { timeout: 240_000 },
      )
      .toBe(true);
    await jobsSettled(win);
    const m = await manifestOf(dataRoot.projectDir);
    expect(m.spaces).toHaveLength(1);
    expect(m.spaces?.[0]?.source).toMatchObject({
      kind: 'flyability',
      inspectionId: first.inspection_id,
    });
    const clouds = m.layers.filter((l) => l.kind === 'pointcloud');
    expect(clouds.length).toBeGreaterThan(0);
    for (const l of m.layers) expect(l.space).toBe(m.spaces?.[0]?.id);

    // one space: no crumb; the Layers column holds the Flight lines group and the clouds
    await expect(win.getByTestId('crumb-space')).toHaveCount(0);
    await expect(win.getByTestId('tree-group-flightlines')).toBeVisible({ timeout: 30_000 });
    await openCloudGroup(win);
    for (const c of clouds) await expect(win.getByTestId(`tree-row-${c.id}`)).toBeVisible();

    // three findings, one flagged by the location check
    const found = await flyIssues(dataRoot.projectDir);
    const flagged = found.filter((i) => i.external?.locationCheck === 'disagrees');
    expect(flagged).toHaveLength(1);
    const flaggedRow = await issueRow(win, flagged[0]?.code ?? '');
    await expect(flaggedRow).toBeVisible();
    for (const i of found) {
      await win
        .getByTestId('issue-register')
        .getByRole('searchbox', { name: 'Search issues' })
        .fill(i.code);
      await expect(
        win
          .getByTestId('issue-register')
          .getByRole('row', { name: new RegExp(`^(Select ${i.code} )?${i.code} `) }),
      ).toBeVisible();
    }
    await win
      .getByTestId('issue-register')
      .getByRole('searchbox', { name: 'Search issues' })
      .fill(flagged[0]?.code ?? '');
    await flaggedRow.click();
    await expect(win.getByTestId('fly-location-check').first()).toHaveAttribute(
      'data-tone',
      'warn',
    );
  });

  test('moving a finding point survives a re-import', async ({ dataRoot, app, win }) => {
    test.setTimeout(360_000);
    await openTinyProject(win);
    await importFolder(app, win, first.root);
    await expect
      .poll(async () => (await flyIssues(dataRoot.projectDir)).length, { timeout: 60_000 })
      .toBe(3);
    const target = (await flyIssues(dataRoot.projectDir)).find(
      (i) => i.external?.locationCheck === 'agrees',
    );
    if (!target) throw new Error('no finding agrees with the cloud in the synthetic export');
    const before = target.sightings.find((s) => s.on === 'pointcloud');

    // right-click the row, Move point, then click the cloud until the point lands on it
    const row = await issueRow(win, target.code);
    await row.click({ button: 'right' });
    await win.getByTestId('finding-move-point').click();
    await expect(win.getByTestId('fly-move-prompt')).toBeVisible();
    const canvas = win.locator('[data-scene-view] canvas').first();
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no 3D view');
    const spots = [
      [0.5, 0.5],
      [0.42, 0.5],
      [0.58, 0.5],
      [0.5, 0.42],
      [0.5, 0.58],
      [0.35, 0.35],
      [0.65, 0.65],
      [0.35, 0.65],
      [0.65, 0.35],
    ] as const;
    const undo = win.getByTestId('fly-move-undo');
    let moved = false;
    for (let round = 0; round < 3 && !moved; round++) {
      for (const [fx, fy] of spots) {
        await win.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
        if (await undo.isVisible().catch(() => false)) {
          moved = true;
          break;
        }
        try {
          await expect(undo).toBeVisible({ timeout: 800 });
          moved = true;
          break;
        } catch {
          // no cloud under that spot: the session stays open, try the next
        }
      }
    }
    expect(moved, 'a click on the cloud moved the point').toBe(true);

    const movedIssue = async () =>
      (await flyIssues(dataRoot.projectDir)).find((i) => i.id === target.id);
    await expect
      .poll(async () => (await movedIssue())?.external?.locationCheck, { timeout: 30_000 })
      .toBe('moved');
    const after = (await movedIssue())?.sightings.find((s) => s.on === 'pointcloud');
    expect(after?.geom.p).not.toEqual(before?.geom.p);

    // the same export again: the picker says it merges, and the moved point is kept
    await answerFolder(app, first.root);
    await openPicker(win);
    await expect(win.getByTestId(`inspector-imported-${first.inspection_id}`)).toBeVisible();
    // an imported inspection starts unticked (pickerModel initialChoice): tick it to merge again
    const tick = win.getByTestId(`inspector-tick-${first.inspection_id}`);
    await expect(tick).not.toBeChecked();
    await expect(win.getByTestId('inspector-import')).toBeDisabled();
    await tick.check();
    await win.getByTestId('inspector-import').click();
    await expect(win.getByTestId('inspector-list')).toBeHidden();
    await jobsSettled(win);
    const kept = (await flyIssues(dataRoot.projectDir)).find((i) => i.id === target.id);
    expect(kept?.external?.locationCheck).toBe('moved');
    expect(kept?.sightings.find((s) => s.on === 'pointcloud')?.geom.p).toEqual(after?.geom.p);
    expect(await flyIssues(dataRoot.projectDir)).toHaveLength(3);
    expect((await manifestOf(dataRoot.projectDir)).spaces).toHaveLength(1);
  });

  test('a second inspection is a second space, with its own layers and no map', async ({
    dataRoot,
    app,
    win,
  }) => {
    test.setTimeout(420_000);
    const second = await cloneAsSecond(first.root, join(scratch, 'two'));
    await openTinyProject(win);
    await importFolder(app, win, first.root);
    await importFolder(app, win, second);
    await expect
      .poll(async () => (await manifestOf(dataRoot.projectDir)).spaces?.length, {
        timeout: 120_000,
      })
      .toBe(2);
    const m = await manifestOf(dataRoot.projectDir);
    const spaces = m.spaces ?? [];
    const cloudsOf = (id: string) =>
      m.layers.filter((l) => l.kind === 'pointcloud' && l.space === id).map((l) => l.id);
    for (const s of spaces) expect(cloudsOf(s.id).length).toBeGreaterThan(0);

    // two spaces: the crumb is there, and the Layers column follows the space picked
    await expect(win.getByTestId('crumb-space')).toBeVisible();
    for (const [i, s] of spaces.entries()) {
      const other = spaces[1 - i];
      await win.getByTestId('crumb-space').click();
      await win.getByTestId(`crumb-space-${s.id}`).click();
      await openCloudGroup(win);
      for (const id of cloudsOf(s.id))
        await expect(win.getByTestId(`tree-row-${id}`)).toBeVisible();
      for (const id of cloudsOf(other?.id ?? '')) {
        await expect(win.getByTestId(`tree-row-${id}`)).toHaveCount(0);
      }
      // a space with its own frame has no map: Map is greyed and says why
      await win.locator('.sb-nav .nav-item', { hasText: 'Scene' }).first().click();
      const map = await stageModeButton(win, 'Map');
      await expect(map).toHaveAttribute('aria-disabled', 'true');
      await expect(map).toContainText('No map: this space has its own frame');
    }
  });

  test('a mission folder picked whole imports its two chambers as two spaces', async ({
    dataRoot,
    app,
    win,
  }) => {
    test.setTimeout(600_000);
    // a mission folder as a field team leaves it: raw drone data, a report, a note, and the two
    // chambers' exports two levels down
    const mission = join(scratch, 'Mission 1');
    await rm(mission, { recursive: true, force: true });
    await cp(first.root, join(mission, 'Drone', 'Exports', 'Chamber A'), { recursive: true });
    await cloneAsSecond(first.root, join(mission, 'Drone', 'Exports', 'Chamber B'));
    await mkdir(join(mission, 'Raw drone data', 'Flight 1'), { recursive: true });
    await writeFile(join(mission, 'Raw drone data', 'Flight 1', 'clip.mov'), 'x');
    await mkdir(join(mission, 'Reports'), { recursive: true });
    await writeFile(join(mission, 'Reports', 'report.pdf'), 'x');
    await writeFile(join(mission, 'notes.txt'), 'x');

    await openTinyProject(win);
    await answerFolder(app, mission);
    await openPicker(win);
    // both chambers, named after their folders, ticked; what was found and what was left out
    await expect(win.getByTestId('inspector-summary')).toContainText('2 chambers');
    await expect(win.getByTestId('inspector-summary')).toContainText('point clouds');
    await expect(win.getByTestId('inspector-skipped')).toContainText(
      'Skipped 2 other folders, Skipped 1 loose file',
    );
    for (const [k, name] of ['Chamber A', 'Chamber B'].entries()) {
      await expect(win.getByTestId(`inspector-chamber-${String(k)}`)).toContainText(name);
      await expect(win.getByTestId(`inspector-chamber-${String(k)}`)).toContainText('3 findings');
      await expect(win.getByTestId(`inspector-chamber-tick-${String(k)}`)).toBeChecked();
    }
    await win.getByTestId('inspector-import').click();
    await expect(win.getByTestId('inspector-list')).toBeHidden();

    // the chambers run one after the other; each lands in its own space with its clouds
    const cloudsIn = (m: ProjectManifest, id: string) =>
      m.layers.filter((l) => l.kind === 'pointcloud' && l.space === id).length;
    await expect
      .poll(
        async () => {
          const m = await manifestOf(dataRoot.projectDir);
          return (m.spaces ?? []).filter((s) => cloudsIn(m, s.id) > 0).length;
        },
        { timeout: 540_000 },
      )
      .toBe(2);
    await jobsSettled(win);
    const m = await manifestOf(dataRoot.projectDir);
    expect((m.spaces ?? []).map((s) => s.name).sort()).toEqual(['Chamber A', 'Chamber B']);
    expect(await flyIssues(dataRoot.projectDir)).toHaveLength(6);
    await expect(win.getByTestId('crumb-space')).toBeVisible();
  });
});

test.describe(`${REALDATA} Flyability Inspector real export`, () => {
  test.skip(!hasRealData('flyability'), 'no real export under <real data root>/flyability');
  test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);
  test.skip(!hasPdal(), 'the clouds need PDAL (AIO_PDAL)');
  test.use({ appEnv: PIPELINE_ENV });

  test(`${REALDATA} imports a real export`, async ({ dataRoot, app, win }) => {
    test.setTimeout(900_000);
    const m0 = ProjectManifest.parse({ ...tinyManifest(), layers: [] });
    await writeFile(join(dataRoot.projectDir, 'manifest.json'), JSON.stringify(m0, null, 2));
    await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).first().click();
    await expect(win.getByTestId('crumb-project')).toBeVisible({ timeout: 30_000 });
    // the export is only read: the folder is the picker's input, the project is the temp one
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, realDataPath('flyability'));
    await win.locator('.sb-tree .tree-h .caps').click({ button: 'right' });
    await win.getByTestId('ctx-item-project.addInspector').click();
    await expect(win.getByTestId('inspector-list')).toBeVisible({ timeout: 60_000 });
    await win.getByTestId('inspector-import').click();
    await expect
      .poll(
        async () =>
          (
            ProjectManifest.parse(
              JSON.parse(await readFile(join(dataRoot.projectDir, 'manifest.json'), 'utf8')),
            ).spaces ?? []
          ).filter((s) => s.source?.kind === 'flyability').length,
        { timeout: 840_000 },
      )
      .toBeGreaterThan(0);
    // the spec does not look at the content, only that the import left a space and no error
    await expect(win.getByTestId('inspector-import-failed')).toHaveCount(0);
  });
});
