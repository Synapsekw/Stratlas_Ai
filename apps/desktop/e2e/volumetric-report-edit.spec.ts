/**
 * Editing the volumetric report (spec 2026-10-25, Task 26) in the real app, on the synthetic
 * quarry demo: Reports, Customer reports, Open volumetric report. The title, Prepared for, the
 * "In short" summary, intro, method note, a pile note and the closing remarks are edited; the live
 * preview follows each one; Export HTML writes them all into the file, including a text typed
 * and exported at once (the export hands pending edits over first); the project closed and opened
 * again shows them, and `report/volumetric.json` keeps them as `user` versions. Reset to generated
 * puts the generated summary back, in the preview and in the next export. Page B turned off
 * leaves the preview, the PDF and the HTML's print pages without pile cards, and the last page
 * left on cannot be turned off. Off-screen, zero network, pipeline Python needed.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test } from './fixtures';
import { measureTree } from './island';
import { focusMeasure, volumeSettled } from './measureCard';
import { pdfText } from './pdf';
import { openDemo, setAutoPrepare } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), 'needs the development pipeline Python (uv sync in python/)');

const EDITS = {
  title: 'Edited title for the demo yard',
  preparedFor: 'Edited customer for the demo yard',
  summary: 'Edited summary for the demo yard.',
  intro: 'Edited intro paragraph for the demo yard.',
  method: 'Edited method note for the demo yard.',
  note: 'Edited note on the first pile.',
  closing: 'Edited closing remarks for the demo yard.',
};
/** Typed and exported at once, with no pause and no blur. */
const AT_ONCE = 'Closing remarks typed just before the export.';

/** Text without spaces, lower case: pdfjs splits the report's runs, headings are capitals. */
const flat = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Undo the escapes React's static markup puts in text. */
const unescape = (s: string) =>
  s
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** The HTML's print block (pages A to C, the PDF's markup). */
const printBlock = (html: string): string => {
  const at = html.indexOf('<div class="vr-print">');
  expect(at, 'the HTML has the print pages').toBeGreaterThan(0);
  return html.slice(at);
};

/** Answer every save dialog with `<dir>/<n>-<default name>`, and remember the last path. */
async function answerSaveDialogs(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, folder) => {
      let n = 0;
      const g = globalThis as unknown as { __lastSave?: string };
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        n += 1;
        g.__lastSave = `${folder}/${String(n)}-${name}`;
        return Promise.resolve({ canceled: false, filePath: g.__lastSave });
      };
    },
    dir.replace(/\\/g, '/'),
  );
}

/** Click an export button in the editor, wait for the saved toast, and return the file's path. */
async function exportFrom(
  app: ElectronApplication,
  win: Page,
  editor: Locator,
  name: 'Export HTML' | 'Export PDF',
): Promise<string> {
  const before = await win.getByTestId('export-toast-message').count();
  await editor.getByRole('button', { name, exact: true }).click();
  const msg = win.getByTestId('export-toast-message').nth(before);
  // stop at the first end, a saved file or a refusal, rather than waiting out a refusal
  await expect(msg).toContainText(/saved to|no pictures|could not|failed|not /i, {
    timeout: 240_000,
  });
  await expect(msg).toContainText('saved to');
  await win.getByRole('button', { name: 'Dismiss' }).last().click();
  const path = await app.evaluate(
    () => (globalThis as unknown as { __lastSave?: string }).__lastSave ?? '',
  );
  expect(path).toMatch(name === 'Export HTML' ? /\.html$/ : /\.pdf$/);
  return path;
}

/**
 * Open the quarry and prepare every survey's surface from the first pile's card (the real
 * `survey.prepare` job), as `volume-over-time.spec.ts` does; preparing on open is off first.
 */
async function prepared(win: Page, name: string, id: string): Promise<void> {
  await setAutoPrepare(win, false);
  await openDemo(win, name, id);
  await measureTree(win);
  const card = await focusMeasure(win, 'Stockpile SP1');
  await card.getByTestId('survey-prepare').click();
  await expect(card.getByTestId('survey-prepare')).toHaveCount(0, { timeout: 240_000 });
  await volumeSettled(card, 1, 120_000);
}

/** Reports, Customer reports, Open volumetric report: the editor with its fields ready. */
async function openEditor(win: Page): Promise<Locator> {
  await win.locator('.sb-nav .nav-item', { hasText: 'Reports' }).first().click();
  const block = win.getByTestId('customer-reports');
  await expect(block).toBeVisible({ timeout: 60_000 });
  await expect(block.getByRole('heading', { name: 'Customer reports' })).toBeVisible();
  await block.getByRole('button', { name: 'Open volumetric report' }).click();
  const editor = win.getByTestId('volumetric-editor');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(editor.getByTestId('volumetric-preview')).toBeVisible();
  // the exports need the pictures: take them from the 3D stage once (they are saved with the
  // project, so a reopen finds them current)
  const bar = editor.getByTestId('volumetric-pictures');
  if ((await bar.count()) > 0) {
    await bar.getByRole('button', { name: /^Take pictures/ }).click();
    const progress = win.getByTestId('volumetric-picture-progress');
    await expect(progress).toBeVisible({ timeout: 30_000 });
    await expect(progress).toHaveCount(0, { timeout: 300_000 });
    await expect(bar, 'the pictures are current').toHaveCount(0, { timeout: 60_000 });
    await expect(editor).toBeVisible();
  }
  return editor;
}

const box = (editor: Locator, name: string) => editor.getByRole('textbox', { name, exact: true });

/** The editor's save state has settled on Saved. */
async function saved(editor: Locator): Promise<void> {
  await expect(editor.locator('.nar-h').getByText('Saved', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

interface TextFile {
  parts: Record<string, { versions: { text: string; source: string }[] }>;
  pileNotes?: Record<string, { versions: { text: string; source: string }[] }>;
  pages?: Record<string, boolean>;
}

async function readTextFile(dir: string): Promise<TextFile | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'report', 'volumetric.json'), 'utf8')) as TextFile;
  } catch {
    return null;
  }
}

const newest = (part: { versions: { text: string; source: string }[] } | undefined) =>
  part?.versions.at(-1) ?? null;

test('edits show in the preview and the HTML, persist across a reopen, and reset', async ({
  app,
  dataRoot,
  quarryProject,
  win,
}) => {
  test.setTimeout(900_000);
  const p = quarryProject;
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaveDialogs(app, out);
  await prepared(win, p.name, p.id);

  let editor = await openEditor(win);
  const preview = editor.getByTestId('volumetric-preview');

  // the generated texts, before any edit
  const summary = box(editor, 'In short');
  await expect(summary).not.toHaveValue('');
  const generated = await summary.inputValue();
  await expect(preview).toContainText(generated.trim().slice(0, 40));
  await expect(editor.getByRole('button', { name: /^Reset to generated: In short$/ })).toHaveCount(
    0,
  );

  // every edit shows in the preview as it is typed
  const fields: [string, string][] = [
    ['Title', EDITS.title],
    ['Prepared for', EDITS.preparedFor],
    ['In short', EDITS.summary],
    ['Intro', EDITS.intro],
    ['Method note', EDITS.method],
  ];
  for (const [name, text] of fields) {
    await box(editor, name).fill(text);
    await expect(preview, name).toContainText(text);
  }
  const note = editor.getByRole('textbox', { name: /^Note on .*SP1$/ });
  await note.fill(EDITS.note);
  await expect(preview).toContainText(EDITS.note);
  await box(editor, 'Closing remarks').fill(EDITS.closing);
  await expect(preview).toContainText(EDITS.closing);
  await box(editor, 'Closing remarks').blur();
  await expect(preview).not.toContainText(generated.trim().slice(0, 40));
  await saved(editor);

  // the HTML has every edited text
  let html = unescape(await readFile(await exportFrom(app, win, editor, 'Export HTML'), 'utf8'));
  for (const text of Object.values(EDITS)) expect(html, text).toContain(text);

  // typed and exported at once: the export hands the pending edit over first
  await box(editor, 'Closing remarks').fill(AT_ONCE);
  html = unescape(await readFile(await exportFrom(app, win, editor, 'Export HTML'), 'utf8'));
  expect(html).toContain(AT_ONCE);
  expect(html).not.toContain(EDITS.closing);
  await saved(editor);

  // saved as the person's own versions
  await expect
    .poll(async () => newest((await readTextFile(p.dir))?.parts.closing)?.text ?? null)
    .toBe(AT_ONCE);
  const file = await readTextFile(p.dir);
  const want: Record<string, string> = {
    title: EDITS.title,
    preparedFor: EDITS.preparedFor,
    summary: EDITS.summary,
    intro: EDITS.intro,
    method: EDITS.method,
    closing: AT_ONCE,
  };
  for (const [id, text] of Object.entries(want))
    expect(newest(file?.parts[id]), id).toMatchObject({ text, source: 'user' });
  const notes = Object.values(file?.pileNotes ?? {}).map((n) => newest(n));
  expect(notes).toContainEqual(expect.objectContaining({ text: EDITS.note, source: 'user' }));

  // closed and opened again: the editor shows the edits
  await win.locator('.proj-switch').focus();
  await win.keyboard.press('Enter');
  await win.locator('.proj-menu').getByRole('menuitem', { name: 'Close project' }).click();
  await expect(win.getByTestId('project-card').first()).toBeVisible({ timeout: 60_000 });
  await openDemo(win, p.name, p.id);
  editor = await openEditor(win);
  for (const [name, text] of [...fields, ['Closing remarks', AT_ONCE] as [string, string]])
    await expect(box(editor, name), name).toHaveValue(text);
  await expect(editor.getByRole('textbox', { name: /^Note on .*SP1$/ })).toHaveValue(EDITS.note);
  await expect(editor.getByTestId('volumetric-preview')).toContainText(EDITS.summary);

  // Reset to generated: the generated summary is back, in the preview and the next export
  await editor.getByRole('button', { name: 'Reset to generated: In short' }).click();
  await expect(box(editor, 'In short')).toHaveValue(generated);
  await expect(editor.getByTestId('volumetric-preview')).toContainText(
    generated.trim().slice(0, 40),
  );
  await expect(editor.getByTestId('volumetric-preview')).not.toContainText(EDITS.summary);
  await saved(editor);
  await expect
    .poll(async () => newest((await readTextFile(p.dir))?.parts.summary)?.source ?? null)
    .toBe('template');
  html = unescape(await readFile(await exportFrom(app, win, editor, 'Export HTML'), 'utf8'));
  expect(html).not.toContain(EDITS.summary);
  expect(html).toContain(generated.trim());
  // the other edits stay as written
  expect(html).toContain(EDITS.title);
});

test('pages turned off leave the preview, the PDF and the HTML; one page stays on', async ({
  app,
  dataRoot,
  quarryProject,
  win,
}) => {
  test.setTimeout(900_000);
  const p = quarryProject;
  const out = join(dataRoot.base, 'out');
  await mkdir(out, { recursive: true });
  await answerSaveDialogs(app, out);
  await prepared(win, p.name, p.id);

  const editor = await openEditor(win);
  const preview = editor.getByTestId('volumetric-preview');
  const pileCards = preview.locator('.vr-page-piles');
  const page = (name: string) => editor.getByRole('checkbox', { name, exact: true });
  const A = page('A. Cover and summary');
  const B = page('B. Pile cards');
  const C = page('C. What changed');
  for (const c of [A, B, C]) await expect(c).toBeChecked();
  await expect(pileCards.first()).toBeVisible();
  const cardPages = await pileCards.count();
  const allPages = await preview.locator('.vr-page').count();

  // all on: the PDF and the HTML print pile cards
  const full = await pdfText(
    await exportFrom(app, win, editor, 'Export PDF'),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  expect(full.count).toBe(allPages);
  expect(flat([...full.text.values()].join(' '))).toContain(flat('Share of stock on hand'));
  let html = await readFile(await exportFrom(app, win, editor, 'Export HTML'), 'utf8');
  expect(printBlock(html)).toContain('vr-page-piles');

  // B off: gone from the preview, the PDF (one page fewer per card page) and the HTML print
  await B.uncheck();
  await expect(B).not.toBeChecked();
  await expect(pileCards).toHaveCount(0);
  await expect(preview.locator('.vr-page')).toHaveCount(allPages - cardPages);
  await saved(editor);
  await expect.poll(async () => (await readTextFile(p.dir))?.pages?.piles ?? null).toBe(false);
  const less = await pdfText(
    await exportFrom(app, win, editor, 'Export PDF'),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  expect(less.count).toBe(full.count - cardPages);
  expect(flat([...less.text.values()].join(' '))).not.toContain(flat('Share of stock on hand'));
  html = await readFile(await exportFrom(app, win, editor, 'Export HTML'), 'utf8');
  expect(printBlock(html)).not.toContain('vr-page-piles');
  expect(printBlock(html)).toContain('vr-page-cover');

  // A off too: C is the last page on and cannot be turned off
  await A.uncheck();
  await expect(A).not.toBeChecked();
  await expect(C).toBeChecked();
  await expect(C).toBeDisabled();
  await expect(preview.locator('.vr-page-cover')).toHaveCount(0);
  await expect(preview.locator('.vr-page-change').first()).toBeVisible();
  // and A, B come back on
  await A.check();
  await B.check();
  await expect(C).toBeEnabled();
  await expect(pileCards).toHaveCount(cardPages);
  await expect(preview.locator('.vr-page')).toHaveCount(allPages);
});
