import {
  emptyRemovalPlan,
  type IpcChannel,
  type ProjectManifest,
  type RemovalPlan,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Bridge } from '../bridge';
import { createRemovalStore, type RemovalPorts } from './removalModel';

const PLAN: RemovalPlan = {
  ...emptyRemovalPlan(),
  layers: [{ id: 'clip-1', name: 'Clip 1', kind: 'video', why: 'asked' }],
  files: ['video/clip-1.mp4'],
  bytes: 10,
};
const MANIFEST = { layers: [] } as unknown as ProjectManifest;
/** An answer that makes `bridge.call` reject (the channel to main failed). */
const THROWS = Symbol('throws');
/** Start over's old run as the wizard showed it: the run and its map layer. */
const RUN_PLAN: RemovalPlan = {
  ...emptyRemovalPlan(),
  runs: [{ id: 'r3', status: 'failed', why: 'asked' }],
  layers: [{ id: 'r3-ortho', name: 'Ortho', kind: 'raster', why: { madeBy: 'r3' } }],
  files: ['photogrammetry/r3'],
  bytes: 10,
};

function ports(
  answers: Partial<Record<IpcChannel, unknown>>,
  log: string[],
  project: { id: string | null } = { id: 'p' },
): RemovalPorts {
  const bridge: Bridge = {
    call: (channel, req) => {
      log.push(`call ${channel} ${JSON.stringify(req)}`);
      const value = answers[channel];
      if (value === THROWS) return Promise.reject(new Error('channel closed'));
      return Promise.resolve(
        value instanceof Error
          ? { ok: false, error: value.message }
          : { ok: true, value: value as never },
      );
    },
  };
  return {
    bridge,
    projectId: () => project.id,
    release: (ids) => {
      log.push(`release ${ids.join(',')}`);
      return Promise.resolve(() => {
        log.push(`put back ${ids.join(',')}`);
      });
    },
    applyManifest: () => {
      log.push('manifest');
    },
    refresh: () => {
      log.push('refresh');
    },
  };
}

describe('removal store', () => {
  it('asks main for the plan when the dialog opens', async () => {
    const log: string[] = [];
    const s = createRemovalStore(ports({ 'builder:removePlan': { ok: true, plan: PLAN } }, log));
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(s.getState().targets).toEqual([{ layer: 'clip-1' }]);
    expect(s.getState().plan).toEqual(PLAN);
  });

  it('hides, deselects and releases the layers before it asks main', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: PLAN },
          'builder:remove': { ok: true, manifest: MANIFEST, plan: PLAN },
          'builder:trash': { bytes: 10, entries: 1 },
        },
        log,
      ),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(true);
    const at = (prefix: string) => log.findIndex((l) => l.startsWith(prefix));
    expect(at('release clip-1')).toBeGreaterThan(-1);
    expect(at('release clip-1')).toBeLessThan(at('call builder:remove {'));
    expect(at('manifest')).toBeGreaterThan(at('call builder:remove {'));
    expect(log).not.toContain('put back clip-1');
    expect(s.getState().targets).toBeNull();
    expect(s.getState().removed).toBe(1);
  });

  it('keeps the dialog open with the reason when main refuses, and puts the layers back', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: PLAN },
          'builder:remove': { ok: false, error: 'held open' },
        },
        log,
      ),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(false);
    expect(s.getState().error).toBe('held open');
    expect(s.getState().targets).toEqual([{ layer: 'clip-1' }]);
    expect(log).not.toContain('manifest');
    expect(log).toContain('put back clip-1');
  });

  it('puts the layers back when the call itself fails', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: PLAN },
          'builder:remove': new Error('ipc down'),
        },
        log,
      ),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(false);
    expect(s.getState().error).toBe('ipc down');
    expect(log).toContain('put back clip-1');
  });

  it('removeNow without a dialog answers why not and puts the layers back', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports({ 'builder:remove': { ok: false, error: 'busy run' } }, log),
    );
    expect(await s.getState().removeNow([{ layer: 'clip-1' }])).toBe('busy run');
    expect(log).toContain('put back clip-1');
  });

  it('a refused plan never calls builder:remove', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports({ 'builder:removePlan': { ok: true, plan: { ...PLAN, refused: 'busy' } } }, log),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(false);
    expect(log.some((l) => l.startsWith('call builder:remove {'))).toBe(false);
  });

  it('empties the trash and keeps the held count', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:emptyTrash': { ok: true, freed: 10, held: 1 },
          'builder:trash': { bytes: 5, entries: 1 },
        },
        log,
      ),
    );
    expect(await s.getState().emptyTrash()).toBeNull();
    expect(s.getState().held).toBe(1);
    expect(s.getState().trash).toEqual({ bytes: 5, entries: 1 });
  });

  it('does not remove when the project changed between ask and confirm', async () => {
    const log: string[] = [];
    const project = { id: 'p' as string | null };
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: PLAN },
          'builder:remove': { ok: true, manifest: MANIFEST, plan: PLAN },
        },
        log,
        project,
      ),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    project.id = 'q';
    expect(await s.getState().confirm()).toBe(false);
    expect(s.getState().error).toBe('The project changed.');
    expect(log.some((l) => l.startsWith('call builder:remove {'))).toBe(false);
    expect(log).not.toContain('manifest');
  });

  it('applies nothing when the project changed while main was removing', async () => {
    const log: string[] = [];
    const project = { id: 'p' as string | null };
    const p = ports(
      {
        'builder:removePlan': { ok: true, plan: PLAN },
        'builder:remove': { ok: true, manifest: MANIFEST, plan: PLAN },
        'builder:trash': { bytes: 1, entries: 1 },
      },
      log,
      project,
    );
    const inner = p.bridge;
    p.bridge = {
      call: (channel, req) => {
        if (channel === 'builder:remove') project.id = 'q';
        return inner.call(channel, req);
      },
    };
    const s = createRemovalStore(p);
    await s.getState().ask([{ layer: 'clip-1' }]);
    await s.getState().confirm();
    expect(log).not.toContain('manifest');
    expect(log).not.toContain('refresh');
    expect(s.getState().busy).toBe(false);
  });

  it('keeps the open project trash when another project trash is read', async () => {
    const log: string[] = [];
    const s = createRemovalStore(ports({ 'builder:trash': { bytes: 5, entries: 1 } }, log));
    await s.getState().loadTrash('other');
    expect(s.getState().trash).toBeNull();
    await s.getState().loadTrash('p');
    expect(s.getState().trash).toEqual({ bytes: 5, entries: 1 });
    expect(await s.getState().readTrash('other')).toEqual({ bytes: 5, entries: 1 });
    expect(s.getState().trash).toEqual({ bytes: 5, entries: 1 });
  });

  it('drops a trash reply that arrives after the project switched', async () => {
    const log: string[] = [];
    const project = { id: 'p' as string | null };
    const p = ports({ 'builder:trash': { bytes: 5, entries: 1 } }, log, project);
    const inner = p.bridge;
    p.bridge = {
      call: async (channel, req) => {
        const r = await inner.call(channel, req);
        project.id = 'q';
        return r;
      },
    };
    const s = createRemovalStore(p);
    await s.getState().loadTrash();
    expect(s.getState().trash).toBeNull();
  });

  it('two confirms make one builder:remove', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: PLAN },
          'builder:remove': { ok: true, manifest: MANIFEST, plan: PLAN },
          'builder:trash': { bytes: 1, entries: 1 },
        },
        log,
      ),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    const [a, b] = await Promise.all([s.getState().confirm(), s.getState().confirm()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(log.filter((l) => l.startsWith('call builder:remove {'))).toHaveLength(1);
  });

  it('removeNow is busy while it runs, and a second one waits its turn', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports({ 'builder:remove': { ok: true, manifest: MANIFEST, plan: PLAN } }, log),
    );
    const first = s.getState().removeNow([{ layer: 'clip-1' }]);
    expect(s.getState().busy).toBe(true);
    expect(await s.getState().removeNow([{ layer: 'clip-1' }])).not.toBeNull();
    expect(await first).toBeNull();
    expect(s.getState().busy).toBe(false);
    expect(log.filter((l) => l.startsWith('call builder:remove {'))).toHaveLength(1);
  });

  it('clears busy when a port throws, and ask is ignored while busy', async () => {
    const log: string[] = [];
    const p = ports(
      {
        'builder:removePlan': { ok: true, plan: PLAN },
        'builder:remove': { ok: true, manifest: MANIFEST, plan: PLAN },
      },
      log,
    );
    p.applyManifest = () => {
      throw new Error('boom');
    };
    const s = createRemovalStore(p);
    await s.getState().ask([{ layer: 'clip-1' }]);
    const done = s.getState().confirm();
    await s.getState().ask([{ layer: 'other' }]);
    expect(s.getState().targets).toEqual([{ layer: 'clip-1' }]);
    expect(await done).toBe(false);
    expect(s.getState().busy).toBe(false);
    expect(s.getState().error).toBe('boom');
  });
  it('puts the layers back when builder:remove throws', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports({ 'builder:removePlan': { ok: true, plan: PLAN }, 'builder:remove': THROWS }, log),
    );
    await s.getState().ask([{ layer: 'clip-1' }]);
    expect(await s.getState().confirm()).toBe(false);
    expect(s.getState().error).toBe('channel closed');
    expect(log).toContain('put back clip-1');
  });

  it('removeNow with the plan that was shown releases its layers before main moves them', async () => {
    const log: string[] = [];
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: RUN_PLAN },
          'builder:remove': { ok: true, manifest: MANIFEST, plan: RUN_PLAN },
          'builder:trash': { bytes: 10, entries: 1 },
        },
        log,
      ),
    );
    expect(await s.getState().removeNow([{ run: 'r3' }], RUN_PLAN)).toBeNull();
    const at = (prefix: string) => log.findIndex((l) => l.startsWith(prefix));
    expect(at('release r3-ortho')).toBeGreaterThan(-1);
    expect(at('release r3-ortho')).toBeLessThan(at('call builder:remove {'));
  });

  it('removeNow with a shown plan removes nothing when more would go now', async () => {
    const log: string[] = [];
    const more: RemovalPlan = {
      ...RUN_PLAN,
      changes: [{ id: 'chg-1', name: '12 Oct to 26 Oct', why: { usedBy: 'r3-ortho' } }],
    };
    const s = createRemovalStore(
      ports(
        {
          'builder:removePlan': { ok: true, plan: more },
          'builder:remove': { ok: true, manifest: MANIFEST, plan: more },
        },
        log,
      ),
    );
    expect(await s.getState().removeNow([{ run: 'r3' }], RUN_PLAN)).toBe(
      'More would go with it now than was shown. Delete it from the Processing drawer.',
    );
    expect(log.some((l) => l.startsWith('call builder:remove {'))).toBe(false);
    expect(log.some((l) => l.startsWith('release'))).toBe(false);
    expect(s.getState().busy).toBe(false);
  });

  it('removeNow with a refused shown plan answers its reason and asks nothing', async () => {
    const log: string[] = [];
    const s = createRemovalStore(ports({}, log));
    expect(await s.getState().removeNow([{ run: 'r3' }], { ...RUN_PLAN, refused: 'busy' })).toBe(
      'busy',
    );
    expect(log).toEqual([]);
  });
});
