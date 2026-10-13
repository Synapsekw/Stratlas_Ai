import type { JobRecord } from '@aio/schema';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobStore } from './store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-jobstore-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const job = (id: string, status: JobRecord['status'], createdAt: string): JobRecord => ({
  id,
  pipeline: 'photo.align',
  project: 'C:/projects/site',
  params: { run: '20261012-0930' },
  status,
  progress: 0,
  steps: [],
  artifacts: [],
  createdAt,
  updatedAt: createdAt,
});

describe('JobStore.delete', () => {
  it('forgets a finished job and the index on disk follows after a flush', async () => {
    const file = join(dir, 'jobs.json');
    const s = new JobStore(file);
    s.put(job('job-failed', 'failed', '2026-10-13T08:00:00.000Z'));
    s.put(job('job-done', 'done', '2026-10-13T09:00:00.000Z'));
    expect(s.delete('job-failed')).toBe(true);
    await s.flush();
    expect(s.get('job-failed')).toBeUndefined();
    const again = new JobStore(file);
    await again.load();
    expect(again.all().map((j) => j.id)).toEqual(['job-done']);
  });

  it('keeps an active job and answers false for one it does not know', () => {
    const s = new JobStore(join(dir, 'jobs.json'));
    s.put(job('job-live', 'running', '2026-10-13T08:00:00.000Z'));
    expect(s.delete('job-live')).toBe(false);
    expect(s.get('job-live')).toBeDefined();
    expect(s.delete('nope')).toBe(false);
  });
});
