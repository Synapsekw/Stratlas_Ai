import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openTarget } from './index';

const job = {
  id: 'j1',
  project: join('E:', 'p'),
  artifacts: [] as { path: string; kind: string }[],
};

describe('openTarget', () => {
  it('reveals a file output, opens a folder output, and has nothing to open before outputs exist', () => {
    expect(openTarget(job, 'output')).toBeNull();
    expect(
      openTarget({ ...job, artifacts: [{ path: 'photos', kind: 'folder' }] }, 'output'),
    ).toEqual({ action: 'open', path: join('E:', 'p', 'photos') });
    expect(
      openTarget(
        {
          ...job,
          artifacts: [
            { path: 'jobs/j1/selftest.json', kind: 'file' },
            { path: 'out/cameras.json', kind: 'file' },
          ],
        },
        'output',
      ),
    ).toEqual({ action: 'reveal', path: join('E:', 'p', 'out', 'cameras.json') });
  });

  it('points at the job log and the project', () => {
    expect(openTarget(job, 'log')).toEqual({
      action: 'reveal',
      path: join('E:', 'p', 'jobs', 'j1', 'job.log'),
    });
    expect(openTarget(job, 'project')).toEqual({ action: 'open', path: join('E:', 'p') });
  });
});
