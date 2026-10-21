import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRunner } from '../jobs/runner';
import { JobStore } from '../jobs/store';
import { createUpdateWorkGate } from './workGate';
describe('JobRunner update restart race', () => {
  it('reserves work before asynchronous pack lookup and rejects later internal starts after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gate-runner-'));
    const store = new JobStore(join(root, 'jobs.json'));
    try {
      const gate = createUpdateWorkGate();
      let finish: () => void = () => undefined;
      const pending = new Promise<void>((r) => {
        finish = r;
      });
      const runner = new JobRunner({
        store,
        enterWork: () => gate.enter(),
        emit: () => undefined,
        findPack: async () => {
          await pending;
          return { pack: null, runtime: { found: false } };
        },
      });
      const start = runner.start({
        pipeline: 'system.selftest',
        params: { seconds: 1 },
        project: root,
      });
      expect(gate.acquire()).toBeNull();
      finish();
      await start;
      const release = gate.acquire();
      expect(release).not.toBeNull();
      expect(
        await runner.start({ pipeline: 'system.selftest', params: { seconds: 1 }, project: root }),
      ).toMatchObject({ ok: false, error: 'An update restart is in progress.' });
      release?.();
    } finally {
      await store.flush();
      await rm(root, { recursive: true, force: true });
    }
  });
});
