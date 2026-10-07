import { addNarrativeVersion } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNarrative, readPackageNarrative, writeNarrative, NARRATIVE_PATH } from './narrative';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-narrative-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const version = (text: string) => ({
  text,
  source: 'user' as const,
  createdAt: '2026-10-04T10:00:00Z',
});

describe('report narrative store', () => {
  it('reads nothing before the first save, then every version saved', async () => {
    expect(await readNarrative(root)).toEqual({ ok: true, file: null, readOnly: false });
    const one = addNarrativeVersion(null, 'summary', version('First'));
    expect(await writeNarrative(root, one)).toEqual({ ok: true });
    const two = addNarrativeVersion(one, 'summary', version('Second'));
    expect(await writeNarrative(root, two)).toEqual({ ok: true });
    const r = await readNarrative(root);
    expect(r.ok && r.file?.parts.summary?.versions.map((v) => v.text)).toEqual(['First', 'Second']);
    // the previous file is kept as a backup
    const bak = JSON.parse(await readFile(join(root, `${NARRATIVE_PATH}.bak`), 'utf8')) as {
      parts: { summary: { versions: unknown[] } };
    };
    expect(bak.parts.summary.versions).toHaveLength(1);
  });

  it('reports an invalid file instead of losing it', async () => {
    await mkdir(join(root, 'report'));
    await writeFile(join(root, NARRATIVE_PATH), '{"schema":"aio.narrative/9","parts":{}}');
    const r = await readNarrative(root);
    expect(r.ok).toBe(false);
  });

  it('refuses a narrative saved by a newer version and never saves over it', async () => {
    const one = addNarrativeVersion(null, 'summary', version('First'));
    await writeNarrative(root, one);
    expect(await readNarrative(root)).toEqual({ ok: true, file: one, readOnly: false });
    const newer = `${JSON.stringify({ ...one, schema: 'aio.narrative/2', more: [] }, null, 1)}\n`;
    await writeFile(join(root, NARRATIVE_PATH), newer);
    const message =
      'report/narrative.json was saved by a newer version of Stratlas (aio.narrative/2). Update the app to open it. The file was not changed.';
    expect(await readNarrative(root)).toEqual({ ok: false, error: message });
    const two = addNarrativeVersion(one, 'summary', version('Second'));
    expect(await writeNarrative(root, two)).toEqual({ ok: false, error: message });
    expect(await readFile(join(root, NARRATIVE_PATH), 'utf8')).toBe(newer);
    const archive = {
      entries: new Map([[NARRATIVE_PATH, {}]]),
      read: () => Promise.resolve(Buffer.from(newer)),
    };
    expect(await readPackageNarrative(archive)).toEqual({ ok: false, error: message });
  });

  it('reads a package narrative read only', async () => {
    const file = addNarrativeVersion(null, 'method', version('Method'));
    const entries = new Map([[NARRATIVE_PATH, {}]]);
    const archive = {
      entries,
      read: () => Promise.resolve(Buffer.from(JSON.stringify(file))),
    };
    expect(await readPackageNarrative(archive)).toEqual({ ok: true, file, readOnly: true });
    expect(await readPackageNarrative({ entries: new Map(), read: archive.read })).toEqual({
      ok: true,
      file: null,
      readOnly: true,
    });
  });
});
