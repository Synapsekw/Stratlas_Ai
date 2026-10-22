import type {
  HardwareCheck,
  IpcChannel,
  IpcEvent,
  IpcResponse,
  PackInstallProgress,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createAnalyticsPackStore } from './analyticsPackStore';
import type { Bridge, Res } from './bridge';

type Status = IpcResponse<'analyticsPack:status'>;

const OFFER_PATH = 'C:\\Users\\someone\\Downloads\\analytics-pack-0.23.0-win-x64.tar.gz';
const NONE: Status = {
  installed: null,
  offer: { path: OFFER_PATH, version: '0.23.0' },
  unusable: [],
};
const INSTALLED: Status = {
  installed: { version: '0.23.0', dir: 'D:\\data\\runtime\\analytics-pack-0.23.0' },
  offer: null,
  unusable: [],
};
const CARD: HardwareCheck = {
  ok: true,
  gpu: 'NVIDIA GeForce RTX 5070 Ti',
  gpuIndex: 0,
  totalMb: 16384,
  freeMb: 13517,
};

function fakeBridge(handlers: Partial<Record<IpcChannel, (req: unknown) => unknown>>) {
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: Bridge = {
    call: (channel, req) => {
      calls.push({ channel, req });
      const h = handlers[channel];
      return Promise.resolve(
        (h ? { ok: true, value: h(req) } : { ok: false, error: `no ${channel}` }) as Res<never>,
      );
    },
  };
  return { bridge, calls };
}

describe('the Analytics pack store', () => {
  it('load reads status and hardware', async () => {
    const { bridge } = fakeBridge({
      'analyticsPack:status': () => NONE,
      'analytics:hardware': () => CARD,
    });
    const s = createAnalyticsPackStore(bridge, undefined);
    await s.getState().load();
    expect(s.getState()).toMatchObject({
      status: NONE,
      offer: NONE.offer,
      hardware: CARD,
      checking: false,
      installing: false,
      error: null,
    });
  });

  it('checkHardware asks again and says when it is checking', async () => {
    let answer: HardwareCheck = { ok: false, code: 'tooBusy', reason: 'Only 2 GB is free.' };
    const seen: boolean[] = [];
    const { bridge } = fakeBridge({
      'analytics:hardware': () => {
        seen.push(s.getState().checking);
        return answer;
      },
    });
    const s = createAnalyticsPackStore(bridge, undefined);
    await s.getState().checkHardware();
    expect(s.getState().hardware).toEqual(answer);
    answer = CARD;
    await s.getState().checkHardware();
    expect(seen).toEqual([true, true]);
    expect(s.getState()).toMatchObject({ hardware: CARD, checking: false });
  });

  it('only the latest hardware check lands, and checking clears only for it', async () => {
    const pending: ((v: HardwareCheck) => void)[] = [];
    const bridge: Bridge = {
      call: () =>
        new Promise((resolve) => {
          pending.push((value) => {
            resolve({ ok: true, value } as Res<never>);
          });
        }),
    };
    const s = createAnalyticsPackStore(bridge, undefined);
    const first = s.getState().checkHardware();
    const second = s.getState().checkHardware();
    const busy: HardwareCheck = { ok: false, code: 'tooBusy', reason: 'busy' };
    pending[1]?.(CARD);
    await second;
    expect(s.getState()).toMatchObject({ hardware: CARD, checking: false });
    // the older answer comes in late: dropped
    pending[0]?.(busy);
    await first;
    expect(s.getState()).toMatchObject({ hardware: CARD, checking: false });

    const third = s.getState().checkHardware();
    const fourth = s.getState().checkHardware();
    pending[2]?.(busy);
    await third;
    // the latest has not answered yet: still checking
    expect(s.getState().checking).toBe(true);
    pending[3]?.(CARD);
    await fourth;
    expect(s.getState()).toMatchObject({ hardware: CARD, checking: false });
  });

  it('a failed hardware check says so and stops checking', async () => {
    const { bridge } = fakeBridge({});
    const s = createAnalyticsPackStore(bridge, undefined);
    await s.getState().checkHardware();
    expect(s.getState()).toMatchObject({
      hardware: null,
      hardwareError: 'no analytics:hardware',
      checking: false,
      error: null,
    });
  });

  it('progress events update progress', async () => {
    let installed = false;
    const listeners: ((p: PackInstallProgress) => void)[] = [];
    const seen: (PackInstallProgress | null)[] = [];
    const { bridge, calls } = fakeBridge({
      'analyticsPack:status': () => (installed ? INSTALLED : NONE),
      'analytics:hardware': () => CARD,
      'analyticsPack:install': () => {
        for (const l of listeners) l({ phase: 'unpack', bytesDone: 2, bytesTotal: 7, entries: 3 });
        seen.push(s.getState().progress);
        installed = true;
        return { ok: true, version: '0.23.0' };
      },
    });
    const s = createAnalyticsPackStore(bridge, (event, listener) => {
      if (event === 'analyticsPack:progress')
        listeners.push(listener as (p: IpcEvent<'analyticsPack:progress'>) => void);
      return () => undefined;
    });
    await s.getState().load();
    // a progress event with no install of this window running is not shown
    for (const l of listeners) l({ phase: 'check', bytesDone: 0, bytesTotal: 0, entries: 0 });
    expect(s.getState().progress).toBeNull();

    await s.getState().install(OFFER_PATH);
    expect(calls.find((c) => c.channel === 'analyticsPack:install')?.req).toEqual({
      path: OFFER_PATH,
    });
    expect(seen).toEqual([{ phase: 'unpack', bytesDone: 2, bytesTotal: 7, entries: 3 }]);
    expect(s.getState()).toMatchObject({
      status: INSTALLED,
      offer: null,
      installing: false,
      progress: null,
      error: null,
      note: { kind: 'installed', version: '0.23.0' },
    });
  });

  it('an exists answer asks to replace', async () => {
    const requests: unknown[] = [];
    const { bridge } = fakeBridge({
      'analyticsPack:status': () => INSTALLED,
      'analyticsPack:install': (req) => {
        requests.push(req);
        return (req as { replace?: boolean }).replace
          ? { ok: true, version: '0.23.0' }
          : { ok: false, code: 'exists', version: '0.23.0', error: 'already installed' };
      },
    });
    const s = createAnalyticsPackStore(bridge, undefined);
    await s.getState().install('D:\\pack.tar.gz');
    expect(s.getState()).toMatchObject({
      replace: { path: 'D:\\pack.tar.gz', version: '0.23.0' },
      error: null,
      note: null,
    });
    s.getState().keepInstalled();
    expect(s.getState().replace).toBeNull();
    expect(requests).toEqual([{ path: 'D:\\pack.tar.gz' }]);

    await s.getState().install('D:\\pack.tar.gz', true);
    expect(requests[1]).toEqual({ path: 'D:\\pack.tar.gz', replace: true });
    expect(s.getState().note).toEqual({ kind: 'installed', version: '0.23.0' });
  });

  it('shows why an install failed, and nothing after a cancel or an unsigned pack turned down', async () => {
    let answer: unknown = { ok: false, error: 'This Analytics pack is for another computer.' };
    const { bridge, calls } = fakeBridge({ 'analyticsPack:install': () => answer });
    const s = createAnalyticsPackStore(bridge, undefined);
    await s.getState().install('D:\\pack.tar.gz');
    expect(s.getState().error).toContain('another computer');
    // main answers a declined unsigned pack the way it answers a cancel
    answer = {
      ok: false,
      code: 'cancelled',
      error: 'Analytics pack 0.23.0 was not installed: it is not signed by the publisher.',
    };
    await s.getState().install('D:\\pack.tar.gz');
    expect(s.getState()).toMatchObject({ error: null, note: null, installing: false });
    s.getState().cancel();
    expect(calls.at(-1)?.channel).toBe('analyticsPack:cancel');
  });

  it('picks a file with the dialog and installs it; a closed dialog does nothing', async () => {
    let picked: string | null = null;
    const { bridge, calls } = fakeBridge({
      'analyticsPack:choose': () => ({ path: picked }),
      'analyticsPack:status': () => INSTALLED,
      'analyticsPack:install': () => ({ ok: true, version: '0.23.0' }),
    });
    const s = createAnalyticsPackStore(bridge, undefined);
    await s.getState().choose();
    expect(calls.map((c) => c.channel)).toEqual(['analyticsPack:choose']);
    picked = 'D:\\kit\\analytics-pack-0.23.0-win-x64.tar.gz';
    await s.getState().choose();
    expect(calls.find((c) => c.channel === 'analyticsPack:install')?.req).toEqual({ path: picked });
  });

  it('remove refreshes status', async () => {
    let removed = false;
    const { bridge, calls } = fakeBridge({
      'analyticsPack:status': () => (removed ? NONE : INSTALLED),
      'analyticsPack:remove': (req) => {
        if ((req as { version: string }).version !== '0.23.0')
          return { ok: false, error: 'There is no analytics-pack-0.1.0.' };
        removed = true;
        return { ok: true };
      },
    });
    const s = createAnalyticsPackStore(bridge, undefined);
    await s.getState().remove('0.1.0');
    expect(s.getState().error).toContain('There is no');
    expect(calls.some((c) => c.channel === 'analyticsPack:status')).toBe(false);

    await s.getState().remove('0.23.0');
    expect(s.getState()).toMatchObject({
      error: null,
      note: { kind: 'removed', version: '0.23.0' },
      status: NONE,
    });
  });
});
