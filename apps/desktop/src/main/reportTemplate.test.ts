import { emptyReportTemplate, REPORT_TEMPLATE_FILE, type ReportTemplateFile } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPackageTemplate, readTemplate, writeTemplate } from './reportTemplate';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-report-template-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const entry = (id: string) => ({
  kind: 'measurement' as const,
  id,
  parts: ['value' as const],
  addedAt: '2026-10-20T10:00:00Z',
});
const withEntries = (...ids: string[]): ReportTemplateFile => ({
  ...emptyReportTemplate(),
  entries: ids.map(entry),
});
const onDisk = async () => readFile(join(root, REPORT_TEMPLATE_FILE), 'utf8');

describe('report template store', () => {
  it('read returns null when no template', async () => {
    expect(await readTemplate(root)).toBeNull();
  });

  it('write is atomic and keeps a .bak', async () => {
    await writeTemplate(root, withEntries('a'));
    expect(await readTemplate(root)).toEqual(withEntries('a'));
    await writeTemplate(root, withEntries('a', 'b'));
    expect(
      (await readTemplate(root))?.entries.map((e) => (e.kind === 'measurement' ? e.id : '')),
    ).toEqual(['a', 'b']);
    const bak = JSON.parse(await readFile(join(root, `${REPORT_TEMPLATE_FILE}.bak`), 'utf8')) as {
      entries: unknown[];
    };
    expect(bak.entries).toHaveLength(1);
  });

  it('refuses an unreadable or invalid template and never writes over it', async () => {
    await mkdir(join(root, 'report'));
    for (const text of ['{ not json', '{"schema":"aio.report-template/1","entries":"x"}']) {
      await writeFile(join(root, REPORT_TEMPLATE_FILE), text);
      await expect(readTemplate(root)).rejects.toThrow();
      await expect(writeTemplate(root, withEntries('a'))).rejects.toThrow(/not/);
      expect(await onDisk()).toBe(text);
    }
  });

  it('refuses a template saved by a newer build and never writes over it', async () => {
    const newer = JSON.stringify({ schema: 'aio.report-template/2', entries: [], more: 1 });
    await mkdir(join(root, 'report'));
    await writeFile(join(root, REPORT_TEMPLATE_FILE), newer);
    await expect(readTemplate(root)).rejects.toThrow(/newer version/);
    await expect(writeTemplate(root, withEntries('a'))).rejects.toThrow(/newer version/);
    expect(await onDisk()).toBe(newer);
  });

  it('refuses a save over a template someone else changed since it was read', async () => {
    await writeTemplate(root, withEntries('a'));
    expect(await readTemplate(root)).toEqual(withEntries('a'));
    const theirs = `${JSON.stringify(withEntries('x'), null, 2)}\n`;
    await writeFile(join(root, REPORT_TEMPLATE_FILE), theirs);
    await expect(writeTemplate(root, withEntries('a', 'b'))).rejects.toThrow();
    expect(await onDisk()).toBe(theirs);
  });

  it('reads a package template in place', async () => {
    const file = withEntries('a');
    const read = () => Promise.resolve(Buffer.from(JSON.stringify(file)));
    expect(
      await readPackageTemplate({ entries: new Map([[REPORT_TEMPLATE_FILE, {}]]), read }),
    ).toEqual(file);
    expect(await readPackageTemplate({ entries: new Map(), read })).toBeNull();
  });
});
