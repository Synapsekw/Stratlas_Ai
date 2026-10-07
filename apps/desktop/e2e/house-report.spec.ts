/**
 * The house-format project report (BLD-8) and its narrative (BLD-7), end to end on temp copies of
 * the real HCl tank (13 issues) and DAMAC tower (701 issues) projects. The scripted AI model
 * stands in for the cloud (QUADRION_AI_TEST_PROVIDER, isolated profile): no network at all.
 * Runs only where the real data holds the projects (realData.ts, @realdata); the real data is
 * read, copied and never written.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, launchApp, NetworkGuard, test, type DataRoot } from './fixtures';
import { pdfText } from './pdf';
import {
  copyRealProjects,
  hasRealProject,
  missingRealProject,
  type RealDataCopy,
} from './realData';

const has = hasRealProject;

/** Text without spaces, lower case: the report spaces out its capitals. */
const flat = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase();

/** A client brand must never appear (the projects were imported with one). */
const CLIENT_BRAND = /\be&|\beand\b|etisalat/i;

/**
 * A temp data root with a copy of a real project: what the report reads (manifest, issues,
 * thumbnail, models, photos, report), never the videos, clouds or the original viewer.
 */
const COPIED = new Set([
  'manifest.json',
  'issues.json',
  'thumbnail.jpg',
  'models',
  'photos',
  'report',
]);

async function copyProject(id: string): Promise<RealDataCopy> {
  return copyRealProjects([id], {
    prefix: `aio-house-${id}-`,
    include: (rel) => COPIED.has(rel.split('/')[0] ?? ''),
  });
}

async function start(data: DataRoot) {
  const app = await launchApp(data, { QUADRION_AI_TEST_PROVIDER: '1' });
  const network = new NetworkGuard();
  await network.attach(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, network };
}

/** Save dialogs answer `<dir>/<default name>`. */
async function answerSaves(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, folder) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
    },
    dir.replace(/\\/g, '/'),
  );
}

async function openReports(win: Page, name: string): Promise<void> {
  await win.getByTestId('project-card').filter({ hasText: name }).click();
  await expect(win.locator('.crumbs')).toContainText(name, { timeout: 60_000 });
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
  await expect(win.getByTestId('house-report')).toBeVisible();
}

const setSettings = (win: Page, patch: Record<string, unknown>) =>
  win.evaluate((p) => window.aio.invoke('settings:set', p), patch);

/** Export the project report and wait for the saved toast; returns the seconds it took. */
async function exportHouse(win: Page, timeout: number): Promise<number> {
  const t0 = Date.now();
  await win.getByRole('button', { name: 'Export project report PDF' }).click();
  const msg = win.getByTestId('export-toast-message').last();
  await expect(msg).toContainText('saved to', { timeout });
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
  return (Date.now() - t0) / 1000;
}

const narrative = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'report', 'narrative.json'), 'utf8')) as {
    parts: Record<string, { versions: { text: string; source: string }[] }>;
  };

test.describe('@realdata HCl', () => {
  test.skip(!has('hcl'), missingRealProject('hcl'));

  test('narrative from the template and the AI, versioned; the report in the house format', async () => {
    test.setTimeout(300_000);
    const data = await copyProject('hcl');
    const out = join(data.base, 'out');
    await mkdir(out, { recursive: true });
    const { app, win, network } = await start(data);
    try {
      await answerSaves(app, out);
      await openReports(win, 'HCl Tank 710-D-130335');

      // Cloud AI off: the text is filled from the template, with prompts for the author.
      await win.getByRole('button', { name: 'Edit report text' }).click();
      const editor = win.getByTestId('narrative-editor');
      await expect(editor).toBeVisible();
      await win.getByTestId('narrative-draft-all').click();
      await expect(win.getByTestId('narrative-note')).toContainText('Cloud AI is off');
      const summary = editor.getByRole('textbox', { name: 'Executive summary' });
      await expect(summary).toHaveValue(/HCl Tank 710-D-130335.*13 issues/s);
      await expect(summary).toHaveValue(/\[Add the purpose/);
      let file = await narrative(data.projectDir);
      expect(file.parts.summary?.versions.map((v) => v.source)).toEqual(['template']);

      // Edited in place and saved as a new version.
      await summary.fill(
        'Edited summary for the client. The tank needs a repair of the bottom plate.',
      );
      await editor.getByRole('textbox', { name: 'Scope and method' }).click();
      await expect
        .poll(async () => (await narrative(data.projectDir)).parts.summary?.versions.length)
        .toBe(2);

      // Cloud AI on: the exact request is shown first (AI-6), then the scripted model drafts.
      await setSettings(win, { cloudAi: true });
      await win.getByTestId('narrative-draft-all').click();
      const preview = win.getByTestId('narrative-preview');
      await expect(preview).toBeVisible();
      await expect(preview).toContainText('"project": "HCl Tank 710-D-130335"');
      await expect(preview).toContainText('never invent numbers');
      await preview.getByRole('button', { name: 'Send' }).click();
      await expect(summary).toHaveValue(/Scripted executive summary for HCl Tank 710-D-130335/);
      file = await narrative(data.projectDir);
      expect(file.parts.summary?.versions.map((v) => v.source)).toEqual(['template', 'user', 'ai']);
      expect(file.parts.method?.versions.map((v) => v.source)).toEqual(['template', 'ai']);

      // An older version restored becomes the newest; nothing is lost.
      const part = editor.locator('[data-part="summary"]');
      await part.locator('summary').click();
      await part.getByRole('button', { name: 'Restore this version' }).first().click();
      await expect(summary).toHaveValue(/^Edited summary for the client/);
      file = await narrative(data.projectDir);
      expect(file.parts.summary?.versions).toHaveLength(4);
      await win.getByRole('button', { name: 'Back to the reports' }).click();

      // The report: neutral branding by default, every section, the saved text.
      const pdf = join(out, 'HCl-Tank-710-D-130335-report.pdf');
      const seconds = await exportHouse(win, 120_000);
      const all = await pdfText(
        pdf,
        Array.from({ length: 60 }, (_, i) => i + 1),
      );
      console.warn(`HCl house report: ${String(all.count)} pages in ${seconds.toFixed(1)} s`);
      expect(all.count).toBeGreaterThanOrEqual(20);
      expect(all.count).toBeLessThanOrEqual(40);
      const text = [...all.text.values()].join(' ');
      const cover = flat(all.text.get(1));
      expect(cover).toContain('hcltank710-d-130335');
      expect(cover).toContain('visualinspectionreport');
      expect(cover).toContain('madewithquadrionai');
      expect(text).not.toMatch(CLIENT_BRAND);
      for (const heading of [
        'contents',
        'executivesummary',
        'scopeandmethod',
        'siteanddata',
        'statistics',
        'findingsregister',
        'issuef01',
        'appendixa',
        'datainventory',
      ])
        expect(flat(text)).toContain(heading);
      expect(flat(text)).toContain(flat('Edited summary for the client.'));
      // every issue but the uncertain ones has a page
      const issuePages = [...all.text.values()].filter((t) => /issuef\d+·seenin/.test(flat(t)));
      expect(issuePages.length).toBeGreaterThanOrEqual(12);

      // The person's branding on the cover; still never the client's.
      await setSettings(win, { reportBranding: { companyName: 'Synapse Solutions' } });
      await exportHouse(win, 120_000);
      const branded = await pdfText(pdf, [1, 2, 3]);
      expect(flat(branded.text.get(1))).toContain('preparedbysynapsesolutions');
      expect(flat(branded.text.get(1))).not.toContain('madewith');
      expect(flat(branded.text.get(3))).toContain('synapsesolutions');
      expect(branded.text.get(1)).not.toMatch(CLIENT_BRAND);

      // Sections chosen in Settings: no site, no appendices, no issue pages.
      await setSettings(win, {
        reportContents: { sections: { site: false, appendices: false }, issuePages: 'none' },
      });
      await exportHouse(win, 120_000);
      const short = await pdfText(
        pdf,
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      expect(short.count).toBeLessThan(12);
      const shortText = flat([...short.text.values()].join(' '));
      expect(shortText).toContain('findingsregister');
      expect(shortText).not.toContain('siteanddata');
      expect(shortText).not.toContain('appendixa');
      expect(shortText).not.toContain('issuef01');

      expect(await readdir(out)).toEqual(['HCl-Tank-710-D-130335-report.pdf']);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
      await data.dispose();
    }
  });
});

test.describe('@realdata DAMAC', () => {
  test.skip(!has('damac'), missingRealProject('damac'));

  test('701 issues: progress, cancel, the app stays usable, and the report finishes', async () => {
    test.setTimeout(900_000);
    const data = await copyProject('damac');
    const out = join(data.base, 'out');
    await mkdir(out, { recursive: true });
    const { app, win, network } = await start(data);
    try {
      await answerSaves(app, out);
      await openReports(win, 'DAMAC Hills residential tower');
      const pdf = join(out, 'DAMAC-Hills-residential-tower-report.pdf');

      // Progress shows issue pages being drawn; Cancel stops the job and leaves no file.
      await win.getByRole('button', { name: 'Export project report PDF' }).click();
      const toast = win.getByTestId('export-toast').last();
      await expect(toast).toContainText(/Drawing issue pages \d+ \/ 6\d\d/, { timeout: 120_000 });
      await toast.getByRole('button', { name: 'Cancel' }).click();
      await expect(win.getByTestId('export-toast')).toHaveCount(0);
      await expect.poll(async () => readdir(out), { timeout: 15_000 }).toEqual([]);

      // Again to the end; the app answers while the report is laid out.
      const t0 = Date.now();
      await win.getByRole('button', { name: 'Export project report PDF' }).click();
      await expect(toast).toContainText('Drawing issue pages', { timeout: 120_000 });
      await win.locator('.sb-nav .nav-item', { hasText: 'Issues' }).click();
      await expect(win.locator('.crumbs')).toContainText('Issues', { timeout: 5_000 });
      await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).click();
      await expect(win.getByTestId('export-toast-message').last()).toContainText('saved to', {
        timeout: 600_000,
      });
      const seconds = (Date.now() - t0) / 1000;

      const doc = await pdfText(pdf, [1, 2, 3, 7, 40]);
      console.warn(`DAMAC house report: ${String(doc.count)} pages in ${seconds.toFixed(1)} s`);
      // 656 graded issues with a page each, plus cover, contents, sections, register, appendices
      expect(doc.count).toBeGreaterThanOrEqual(660);
      expect(doc.count).toBeLessThanOrEqual(760);
      expect(flat(doc.text.get(1))).toContain('damachillsresidentialtower');
      expect(flat(doc.text.get(1))).toContain('701issues');
      expect(flat(doc.text.get(1))).toContain('madewithquadrionai');
      expect(flat(doc.text.get(2))).toContain('contents');
      expect(flat(doc.text.get(3))).toContain('executivesummary');
      expect(flat(doc.text.get(7))).toContain('findingsregister');
      expect(flat(doc.text.get(40))).toMatch(/issued\d+/);
      for (const t of doc.text.values()) expect(t).not.toMatch(CLIENT_BRAND);
      expect(await network.outbound()).toEqual([]);
    } finally {
      await app.close();
      await data.dispose();
    }
  });
});
