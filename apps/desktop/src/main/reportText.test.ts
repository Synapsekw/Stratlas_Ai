import { REPORT_TEXT_SCHEMA, withVersion, type ReportTextFile } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHANGED_ON_DISK_PHRASE } from './fsutil';
import { readPackageReportText, readReportText, writeReportText } from './reportText';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-report-text-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const REL = 'report/volumetric.json';

const text = (summary: string, extra: Partial<ReportTextFile> = {}): ReportTextFile => ({
  schema: REPORT_TEXT_SCHEMA,
  report: 'volumetric',
  parts: {
    summary: withVersion(undefined, {
      text: summary,
      source: 'user',
      createdAt: '2026-10-25T10:00:00Z',
    }),
  },
  ...extra,
});

describe('report text store', () => {
  it('reads nothing before the first save, then the saved file, keeping a .bak', async () => {
    expect(await readReportText(root, 'volumetric')).toEqual({
      ok: true,
      file: null,
      readOnly: false,
    });
    const one = text('First', { pages: { change: false }, compareWith: 'cap-1' });
    expect(await writeReportText(root, 'volumetric', one)).toEqual({ ok: true });
    expect(await readReportText(root, 'volumetric')).toEqual({
      ok: true,
      file: one,
      readOnly: false,
    });
    const two = text('Second');
    expect(await writeReportText(root, 'volumetric', two)).toEqual({ ok: true });
    const bak = JSON.parse(await readFile(join(root, `${REL}.bak`), 'utf8')) as ReportTextFile;
    expect(bak.parts.summary?.versions[0]?.text).toBe('First');
    const r = await readReportText(root, 'volumetric');
    expect(r.ok && r.file?.parts.summary?.versions[0]?.text).toBe('Second');
  });

  it('keeps keys a later build added', async () => {
    const file = { ...text('Kept'), later: { a: 1 } } as ReportTextFile;
    await writeReportText(root, 'volumetric', file);
    const r = await readReportText(root, 'volumetric');
    expect(r.ok && (r.file as Record<string, unknown>).later).toEqual({ a: 1 });
  });

  it('reports an invalid file with its name instead of losing it', async () => {
    await mkdir(join(root, 'report'));
    const bad = '{"schema":"aio.report-text/1","report":"volumetric","parts":{"Bad id":{}}}';
    await writeFile(join(root, REL), bad);
    const r = await readReportText(root, 'volumetric');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^report\/volumetric\.json is invalid at parts/);
    expect(await readFile(join(root, REL), 'utf8')).toBe(bad);
  });

  it('refuses a file saved by a newer version and never saves over it', async () => {
    await mkdir(join(root, 'report'));
    const newer = JSON.stringify({ ...text('Newer'), schema: 'aio.report-text/2' });
    await writeFile(join(root, REL), newer);
    const r = await readReportText(root, 'volumetric');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/newer version.*aio\.report-text\/2/);
    const w = await writeReportText(root, 'volumetric', text('Mine'));
    expect(w.ok).toBe(false);
    expect(w.error).toMatch(/newer version/);
    expect(await readFile(join(root, REL), 'utf8')).toBe(newer);
  });

  it('refuses a save over a file someone else changed since it was read', async () => {
    await writeReportText(root, 'volumetric', text('First'));
    expect((await readReportText(root, 'volumetric')).ok).toBe(true);
    const theirs = `${JSON.stringify(text('Theirs'))}\n`;
    await writeFile(join(root, REL), theirs);
    const w = await writeReportText(root, 'volumetric', text('Mine'));
    expect(w.ok).toBe(false);
    expect(w.error).toContain(CHANGED_ON_DISK_PHRASE);
    expect(await readFile(join(root, REL), 'utf8')).toBe(theirs);
  });

  it('refuses a file of another report type', async () => {
    const w = await writeReportText(root, 'volumetric', { ...text('x'), report: 'other' });
    expect(w.ok).toBe(false);
  });

  it('reads a package in place, read only', async () => {
    const file = text('Packaged');
    const archive = {
      entries: new Map([[REL, {}]]),
      read: () => Promise.resolve(Buffer.from(JSON.stringify(file))),
    };
    expect(await readPackageReportText(archive, 'volumetric')).toEqual({
      ok: true,
      file,
      readOnly: true,
    });
    expect(
      await readPackageReportText({ entries: new Map(), read: archive.read }, 'volumetric'),
    ).toEqual({ ok: true, file: null, readOnly: true });
  });
});
