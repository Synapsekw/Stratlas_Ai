/**
 * The app's real-data guard (src/main/realDataGuard.ts) in the built app: started by a test
 * (STRATLAS_E2E=1), it refuses every write under the real data root. Here the "real root" is the
 * test's own temporary data root (STRATLAS_REAL_DATA_ROOT for the app only), so saving an issue
 * into the synthetic project must fail loudly and leave issues.json as it was. Synthetic data: runs
 * everywhere, CI included.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, realDataRefusals, test } from './fixtures';

test('the app refuses to write into the real data root and says so', async ({ dataRoot }) => {
  const app = await launchApp(dataRoot, { STRATLAS_REAL_DATA_ROOT: dataRoot.root });
  const network = new NetworkGuard();
  await network.attach(app);
  const issuesFile = join(dataRoot.projectDir, 'issues.json');
  const before = await readFile(issuesFile, 'utf8');
  const filesBefore = (await readdir(dataRoot.projectDir)).sort();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    const opened = await win.evaluate(
      (path) => window.aio.invoke('project:open', { path }),
      dataRoot.projectDir,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const saved = await win.evaluate(
      (projectId) => window.aio.invoke('project:writeIssues', { projectId, issues: [] }),
      opened.id,
    );
    expect(saved.ok).toBe(false);
    expect(saved.error).toContain('E2E real-data guard: refused');

    // any other write of the main process, through Node's fs, is refused the same way
    const direct = await app.evaluate(
      (_electron, file) => {
        const fs = process.getBuiltinModule('node:fs');
        try {
          fs.writeFileSync(file, 'x');
          return 'written';
        } catch (e) {
          return String(e);
        }
      },
      join(dataRoot.projectDir, 'stray.txt'),
    );
    expect(direct).toContain('refused fs.writeFile');

    // nothing was written, not even a temp file or a backup
    expect(await readFile(issuesFile, 'utf8')).toBe(before);
    expect((await readdir(dataRoot.projectDir)).sort()).toEqual(filesBefore);

    // the refusals are recorded for the fixtures, which fail the test on them at close
    const refused = await realDataRefusals(app);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(refused[0]).toContain(issuesFile);
    // this test provoked them on purpose: clear them so its own close passes
    await app.evaluate(() => {
      (globalThis as { __stratlasRealDataRefusals?: string[] }).__stratlasRealDataRefusals?.splice(
        0,
      );
    });
    expect(await network.outbound()).toEqual([]);
  } finally {
    await app.close();
  }
});
