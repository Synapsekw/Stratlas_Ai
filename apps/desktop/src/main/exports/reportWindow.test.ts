import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the fake report window publishes and what main asked of it. */
const page = vi.hoisted(() => ({
  report: null as Record<string, unknown> | null,
  loaded: [] as { file: string; query: Record<string, string> }[],
  printed: 0,
  destroyed: 0,
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      executeJavaScript: (expr: string): Promise<string> => {
        const r = page.report;
        if (expr.includes('__report?.html'))
          return Promise.resolve(typeof r?.html === 'string' ? r.html : '');
        if (expr.includes('__report?.model'))
          return Promise.resolve(JSON.stringify(r?.model ?? null));
        return Promise.resolve(JSON.stringify(r));
      },
      printToPDF: () => {
        page.printed++;
        return Promise.resolve(Buffer.from('%PDF-1.7'));
      },
    };
    loadFile(file: string, opts: { query: Record<string, string> }) {
      page.loaded.push({ file, query: opts.query });
      return Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
    }
    destroy() {
      page.destroyed++;
    }
  },
}));

const { pageQuery, printReport, reportDeadlineMs, reportModel } = await import('./reportWindow');

const opts = { devUrl: undefined, devTools: false };
const ready = { state: 'ready', phase: 'Done', done: 1, total: 1 };
let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-report-window-'));
  page.report = null;
  page.loaded = [];
  page.printed = 0;
  page.destroyed = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('pageQuery', () => {
  const full = {
    branding: { companyName: 'Survey Co' },
    contents: { sections: { cover: false } },
    audit: null,
    signoff: '{"approvals":[]}',
    processingRun: '20261007-0915',
    surveySurfaces: ['s1', 's2'],
    surveyRuns: { haul: ['h1'], hydro: ['y1'] },
  } as unknown as Parameters<typeof pageQuery>[1];

  it('asks the house page for the volumetric kind alone, with the compared date', () => {
    for (const kind of ['volumetric-pdf', 'volumetric-html', 'volumetric-model'] as const)
      expect(pageQuery({ projectId: 'p', kind, compareWith: 'cap-2' }, full)).toEqual({
        project: 'p',
        only: kind,
        compare: 'cap-2',
        branding: JSON.stringify({ companyName: 'Survey Co' }),
        surfaces: 's1,s2',
      });
    expect(pageQuery({ projectId: 'p', kind: 'volumetric-pdf' }, full)).not.toHaveProperty(
      'compare',
    );
  });

  it('keeps the house and survey queries as they were', () => {
    expect(pageQuery({ projectId: 'p', kind: 'house' }, full)).toEqual({
      project: 'p',
      branding: JSON.stringify({ companyName: 'Survey Co' }),
      contents: JSON.stringify({ sections: { cover: false } }),
      signoff: '{"approvals":[]}',
      processing: '20261007-0915',
      surfaces: 's1,s2',
      haul: 'h1',
      hydro: 'y1',
    });
    expect(pageQuery({ projectId: 'p', kind: 'stockpile-csv' }, full)).toMatchObject({
      only: 'stockpile-csv',
    });
    expect(pageQuery({ projectId: 'p', issueIds: ['a', 'b'] }, full)).toEqual({
      project: 'p',
      ids: 'a,b',
      branding: JSON.stringify({ companyName: 'Survey Co' }),
    });
  });

  it('gives the volumetric kinds 15 minutes and the house report 90', () => {
    expect(reportDeadlineMs('volumetric-pdf')).toBe(15 * 60_000);
    expect(reportDeadlineMs('volumetric-html')).toBe(15 * 60_000);
    expect(reportDeadlineMs('volumetric-model')).toBe(15 * 60_000);
    expect(reportDeadlineMs('house')).toBe(90 * 60_000);
    expect(reportDeadlineMs(undefined)).toBe(15 * 60_000);
  });
});

describe('printReport', () => {
  const run = (kind: 'volumetric-html' | 'volumetric-pdf', outPath: string) =>
    printReport(
      { projectId: 'p', outPath, kind },
      () => undefined,
      new AbortController().signal,
      opts,
    );

  it('writes the volumetric HTML the page publishes, never printing it', async () => {
    page.report = { ...ready, count: 3, html: '<!doctype html><p>Stock on hand ±</p>' };
    const out = join(dir, 'report.html');
    const r = await run('volumetric-html', out);
    expect(await readFile(out, 'utf8')).toBe('<!doctype html><p>Stock on hand ±</p>');
    expect(await readdir(dir)).toEqual(['report.html']);
    expect(r).toEqual({ count: 3, bytes: Buffer.byteLength(page.report.html as string) });
    expect(page.printed).toBe(0);
    expect(page.loaded[0]?.file).toMatch(/house\.html$/);
    expect(page.loaded[0]?.query.only).toBe('volumetric-html');
    expect(page.destroyed).toBe(1);
  });

  it('refuses an empty HTML and leaves no file behind', async () => {
    page.report = { ...ready };
    await expect(run('volumetric-html', join(dir, 'report.html'))).rejects.toThrow(/no HTML/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('prints the volumetric PDF from the house page', async () => {
    page.report = { ...ready, pages: 4 };
    const out = join(dir, 'report.pdf');
    await run('volumetric-pdf', out);
    expect(page.printed).toBe(1);
    expect(await readFile(out, 'utf8')).toBe('%PDF-1.7');
    expect(page.loaded[0]?.query.only).toBe('volumetric-pdf');
  });

  it('passes the page error on', async () => {
    page.report = {
      state: 'error',
      phase: '',
      done: 0,
      total: 0,
      error: 'Take pictures in the app first.',
    };
    await expect(run('volumetric-pdf', join(dir, 'r.pdf'))).rejects.toThrow(
      'Take pictures in the app first.',
    );
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('reportModel', () => {
  it('returns the model the page publishes and never prints', async () => {
    page.report = { ...ready, model: { piles: [{ id: 'm1' }], latest: 'cap-3' } };
    const model = await reportModel(
      { projectId: 'p', compareWith: 'cap-1' },
      new AbortController().signal,
      opts,
    );
    expect(model).toEqual({ piles: [{ id: 'm1' }], latest: 'cap-3' });
    expect(page.printed).toBe(0);
    expect(page.loaded[0]?.query).toMatchObject({
      project: 'p',
      only: 'volumetric-model',
      compare: 'cap-1',
    });
    expect(page.destroyed).toBe(1);
  });

  it('refuses when the page publishes no model', async () => {
    page.report = { ...ready };
    await expect(
      reportModel({ projectId: 'p' }, new AbortController().signal, opts),
    ).rejects.toThrow(/no model/);
  });
});
