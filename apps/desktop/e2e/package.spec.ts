/**
 * `.aio` packages end to end (BLD-9, APP-5): export from the app, then open the package the way
 * a customer does (double-click: the path arrives as an argument) on a machine with an empty
 * data folder, in player mode, with the zero-network guard on both runs.
 *
 * The HCl test needs the real project at E:\Stratlas Data\projects\hcl (or STRATLAS_HCL_DATA)
 * and is skipped elsewhere; it only reads the project and writes the package to a temp folder.
 * Set STRATLAS_SHOTS to a folder to keep screenshots of each step.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';

const SHOTS = process.env.STRATLAS_SHOTS;
const shot = async (win: Page, name: string) => {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** Answer the next native save dialog with `file` (main process). */
async function stubSaveDialog(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: target });
  }, file);
}

async function exportOpenProject(
  app: ElectronApplication,
  win: Page,
  file: string,
  o: { dropClouds?: boolean; passphrase?: string; shots?: string } = {},
) {
  await win.locator('.nav-item', { hasText: 'Reports' }).first().click();
  await win.getByTestId('export-package').click();
  const dialog = win.getByTestId('package-export');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('pkg-size')).not.toContainText('...');
  if (o.dropClouds) {
    const before = await dialog.getByTestId('pkg-size').innerText();
    await dialog.getByTestId('pkg-group-pointcloud').uncheck();
    await expect(dialog.getByTestId('pkg-size')).not.toHaveText(before);
  }
  if (o.passphrase) {
    await dialog.getByRole('switch', { name: 'Encrypt' }).click();
    await dialog.getByLabel('Passphrase', { exact: true }).fill(o.passphrase);
    await dialog.getByLabel('Repeat passphrase').fill(o.passphrase);
  }
  if (o.shots) await shot(win, `${o.shots}-export-dialog`);
  await stubSaveDialog(app, file);
  await dialog.getByTestId('pkg-export').click();
  await expect(dialog.getByTestId('pkg-done')).toBeVisible({ timeout: 180_000 });
  if (o.shots) await shot(win, `${o.shots}-export-done`);
  expect((await stat(file)).size).toBeGreaterThan(0);
}

/** A customer machine: empty data folder and profile, the package passed as by a double-click. */
async function openAsCustomer(base: string, file: string) {
  const customer: DataRoot = {
    base,
    root: join(base, 'customer-data'),
    userData: join(base, 'customer-user'),
    projectId: '',
    projectDir: '',
  };
  await mkdir(customer.root, { recursive: true });
  const network = new NetworkGuard();
  const app = await launchApp(customer, {}, [file]);
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

const projectId = (win: Page) =>
  win.evaluate(
    () =>
      (
        window as unknown as {
          __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
        }
      ).__stratlas.workspace.getState().project?.id ?? '',
  );

test('an encrypted package of the tiny project opens with its passphrase in player mode', async ({
  app,
  win,
  dataRoot,
}) => {
  const file = join(dataRoot.base, 'tiny.aio');
  await win.getByTestId('project-card').first().click();
  await exportOpenProject(app, win, file, { passphrase: 'correct horse battery' });

  const c = await openAsCustomer(dataRoot.base, file);
  try {
    await expect(c.win.getByTestId('passphrase')).toBeVisible();
    await c.win.getByTestId('passphrase').fill('wrong passphrase');
    await c.win.getByRole('dialog').getByRole('button', { name: 'Open package' }).click();
    await expect(c.win.getByRole('dialog')).toContainText('does not open');
    await shot(c.win, 'n4-06-unlock');
    await c.win.getByTestId('passphrase').fill('correct horse battery');
    await c.win.getByRole('dialog').getByRole('button', { name: 'Open package' }).click();
    await expect(c.win.getByTestId('welcome')).toContainText('E2E tiny project');
    await expect(c.win.getByTestId('readonly-chip')).toHaveText('Read-only package');
    // The opened package stays in the customer's library.
    await c.win.locator('.nav-item', { hasText: 'Projects' }).first().click();
    await expect(c.win.getByTestId('project-card')).toContainText('Encrypted package');
    await shot(c.win, 'n4-07-library');
    expect(await c.network.outbound()).toEqual([]);
  } finally {
    await c.app.close();
  }
});

const DATA = process.env.STRATLAS_HCL_DATA ?? 'E:\\Stratlas Data';
const HCL = join(DATA, 'projects', 'hcl');

test.describe('HCl as a customer package', () => {
  test.skip(!existsSync(join(HCL, 'manifest.json')), `HCl project not found at ${HCL}`);
  test.setTimeout(420_000);

  test('exports, opens read-only from the ZIP, streams and seeks video, never writes or calls out', async () => {
    const base = await mkdtemp(join(tmpdir(), 'aio-pkg-hcl-'));
    const file = join(base, 'HCl customer.aio');
    const builder: DataRoot = {
      base,
      root: DATA,
      userData: join(base, 'builder-user'),
      projectId: 'hcl',
      projectDir: HCL,
    };
    const issuesBefore = (await stat(join(HCL, 'issues.json'))).mtimeMs;
    try {
      // 1. The builder exports HCl without its raw point clouds.
      const network = new NetworkGuard();
      const app = await launchApp(builder);
      await network.attach(app);
      try {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
        });
        await win.getByTestId('project-card').filter({ hasText: 'HCl' }).first().click();
        await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
        await exportOpenProject(app, win, file, { dropClouds: true, shots: 'n4-01' });
        expect(await network.outbound()).toEqual([]);
      } finally {
        await app.close();
      }

      // 2. The customer double-clicks it on a machine with no data folder.
      const c = await openAsCustomer(base, file);
      const { win } = c;
      try {
        await c.app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
        });
        const welcome = win.getByTestId('welcome');
        await expect(welcome).toContainText('HCl Tank 710-D-130335');
        await expect(welcome).toContainText('KOC');
        await expect(win.getByTestId('readonly-chip')).toHaveText('Read-only package');
        await expect(win.locator('.welcome-media img')).toBeVisible();
        await shot(win, 'n4-02-welcome');

        // Explore: the scene loads the tank from inside the ZIP; no annotate tool, no clouds.
        await win.getByTestId('welcome-start').click();
        await expect(win.locator('[data-scene-view] canvas')).toBeVisible();
        await expect(win.getByRole('button', { name: /^Annotate/ })).toHaveCount(0);
        await win.keyboard.press('a');
        await expect(win.locator('.ann-subbar')).toHaveCount(0);
        const id = await projectId(win);
        expect(id).toBe('hcl-customer');

        // Video streams from the archive: a byte range equals the source file's bytes.
        const range = await win.evaluate(async (pid) => {
          const r = await fetch(`aio://project/${pid}/video/v101_00.mp4`, {
            headers: { Range: 'bytes=1000000-1000999' },
          });
          const b = new Uint8Array(await r.arrayBuffer());
          return { status: r.status, length: b.length, head: [...b.slice(0, 16)] };
        }, id);
        expect(range.status).toBe(206);
        expect(range.length).toBe(1000);
        const fh = await open(join(HCL, 'video', 'v101_00.mp4'), 'r');
        const src = Buffer.alloc(16);
        await fh.read(src, 0, 16, 1_000_000);
        await fh.close();
        expect(range.head).toEqual([...src]);

        // Play a clip from the timeline, then seek it far into the clip.
        const bar = win.locator('.seg-c.grp').first();
        const box = await bar.boundingBox();
        if (!box) throw new Error('no flight bar in the timeline');
        await bar.click({ position: { x: box.width * 0.4, y: box.height / 2 } });
        const video = win.locator('[data-video-window] video');
        await expect
          .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), {
            timeout: 20_000,
          })
          .toBeGreaterThan(0);
        const seek = await video.evaluate(async (v: HTMLVideoElement) => {
          v.pause();
          const target = Math.max(1, v.duration - 2);
          await new Promise<void>((done) => {
            v.addEventListener(
              'seeked',
              () => {
                done();
              },
              { once: true },
            );
            v.currentTime = target;
          });
          return { target, now: v.currentTime, ready: v.readyState, src: v.currentSrc };
        });
        expect(seek.src.startsWith('aio://project/hcl-customer/')).toBe(true);
        expect(Math.abs(seek.now - seek.target)).toBeLessThan(0.5);
        expect(seek.ready).toBeGreaterThanOrEqual(2);
        await win.evaluate(() => {
          (
            window as unknown as { __stratlas: { workspace: { getState(): { pause(): void } } } }
          ).__stratlas.workspace
            .getState()
            .pause();
        });
        await shot(win, 'n4-03-scene');

        // Issues are listed, not editable; main refuses a write and cloud AI.
        await win.locator('.nav-item', { hasText: 'Issues' }).first().click();
        await expect(win.getByText('F05', { exact: true }).first()).toBeVisible();
        await win.getByText('F05', { exact: true }).first().click();
        const detail = win.getByTestId('issue-detail');
        await expect(detail).toBeVisible();
        await expect(detail.getByText('Delete issue')).toHaveCount(0);
        await expect(detail.locator('input, textarea, select')).toHaveCount(0);
        await shot(win, 'n4-04-issues');
        const refused = await win.evaluate(
          (pid) => window.aio.invoke('project:writeIssues', { projectId: pid, issues: [] }),
          id,
        );
        expect(refused.ok).toBe(false);
        expect(refused.error).toMatch(/read-only/);
        // Turning cloud AI on does not unlock it for this package.
        await win.getByTestId('cloud-chip').click();
        await win.getByRole('button', { name: 'Privacy and cloud' }).click();
        await win.getByRole('switch', { name: 'Allow cloud AI' }).click();
        await expect(win.getByTestId('cloud-chip')).toHaveText('Cloud AI blocked');
        await expect(win.getByText('does not allow cloud AI')).toBeVisible();
        await shot(win, 'n4-05-cloud-blocked');
        const ai = await win.evaluate(() =>
          window.aio.invoke('ai:send', {
            runId: 'r1',
            window: 'scene3d',
            context: {},
            messages: [{ role: 'user', content: 'Summarise the issues' }],
          }),
        );
        expect(ai.ok).toBe(false);

        expect(await c.network.outbound(), 'the player made network requests').toEqual([]);
      } finally {
        await c.app.close();
      }
      // Nothing was written into the source project.
      expect((await stat(join(HCL, 'issues.json'))).mtimeMs).toBe(issuesBefore);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
