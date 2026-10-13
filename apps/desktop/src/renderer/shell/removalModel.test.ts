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

function ports(answers: Partial<Record<IpcChannel, unknown>>, log: string[]): RemovalPorts {
  const bridge: Bridge = {
    call: (channel, req) => {
      log.push(`call ${channel} ${JSON.stringify(req)}`);
      const value = answers[channel];
      return Promise.resolve(
        value instanceof Error
          ? { ok: false, error: value.message }
          : { ok: true, value: value as never },
      );
    },
  };
  return {
    bridge,
    projectId: () => 'p',
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
});
