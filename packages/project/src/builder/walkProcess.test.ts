import { WALK_PROCESS_MAX_BYTES, WALK_PROCESS_SCHEMA, type WalkProcessFile } from '@aio/schema';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageProcessSummaries, readProcessSummaries } from './walkProcess';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-walk-process-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const record = (walk: string, o: Partial<WalkProcessFile> = {}): WalkProcessFile => ({
  schema: WALK_PROCESS_SCHEMA,
  walk,
  createdAt: '2026-10-12T10:00:00.000Z',
  engine: { version: '0.6.0' },
  input: { layout: 'insv-dual-stream', calibration: 'trailer', imu: true },
  outputs: { stabilized: `walks/${walk}/stabilized.mp4` },
  stabilize: { levelled: true, keptYaw: true },
  stills: { sfm: 10, map: 4 },
  path: { source: 'sfm', registeredFraction: 1, segments: 1 },
  timings: { read: 1 },
  warnings: ['one'],
  ...o,
});

async function put(id: string, text: string): Promise<void> {
  await mkdir(join(root, 'walks', id), { recursive: true });
  await writeFile(join(root, 'walks', id, 'process.json'), text);
}

describe('readProcessSummaries', () => {
  it('summarises only records that parse and belong to their folder', async () => {
    await put('good', JSON.stringify(record('good')));
    await put(
      'pins',
      JSON.stringify(record('pins', { outputs: {}, warnings: [], path: pinsOnly() })),
    );
    await put('wrong', JSON.stringify(record('other')));
    await put('broken', '{ not json');
    await put('invalid', JSON.stringify({ schema: WALK_PROCESS_SCHEMA, walk: 'invalid' }));
    await put('newer', JSON.stringify({ ...record('newer'), schema: 'aio.walk-process/9' }));
    const big = JSON.stringify(record('big', { warnings: ['x'.repeat(300)] }));
    await put('big', big + ' '.repeat(WALK_PROCESS_MAX_BYTES));
    await mkdir(join(root, 'walks', 'none'), { recursive: true });

    const r = await readProcessSummaries(root, [
      'good',
      'pins',
      'wrong',
      'broken',
      'invalid',
      'newer',
      'big',
      'none',
      'missing',
    ]);
    expect(r).toEqual({
      good: {
        createdAt: '2026-10-12T10:00:00.000Z',
        stabilized: 'walks/good/stabilized.mp4',
        source: 'sfm',
        warnings: 1,
      },
      pins: { createdAt: '2026-10-12T10:00:00.000Z', source: 'pins-only', warnings: 0 },
    });
  });

  it('answers an empty record when nothing is processed or the folder is gone', async () => {
    expect(await readProcessSummaries(join(root, 'nowhere'), ['a'])).toEqual({});
    expect(await readProcessSummaries(root, [])).toEqual({});
  });

  it('never reads outside walks/ for an id with path segments', async () => {
    await writeFile(join(root, 'process.json'), JSON.stringify(record('..')));
    expect(await readProcessSummaries(join(root, 'sub'), ['..', '../..', '.'])).toEqual({});
  });
});

describe('packageProcessSummaries', () => {
  it('reads walks/<id>/process.json members the same way', async () => {
    const members = new Map<string, string>([
      ['walks/good/process.json', JSON.stringify(record('good'))],
      ['walks/wrong/process.json', JSON.stringify(record('other'))],
      ['walks/broken/process.json', '{'],
      ['walks/big/process.json', JSON.stringify(record('big'))],
      ['walks/good/walk.json', '{}'],
    ]);
    const entries = new Map<string, unknown>([...members.keys()].map((k) => [k, { size: 10 }]));
    entries.set('walks/big/process.json', { size: WALK_PROCESS_MAX_BYTES + 1 });
    entries.set('walks/unread/process.json', { size: 10 });
    const read = (name: string): Promise<Buffer> => {
      const t = members.get(name);
      return t === undefined
        ? Promise.reject(new Error('no such member'))
        : Promise.resolve(Buffer.from(t));
    };
    const r = await packageProcessSummaries({ entries, read }, [
      'good',
      'wrong',
      'broken',
      'big',
      'unread',
      'absent',
    ]);
    expect(Object.keys(r)).toEqual(['good']);
    expect(r.good?.source).toBe('sfm');
  });
});

function pinsOnly(): WalkProcessFile['path'] {
  return { source: 'pins-only', registeredFraction: 0.2, segments: 0 };
}
