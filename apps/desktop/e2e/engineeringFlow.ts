/**
 * Shared helpers for the engineering model end to end specs (`engineering-flow.spec.ts`,
 * `engineering-corrections.spec.ts`): the synthetic chimney project, the setup steps, the run to
 * review, the agent's approvals and the files the run writes. Synthetic data only.
 */
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, PIPELINE_ENV, VENV_PYTHON, type DataRoot } from './fixtures';

export const FIXTURE = join(import.meta.dirname, 'engineering-fixture.py');
export const PROJECT = { id: 'e2e-eng-flow', name: 'E2E engineering chimney' };
export const ENV = { ...PIPELINE_ENV, QUADRION_AI_TEST_PROVIDER: '1' };

export interface Assembly {
  id: string;
  kind: string;
  status: string;
  params: Record<string, unknown>;
}
export interface Model {
  id: string;
  assemblies: Assembly[];
  scale?: { status?: string };
  georef?: { horizontal: { status: string } };
}

/** The synthetic project: the cloud layer, and one photo outside the project (for Add photos). */
export async function writeProject(
  dataRoot: DataRoot,
  id: string = PROJECT.id,
): Promise<EngProject> {
  const dir = join(dataRoot.root, 'projects', id);
  const photos = join(dataRoot.base, 'photos');
  await mkdir(dir, { recursive: true });
  execFileSync(VENV_PYTHON, [FIXTURE, dir, photos], { encoding: 'utf8' });
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id,
    name: PROJECT.name,
    customer: 'E2E',
    site: 'Synthetic site',
    crs: { epsg: 32633 },
    origin: [500000, 3200000, 10],
    captures: [],
    layers: [
      {
        kind: 'pointcloud',
        id: 'scan',
        name: 'Chimney scan',
        src: { path: 'clouds/scan.las' },
        format: 'copc',
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  await writeFile(
    join(dir, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }, null, 2),
  );
  return { dir, photo: join(photos, 'synth_01.jpg') };
}

export interface EngProject {
  dir: string;
  photo: string;
}

/**
 * The `eng` fixture: the synthetic project written into the data root before the app opens. A
 * spec makes its test with `test.extend<{ eng: EngProject }>({ eng: engFixture })`.
 */
export async function engFixture(
  { dataRoot }: { dataRoot: DataRoot },
  use: (eng: EngProject) => Promise<void>,
): Promise<void> {
  await use(await writeProject(dataRoot));
}

export async function openProject(win: Page, id: string = PROJECT.id) {
  // cloud AI on for this workstation (the scripted provider answers; nothing leaves)
  await win.evaluate(() => window.aio.invoke('settings:set', { cloudAi: true }));
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: PROJECT.name }).first().click();
  await expect
    .poll(
      () =>
        win.evaluate(
          () =>
            (
              window as unknown as {
                __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
              }
            ).__stratlas.workspace.getState().project?.id ?? null,
        ),
      { timeout: 60_000 },
    )
    .toBe(id);
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
}

export async function setupStep(setup: Locator, step: number) {
  // Drive the same buttons a person uses; hidden controls never get force-clicked.
  while (step === 0 && (await setup.getByRole('button', { name: 'Back', exact: true }).isVisible()))
    await setup.getByRole('button', { name: 'Back', exact: true }).click();
  if (
    step > 0 &&
    !(await setup.getByTestId('eng-detail-fast').isVisible()) &&
    !(await setup.getByTestId('eng-start').isVisible())
  )
    await setup.getByTestId('eng-next').click();
  if (step === 2 && !(await setup.getByTestId('eng-start').isVisible()))
    await setup.getByTestId('eng-next').click();
  if (step === 1 && (await setup.getByTestId('eng-start').isVisible()))
    await setup.getByRole('button', { name: 'Back', exact: true }).click();
}
export async function startSetup(setup: Locator) {
  await setupStep(setup, 2);
  await setup.getByTestId('eng-start').click();
}
export async function openReview(win: Page) {
  if (!(await win.getByTestId('eng-model-review').isVisible()))
    await win.getByTestId('eng-review').click();
  const bench = win.locator('#wb-panel-review').getByTestId('review-bench');
  await expect(bench).toBeVisible();
  await expect(win.locator('#wb-tab-review')).toHaveAttribute('aria-selected', 'true');
  await expect(bench.getByTestId('eng-model-review')).toBeVisible();
  // Reviewing must leave a usable 3D view beside the tab, not an inspector over the model.
  const canvas = win.locator('[data-scene-view] canvas').first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return (
          r.width > 100 &&
          r.height > 100 &&
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === element
        );
      }),
    )
    .toBe(true);
}

/** Confirm every send the run asks for (allow the kinds for the project, then send). */
export async function confirmSends(win: Page, until: () => Promise<boolean>) {
  const dialog = win.locator('.ag-ev').first();
  for (let i = 0; i < 40 && !(await until()); i++) {
    if (await dialog.isVisible().catch(() => false)) {
      const allow = dialog.getByRole('button', { name: 'Allow for this project' });
      // each kind once; the list redraws after every allow
      for (let k = 0; k < 3 && (await allow.count()) > 0; k++) {
        await allow.first().click();
        await win.waitForTimeout(200);
      }
      await dialog.getByRole('button', { name: 'Approve and build' }).click();
    }
    await win.waitForTimeout(1000);
  }
}

/** A stage's status in the run panel, or null while the panel does not show it (never waits). */
export const stageStatus = (win: Page, stage: string) =>
  win.evaluate(
    (s) =>
      document
        .querySelector(`[data-testid="eng-stage"][data-stage="${s}"]`)
        ?.getAttribute('data-status') ??
      (s === 'review' && document.querySelector('[data-testid="eng-model-review"]')
        ? 'done'
        : null),
    stage,
  );

/** Start, confirm the sends (or not), and wait for the review stage. */
export async function runToReview(win: Page, o: { send: boolean } = { send: true }) {
  if (o.send) await confirmSends(win, async () => (await stageStatus(win, 'review')) === 'done');
  await expect.poll(() => stageStatus(win, 'review'), { timeout: 240_000 }).toBe('done');
}

export interface RunFile {
  setup: {
    placement: string;
    anchor?: number[];
    region?: { centre: number[]; radiusM: number };
    detail: string;
  };
  usage: { costUsd: number; inputTokens: number };
  stages: Record<string, { status: string; message?: string }>;
  reconstruction?: string;
  corrections?: {
    status: string;
    target: { kind: string };
    history: { disposition: string }[];
    replies: { comment: string }[];
  }[];
}

export async function readRun(dir: string): Promise<RunFile> {
  const runs = (await readdir(join(dir, 'engineering'))).filter((f) => f.startsWith('run-'));
  const last = runs.sort().at(-1);
  if (!last) throw new Error('no run');
  return JSON.parse(await readFile(join(dir, 'engineering', last, 'run.json'), 'utf8')) as RunFile;
}

export const agent = (win: Page) => win.getByRole('region', { name: 'Agent' });

export async function ask(win: Page, text: string) {
  const box = agent(win).getByRole('textbox', { name: 'Message the agent' });
  // A live workbench can minimise the agent; use its normal keyboard entry point.
  if (!(await box.isVisible())) await win.keyboard.press('Control+j');
  await expect(box).toBeVisible();
  await expect(box).toBeEnabled();
  await box.fill(text);
  await box.press('Enter');
}

/** The agent's first send in a project stops at its preview; later ones go straight out. */
export async function approveAgent(win: Page, tool: string) {
  const preview = win.getByRole('dialog', { name: /^Send to / });
  if (await preview.isVisible().catch(() => false))
    await preview.getByRole('button', { name: 'Send' }).click();
  await expect(agent(win).locator('.step.awaiting')).toContainText(tool, { timeout: 30_000 });
  await agent(win).getByRole('button', { name: 'Approve' }).click();
  await expect(agent(win).locator('.step.done').last()).toBeVisible({ timeout: 30_000 });
}

export async function readModel(dir: string): Promise<Model> {
  const files = (await readdir(join(dir, 'models'))).filter((f) => f.endsWith('.procmodel.json'));
  const file = files.find((f) => !f.startsWith('site-')) ?? files[0];
  if (!file) throw new Error('no model file');
  return JSON.parse(await readFile(join(dir, 'models', file), 'utf8')) as Model;
}

/** Make the next native open dialog return these files (Electron main process). */
export async function nextOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, files) => {
    const orig = dialog.showOpenDialog.bind(dialog);
    (dialog as { showOpenDialog: unknown }).showOpenDialog = () => {
      (dialog as { showOpenDialog: unknown }).showOpenDialog = orig;
      return Promise.resolve({ canceled: false, filePaths: files });
    };
  }, paths);
}
