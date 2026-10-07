/**
 * Upgrade paths (M9 T8, the 1.0 checklist "Data migration and upgrade"):
 *
 * - A project and settings written by 0.8 (tools/compat/corpus/0.8) open in this build, an issue
 *   is edited through the issue card, and every state file of the project, and settings.json,
 *   still parse with the 0.8 schema afterwards (tools/compat/schema-0.8): an 0.8 build on the
 *   same machine keeps working with them, house report choices included.
 * - A project saved by a newer version of Quadrion AI (`aio.project/2`) is refused with the update message and
 *   its files are left exactly as they were.
 *
 * The project's images, models and clouds come from the synthetic demo (build it with
 * `pnpm demo:build --quick`; skipped when it is missing). The first edit also starts the journal
 * (`journal/`, signed ops and this device's record).
 */
import { test as base, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, launchApp, NetworkGuard, type DataRoot } from './fixtures';

const REPO = join(import.meta.dirname, '..', '..', '..');
const COMPAT = join(REPO, 'tools', 'compat');
const DEMO = process.env.QUADRION_E2E_DEMO ?? join(import.meta.dirname, '..', 'demo');
const PROJECT = 'compat-tank-farm';
const NAME = 'Demo tank farm';

interface SafeParse {
  safeParse(v: unknown): { success: boolean; error?: { message: string } };
}
interface Family {
  family: string;
  pick: (m: Record<string, unknown>) => SafeParse | null;
}
interface Compat {
  v08: Record<string, unknown> & { Settings: { shape: Record<string, SafeParse> } };
  familyOf: (rel: string) => Family | undefined;
}

/** The 0.8 schema and the file-to-family table of tools/compat (plain ES modules). */
async function loadCompat(): Promise<Compat> {
  const v08: unknown = await import(pathToFileURL(join(COMPAT, 'schema-0.8', 'index.mjs')).href);
  const families: unknown = await import(pathToFileURL(join(COMPAT, 'families.mjs')).href);
  return { v08: v08 as Compat['v08'], familyOf: (families as Pick<Compat, 'familyOf'>).familyOf };
}

async function jsonFiles(dir: string, under = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await jsonFiles(p, under)));
    else if (e.name.endsWith('.json')) out.push(relative(under, p).replaceAll('\\', '/'));
  }
  return out;
}

/** A data root holding the demo tank farm with every state file as 0.8 wrote it. */
async function dataRootWith08Project(): Promise<DataRoot> {
  const b = await mkdtemp(join(tmpdir(), 'aio-upgrade-'));
  const root = join(b, 'data');
  const userData = join(b, 'user');
  const projectDir = join(root, 'projects', PROJECT);
  await mkdir(userData, { recursive: true });
  await mkdir(join(root, 'packs'), { recursive: true });
  await cp(join(DEMO, 'demo-tank-farm'), projectDir, { recursive: true });
  const from08 = join(COMPAT, 'corpus', '0.8', 'tank-farm');
  for (const rel of await jsonFiles(from08)) {
    if (rel === 'aio-package.json') continue; // a package member, not a project file
    await mkdir(join(projectDir, rel, '..'), { recursive: true });
    await cp(join(from08, rel), join(projectDir, rel));
  }
  const settings = JSON.parse(
    await readFile(join(COMPAT, 'corpus', '0.8', 'userData', 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  await writeFile(
    join(userData, 'settings.json'),
    JSON.stringify({ ...settings, dataRoot: root }, null, 2),
  );
  return { base: b, root, userData, projectId: PROJECT, projectDir };
}

const test = base.extend<{ data: DataRoot; app: ElectronApplication; win: Page }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  data: async ({}, use) => {
    const data = await dataRootWith08Project();
    await use(data);
    await rm(data.base, { recursive: true, force: true });
  },
  app: async ({ data }, use) => {
    const network = new NetworkGuard();
    const app = await launchApp(data);
    await network.attach(app);
    try {
      await use(app);
      expect(await network.outbound(), 'the app made network requests').toEqual([]);
    } finally {
      await app.close();
    }
  },
  win: async ({ app }, use) => {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await use(win);
  },
});

test.skip(
  !existsSync(join(DEMO, 'demo.json')),
  `no demo project in ${DEMO}: run pnpm demo:build --quick`,
);
test.setTimeout(120_000);

const nav = (win: Page, name: string) =>
  win.locator('.sb-nav .nav-item', { hasText: name }).first().click();

test('a project written by 0.8 is edited here and still opens in 0.8', async ({ win, data }) => {
  const { v08, familyOf } = await loadCompat();

  await nav(win, 'Projects');
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });

  // Edit the first issue's title through the issue card.
  await nav(win, 'Issues');
  await win.getByRole('listbox', { name: 'Issues' }).getByRole('option').first().click();
  const card = win.getByTestId('issue-card').first();
  await card.getByText('Edit issue', { exact: true }).click();
  const title = card.getByTestId('issue-edit').getByLabel('Title');
  await title.fill('Coating loss checked after the upgrade');
  await title.press('Enter');

  const issuesFile = join(data.projectDir, 'issues.json');
  await expect
    .poll(async () => (await readFile(issuesFile, 'utf8')).includes('checked after the upgrade'), {
      timeout: 15_000,
    })
    .toBe(true);

  // Every state file of the project still parses with the 0.8 schema.
  const checked: string[] = [];
  for (const rel of await jsonFiles(data.projectDir)) {
    const schema = familyOf(rel)?.pick(v08);
    if (!schema) continue;
    const r = schema.safeParse(JSON.parse(await readFile(join(data.projectDir, rel), 'utf8')));
    expect(r.success, `${rel}: ${r.error?.message ?? ''}`).toBe(true);
    checked.push(rel);
  }
  expect(checked).toEqual(
    expect.arrayContaining([
      'manifest.json',
      'issues.json',
      'volumes.json',
      'report/narrative.json',
    ]),
  );

  // Settings saved by this build, with the M9 sections switched off: an 0.8 build keeps every
  // field it knows, the house report choices included.
  await win.evaluate(() =>
    window.aio.invoke('settings:set', {
      reportContents: {
        sections: { appendices: false, audit: false, approvals: false },
        issuePages: 'above-lowest',
      },
    }),
  );
  const settings = JSON.parse(
    await readFile(join(data.userData, 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  for (const [key, field] of Object.entries(v08.Settings.shape)) {
    if (key in settings) expect(field.safeParse(settings[key]).success, key).toBe(true);
  }
  expect(settings.reportContents).toEqual({
    sections: { appendices: false },
    issuePages: 'above-lowest',
  });
});

test('the first edit in this build starts the journal, signed by this device', async ({
  win,
  data,
}) => {
  await nav(win, 'Projects');
  await win.getByTestId('project-card').filter({ hasText: NAME }).first().click();
  await expect(win.locator('[data-scene-view] canvas').first()).toBeVisible({ timeout: 60_000 });
  // opening alone takes the 0.8 files as the baseline: no journal yet
  expect(existsSync(join(data.projectDir, 'journal'))).toBe(false);

  await nav(win, 'Issues');
  await win.getByRole('listbox', { name: 'Issues' }).getByRole('option').first().click();
  const card = win.getByTestId('issue-card').first();
  await card.getByText('Edit issue', { exact: true }).click();
  const title = card.getByTestId('issue-edit').getByLabel('Title');
  await title.fill('Journal starts here');
  await title.press('Enter');

  const opsDir = join(data.projectDir, 'journal', 'ops');
  await expect.poll(() => existsSync(opsDir), { timeout: 15_000 }).toBe(true);
  expect((await stat(join(data.projectDir, 'journal'))).isDirectory()).toBe(true);
  const [chain] = await readdir(opsDir);
  if (!chain) throw new Error('no chain');
  const text = await readFile(join(opsDir, chain, '000001.jsonl'), 'utf8');
  const ops = text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { kind: string; sig?: string; payload?: unknown });
  expect(
    ops.some(
      (o) => o.kind === 'issue.patch' && JSON.stringify(o.payload).includes('Journal starts here'),
    ),
  ).toBe(true);
  expect(ops.every((o) => typeof o.sig === 'string')).toBe(true);
  // this device's public record is beside the chain; its key stayed in the test vault
  const device = chain.split('.')[0] ?? '';
  expect(existsSync(join(data.projectDir, 'journal', 'devices', `${device}.json`))).toBe(true);
});

test('a project saved by a newer version of Quadrion AI is refused and left unchanged', async ({
  win,
  data,
}) => {
  const manifestFile = join(data.projectDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  const newer = `${JSON.stringify({ ...manifest, schema: 'aio.project/2', later: true }, null, 2)}\n`;
  await writeFile(manifestFile, newer);
  const before = await jsonFiles(data.projectDir);

  const r = await win.evaluate(
    (path) => window.aio.invoke('project:open', { path }),
    data.projectDir,
  );
  expect(r.ok).toBe(false);
  if (!r.ok)
    expect(r.error).toMatch(/saved by a newer version of Quadrion AI \(schema aio\.project\/2\)/);
  expect(await readFile(manifestFile, 'utf8')).toBe(newer);
  expect(await jsonFiles(data.projectDir)).toEqual(before);
});
