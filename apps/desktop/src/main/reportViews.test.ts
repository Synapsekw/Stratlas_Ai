import { REPORT_VIEWS_SCHEMA, type ReportViewsFrame } from '@aio/schema';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveReportViews, viewsRecord } from './reportViews';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-report-views-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const DIR = ['report', 'views', 'volumetric'];

const frame = (files: string[]): ReportViewsFrame => ({
  schema: REPORT_VIEWS_SCHEMA,
  extent: [100, 200, 300, 400],
  widthPx: 400,
  heightPx: 400,
  mPerPx: 0.5,
  views: files.map((file, i) => ({
    name: file.replace(/\.jpg$/, ''),
    kind: 'photo' as const,
    capture: `cap-${String(i)}`,
    file,
  })),
  markers3d: {},
  fingerprint: 'fp-1',
});

const jpg = (name: string, fill: number, size = 16) => ({
  name,
  data: new Uint8Array(size).fill(fill),
});

const list = async () => (await readdir(join(root, ...DIR))).sort();

describe('report pictures store', () => {
  it('writes the pictures and frame.json, with the names and sizes in the frame', async () => {
    const r = await saveReportViews(root, 'volumetric', frame(['a.jpg', 'b-2.jpg']), [
      jpg('a.jpg', 1),
      jpg('b-2.jpg', 2, 32),
    ]);
    expect(r).toEqual({ ok: true });
    expect(await list()).toEqual(['a.jpg', 'b-2.jpg', 'frame.json']);
    expect([...(await readFile(join(root, ...DIR, 'b-2.jpg')))]).toEqual(Array(32).fill(2));
    const saved = JSON.parse(await readFile(join(root, ...DIR, 'frame.json'), 'utf8')) as unknown;
    expect(saved).toEqual(
      viewsRecord(frame(['a.jpg', 'b-2.jpg']), [jpg('a.jpg', 1), jpg('b-2.jpg', 2, 32)]),
    );
    expect((saved as { files: unknown }).files).toEqual([
      { name: 'a.jpg', bytes: 16 },
      { name: 'b-2.jpg', bytes: 32 },
    ]);
  });

  it('replaces the previous set: old pictures not in the new frame are removed', async () => {
    await saveReportViews(root, 'volumetric', frame(['a.jpg', 'old.jpg']), [
      jpg('a.jpg', 1),
      jpg('old.jpg', 9),
    ]);
    // a part file left by a crash is cleared too
    await writeFile(join(root, ...DIR, 'a.jpg.123.part'), 'x');
    const r = await saveReportViews(root, 'volumetric', frame(['a.jpg', 'c.jpg']), [
      jpg('a.jpg', 5),
      jpg('c.jpg', 6),
    ]);
    expect(r).toEqual({ ok: true });
    expect(await list()).toEqual(['a.jpg', 'c.jpg', 'frame.json']);
    expect([...(await readFile(join(root, ...DIR, 'a.jpg')))][0]).toBe(5);
  });

  it('refuses names outside the pattern and paths outside the folder, touching nothing', async () => {
    for (const name of ['../escape.jpg', 'A.jpg', 'x.png', 'a/b.jpg', '..\\x.jpg']) {
      const r = await saveReportViews(root, 'volumetric', frame([]), [jpg(name, 1)]);
      expect(r.ok, name).toBe(false);
    }
    await expect(readdir(join(root, 'report'))).rejects.toThrow();
  });

  it('refuses a frame naming a picture that was not sent, and duplicate names', async () => {
    const missing = await saveReportViews(root, 'volumetric', frame(['a.jpg', 'b.jpg']), [
      jpg('a.jpg', 1),
    ]);
    expect(missing.ok).toBe(false);
    const twice = await saveReportViews(root, 'volumetric', frame(['a.jpg']), [
      jpg('a.jpg', 1),
      jpg('a.jpg', 2),
    ]);
    expect(twice.ok).toBe(false);
  });

  it('never saves over a frame written by a newer version', async () => {
    await mkdir(join(root, ...DIR), { recursive: true });
    const newer = JSON.stringify({ ...frame([]), schema: 'aio.report-views/2' });
    await writeFile(join(root, ...DIR, 'frame.json'), newer);
    await writeFile(join(root, ...DIR, 'keep.jpg'), 'k');
    const r = await saveReportViews(root, 'volumetric', frame(['a.jpg']), [jpg('a.jpg', 1)]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/newer version/);
    expect(await list()).toEqual(['frame.json', 'keep.jpg']);
  });
});
