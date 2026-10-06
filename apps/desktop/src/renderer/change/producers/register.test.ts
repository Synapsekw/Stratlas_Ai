import { registerChangeProducer, type ChangeProducer } from '@aio/change';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChangeProducers } from './register';

vi.mock('../../shell', () => ({
  jobs: { getState: () => ({}) },
  shell: { getState: () => ({ pkg: null, settings: {} }) },
}));

const manifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'Two dates',
  frame: { kind: 'local' },
  captures: [
    { id: 'c1', label: 'March', date: '2026-03-02' },
    { id: 'c2', label: 'April', date: '2026-04-13' },
  ],
  layers: [],
} as unknown as ProjectManifest;

const producer = (id: string, available: true | string) => {
  const run = vi.fn(() => Promise.resolve({ ok: true as const, jobId: `job-${id}` }));
  const p: ChangeProducer = {
    id,
    label: `Run ${id} change`,
    kinds: ['region'],
    available: () => available,
    run,
  };
  return { p, run };
};

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  workspace.setState({ project: null });
});

describe('runChangeProducers (the agent hook)', () => {
  it('runs the chosen producers, says why one cannot run and skips them all for "all"', async () => {
    workspace.setState({ project: { id: 'p1', root: 'C:/p', manifest } });
    const ready = producer('t-ready', true);
    const missing = producer('t-missing', 'No point clouds on both dates');
    offs.push(registerChangeProducer(ready.p), registerChangeProducer(missing.p));

    const chosen = await runChangeProducers({
      projectId: 'p1',
      from: 'c1',
      to: 'c2',
      ids: ['t-ready', 't-missing', 't-unknown'],
    });
    expect(chosen).toEqual([
      { id: 't-unknown', label: 't-unknown', ok: false, error: 'Not available in this app.' },
      { id: 't-ready', label: 'Run t-ready change', ok: true, jobId: 'job-t-ready' },
      {
        id: 't-missing',
        label: 'Run t-missing change',
        ok: false,
        error: 'No point clouds on both dates',
      },
    ]);
    expect(ready.run).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', from: 'c1', to: 'c2' }),
    );

    const all = await runChangeProducers({ projectId: 'p1', from: 'c1', to: 'c2', ids: 'all' });
    expect(all.map((r) => r.id)).toContain('t-ready');
    expect(all.map((r) => r.id)).not.toContain('t-missing');
    expect(missing.run).not.toHaveBeenCalled();
  });

  it('runs nothing for a project that is not open', async () => {
    expect(await runChangeProducers({ projectId: 'p1', from: 'c1', to: 'c2', ids: 'all' })).toEqual(
      [],
    );
  });
});
