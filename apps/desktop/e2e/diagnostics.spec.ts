/**
 * Diagnostics and support (M7 stream D5): export a diagnostics bundle from Settings, Report a
 * problem from the palette, and the crash notice after a window crash and after an unclean exit.
 * Every bundle is opened and checked for keys, tokens and passwords.
 */
import { openZip } from '@aio/project/package';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test } from './fixtures';

// Fake secrets, assembled at runtime so no scanner mistakes this file for a leak.
const KEY = ['sk-ant-api03', 'E2e'.repeat(16)].join('-');
const TOKEN = ['tok', 'e2e', '9f8e7d6c5b4a'].join('_');
const WORKSPACE = 'wrkspc_01E2eWorkspaceXyz';

async function stubSaveDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
}

async function openAbout(win: Page) {
  await win.locator('.nav-item', { hasText: 'Settings' }).click();
  await win.locator('.set-nav button', { hasText: 'About and updates' }).click();
  await expect(win.locator('.set-page h1')).toHaveText('About and updates');
}

async function readZip(file: string): Promise<Map<string, string>> {
  const zip = await openZip(file);
  const out = new Map<string, string>();
  for (const name of zip.entries.keys()) out.set(name, (await zip.read(name)).toString('utf8'));
  return out;
}

function expectNoSecrets(files: Map<string, string>) {
  for (const [name, text] of files) {
    expect(text, name).not.toContain(KEY);
    expect(text, name).not.toContain(TOKEN);
    expect(text, name).not.toContain(WORKSPACE);
  }
}

test('exports a diagnostics bundle without keys, tokens or project content', async ({
  app,
  win,
  dataRoot,
}) => {
  await win.evaluate(
    (ws) => window.aio.invoke('settings:set', { anthropicWorkspaceId: ws }),
    WORKSPACE,
  );
  // A key and a token reach the main and the window logs.
  await app.evaluate(
    (_e, [key, token]) => {
      console.error(`Provider said 401 for ${key ?? ''}`, { headers: { authorization: token } });
    },
    [KEY, TOKEN],
  );
  await win.evaluate(
    ([key, token]) => {
      console.error(`Agent request failed, apiKey=${key ?? ''} token=${token ?? ''}`);
    },
    [KEY, TOKEN],
  );

  await openAbout(win);
  const out = join(dataRoot.base, 'diagnostics.zip');
  await stubSaveDialog(app, out);
  await win.getByTestId('diagnostics').getByRole('button', { name: 'Export diagnostics' }).click();
  await expect(win.getByTestId('diagnostics').getByTestId('diagnostics-saved')).toContainText(out);

  const files = await readZip(out);
  for (const name of [
    'README.txt',
    'system.json',
    'settings.json',
    'packs.json',
    'jobs.json',
    'projects.json',
    'local-ai.json',
    'errors.txt',
    'logs/main.log',
    'logs/renderer.log',
    'crash/minidumps.txt',
  ])
    expect([...files.keys()], name).toContain(name);
  expect(files.has('problem.md')).toBe(false);
  expectNoSecrets(files);

  const localAi = JSON.parse(files.get('local-ai.json') ?? '{}') as {
    onnxRuntime?: { package?: string; packageVersion?: string; state?: string };
    localAgent?: { enabled?: boolean; offlineAgent?: boolean };
  };
  expect(localAi.onnxRuntime?.package).toBe('onnxruntime-node');
  expect(localAi.onnxRuntime?.packageVersion).toMatch(/^\d+\.\d+/);
  expect(localAi.onnxRuntime?.state).toBeTruthy();
  expect(localAi.localAgent?.offlineAgent).toBe(false);

  const system = JSON.parse(files.get('system.json') ?? '{}') as {
    app: { version: string };
    versions: { electron: string; chrome: string; node: string };
    os: { platform: string };
    gpu: unknown;
    graphics?: { tier: string };
  };
  expect(system.app.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(system.versions.electron).toMatch(/^\d+\./);
  expect(system.versions.chrome).toMatch(/^\d+\./);
  expect(system.os.platform).toBe(process.platform);
  expect(system.gpu).toBeTruthy();
  expect(system.graphics?.tier).toMatch(/^(low|medium|high|ultra)$/);

  const settings = JSON.parse(files.get('settings.json') ?? '{}') as Record<string, unknown>;
  expect(settings.dataRoot).toBe(dataRoot.root);
  expect(settings.anthropicWorkspaceId).toMatch(/^wrks\*+yz$/);

  // The scrubbed lines are still there, so support can read what went wrong.
  expect(files.get('logs/main.log')).toContain('Provider said 401 for [redacted]');
  expect(files.get('logs/renderer.log')).toContain('Agent request failed, apiKey=[redacted]');
  expect(files.get('errors.txt')).toContain('[renderer]');
  // No project content: the tiny project's model never appears.
  expect([...files.keys()].some((n) => n.endsWith('.glb'))).toBe(false);
});

test('Report a problem saves problem.md in the bundle and shows where it is', async ({
  app,
  win,
  dataRoot,
}) => {
  await win.keyboard.press('Control+K');
  const palette = win.getByRole('dialog', { name: 'Command search' });
  await expect(palette).toBeVisible();
  await win.keyboard.type('Report a problem');
  await win.keyboard.press('Enter');
  const dialog = win.getByTestId('report-problem');
  await expect(dialog).toBeVisible();

  // The form needs a sentence about what happened.
  await dialog.getByRole('button', { name: 'Save report' }).click();
  await expect(dialog.getByRole('alert')).toContainText('what happened');

  const out = join(dataRoot.base, 'problem.zip');
  await stubSaveDialog(app, out);
  await dialog.getByTestId('problem-what').fill(`The map stayed grey. My key is ${KEY}`);
  await dialog.getByTestId('problem-steps').fill('1. Open the project\n2. Switch to Map');
  await dialog.getByRole('button', { name: 'Save report' }).click();
  await expect(dialog.getByTestId('problem-saved')).toContainText(out);

  const files = await readZip(out);
  const problem = files.get('problem.md') ?? '';
  expect(problem).toContain('The map stayed grey.');
  expect(problem).toContain('2. Switch to Map');
  expect(files.has('system.json')).toBe(true);
  expectNoSecrets(files);

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
});

/** Run a script in the app window through main (works after the window was reloaded). */
function inWindow(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ BrowserWindow }, js) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!wc || wc.isCrashed() || wc.isLoading()) return '';
    // A script sent while the renderer is going down never answers: give up after a second.
    const out: unknown = await Promise.race([
      wc.executeJavaScript(js).catch(() => ''),
      new Promise((resolve) => setTimeout(resolve, 1000, '')),
    ]);
    return typeof out === 'string' ? out : '';
  }, script);
}

// Launched without the fixture's tracing and request routing: Playwright cannot follow a renderer
// that crashes and is reloaded (its routed requests would never complete), so the window is read
// and driven from main. The main-process half of the zero-network guard (network-guard.cjs) still
// runs, and the app's own session blocks every http(s) request of the window.
test('a window crash writes a report, reopens the window and shows a calm notice', async ({
  dataRoot,
}) => {
  const app = await launchApp(dataRoot);
  try {
    const win = await app.firstWindow();
    await expect(win.locator('.app')).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
    });
    const notice = `document.querySelector('[data-testid="crash-notice"]')?.innerText ?? ''`;
    await expect
      .poll(() => inWindow(app, notice), { timeout: 30_000 })
      .toContain('window stopped unexpectedly');
    expect(await inWindow(app, notice)).toContain('Save a report');

    // Save a report: the bundle holds the crash report.
    const out = join(dataRoot.base, 'after-crash.zip');
    await stubSaveDialog(app, out);
    await inWindow(
      app,
      `[...document.querySelectorAll('[data-testid="crash-notice"] button')].find((b) => b.textContent === 'Save a report')?.click() ?? ''`,
    );
    await expect.poll(() => inWindow(app, notice), { timeout: 30_000 }).toContain(out);
    const files = await readZip(out);
    expect([...files.keys()].some((n) => /^crash\/crash-.*-renderer-.*\.json$/.test(n))).toBe(true);
    const mainRequests = await app.evaluate(
      () => (globalThis as { __aioNetworkLog?: string[] }).__aioNetworkLog?.slice() ?? ['no guard'],
    );
    expect(mainRequests).toEqual([]);
  } finally {
    await app.close();
  }

  const dir = join(dataRoot.userData, 'crash-reports');
  const reports = (await readdir(dir)).filter((n) => n.startsWith('crash-'));
  expect(reports).toHaveLength(1);
  const report = JSON.parse(await readFile(join(dir, reports[0] ?? ''), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(report).toMatchObject({ schema: 'stratlas.crash/1', process: 'renderer' });
  expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(Array.isArray(report.lastLines)).toBe(true);
});

/** End the app and its child processes at once, as Task Manager or a power cut would. */
async function killTree(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  if (process.platform === 'win32' && proc.pid !== undefined)
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
  else proc.kill('SIGKILL');
  await exited;
  // Child processes release the profile and the single-instance lock shortly after.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

test('after an unclean exit the next start says so, and Dismiss clears it', async ({
  dataRoot,
}) => {
  const env = { STRATLAS_CRASH_NOTICE: '1' };
  const first = await launchApp(dataRoot, env);
  const firstWin = await first.firstWindow();
  await expect(firstWin.locator('.app')).toBeVisible();
  // Ended without quitting, as by Task Manager or a power cut.
  await killTree(first);

  const guard = new NetworkGuard();
  const second = await launchApp(dataRoot, env);
  try {
    await guard.attach(second);
    const win = await second.firstWindow();
    const notice = win.getByTestId('crash-notice');
    await expect(notice).toContainText('closed unexpectedly last time');
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toBeHidden();
    expect(await guard.outbound()).toEqual([]);
  } finally {
    await second.close();
  }

  // Dismissed, and the second run quit cleanly: no notice on the third start.
  const third = await launchApp(dataRoot, env);
  try {
    const win = await third.firstWindow();
    await expect(win.locator('.app')).toBeVisible();
    await win.waitForTimeout(1000);
    await expect(win.getByTestId('crash-notice')).toHaveCount(0);
  } finally {
    await third.close();
  }
});
