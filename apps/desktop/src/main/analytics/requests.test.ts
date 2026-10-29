import { AI_REQUEST_SCHEMA, type AiRequest } from '@aio/schema';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  exportRequest,
  importRequest,
  listRequests,
  removeRequest,
  requestDirs,
  saveRequest,
} from './requests';

const req = (id: string, name = `Request ${id}`): AiRequest => ({
  schema: AI_REQUEST_SCHEMA,
  id,
  name,
  kind: 'find',
  prompt: 'Find every gauge.',
  fields: [{ key: 'reading', label: 'Reading', type: 'number', unit: 'bar' }],
  scope: 'photo',
  model: 'auto',
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

let root: string;
let o: { userData: string; projectDir: string };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-requests-'));
  o = { userData: join(root, 'user'), projectDir: join(root, 'project') };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('requests', () => {
  it('names the folders', () => {
    expect(requestDirs(o)).toEqual({
      library: join(o.userData, 'requests'),
      project: join(o.projectDir, 'requests'),
    });
    expect(requestDirs({ userData: o.userData }).project).toBeNull();
  });

  it('saves, then lists project first and each by name', async () => {
    await saveRequest(o, 'library', req('zeta', 'Zeta'));
    await saveRequest(o, 'library', req('alpha', 'Alpha'));
    await saveRequest(o, 'project', req('mid', 'Mid'));
    const r = await listRequests(o);
    expect(r.problems).toEqual([]);
    expect(r.items.map((i) => [i.where, i.request.id])).toEqual([
      ['project', 'mid'],
      ['library', 'alpha'],
      ['library', 'zeta'],
    ]);
  });

  it('lists an invalid file under problems, not items', async () => {
    await saveRequest(o, 'library', req('good'));
    await writeFile(join(o.userData, 'requests', 'bad.json'), '{"schema":"nope"}');
    await writeFile(join(o.userData, 'requests', 'broken.json'), '{not json');
    const r = await listRequests(o);
    expect(r.items.map((i) => i.request.id)).toEqual(['good']);
    expect(r.problems.map((p) => p.file).sort()).toEqual(['bad.json', 'broken.json']);
  });

  it('lists nothing when there are no folders', async () => {
    expect(await listRequests(o)).toEqual({ items: [], problems: [] });
  });

  it('refuses an invalid request and a project save without a project', async () => {
    await expect(saveRequest(o, 'library', { ...req('x'), prompt: '' })).rejects.toThrow();
    await expect(saveRequest({ userData: o.userData }, 'project', req('x'))).rejects.toThrow(
      /project/i,
    );
  });

  it('keeps a .bak of the previous file on replace', async () => {
    await saveRequest(o, 'library', req('aa', 'One'));
    await saveRequest(o, 'library', req('aa', 'Two'));
    const bak = JSON.parse(
      await readFile(join(o.userData, 'requests', 'aa.json.bak'), 'utf8'),
    ) as AiRequest;
    expect(bak.name).toBe('One');
  });

  it('removes', async () => {
    await saveRequest(o, 'library', req('aa'));
    await removeRequest(o, 'library', 'aa');
    expect((await listRequests(o)).items).toEqual([]);
    await expect(removeRequest(o, 'library', 'aa')).resolves.toBeUndefined();
  });

  it('exports then imports an equal request, renumbering an id that exists', async () => {
    await saveRequest(o, 'project', req('gauges'));
    await saveRequest(o, 'library', req('gauges'));
    const file = join(root, 'out.aioreq');
    await exportRequest(o, 'project', 'gauges', file);
    const got = await importRequest(o, 'library', file);
    expect(got).toEqual({ ...req('gauges'), id: 'gauges-2' });
    const again = await importRequest(o, 'library', file);
    expect(again.id).toBe('gauges-3');
    expect((await listRequests(o)).items.map((i) => i.request.id)).toContain('gauges-3');
  });

  it('refuses a file over 64 KB and an invalid one', async () => {
    const big = join(root, 'big.aioreq');
    await writeFile(big, JSON.stringify({ ...req('big'), prompt: 'x'.repeat(70 * 1024) }));
    await expect(importRequest(o, 'library', big)).rejects.toThrow(/64 KB/);
    const bad = join(root, 'bad.aioreq');
    await writeFile(bad, '{"schema":"aio.ai-request/1"}');
    await expect(importRequest(o, 'library', bad)).rejects.toThrow();
  });
});
