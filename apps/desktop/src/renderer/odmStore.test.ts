import type { IpcChannel, OdmInstallProgress, OdmStatus } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Bridge, Res } from './bridge';
import { createOdmStore } from './odmStore';

const status = (over: Partial<OdmStatus> = {}): OdmStatus => ({
  state: 'not-installed',
  pinned: { version: '3.6.2', downloadBytes: 244_864_104, installedBytes: 1_100_000_000 },
  other: null,
  gpu: { setting: 'auto', nvidia: 'NVIDIA GeForce RTX 5070 Ti', cuda: true },
  dev: false,
  mayAskAdmin: true,
  installing: false,
  ...over,
});
const INSTALLED = status({ state: 'installed', version: '3.6.2', dir: 'E:\\Q\\odm-3.6.2' });

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

describe('the ODM store', () => {
  it('reads the status', async () => {
    const { bridge } = fakeBridge({ 'odm:status': () => status() });
    const s = createOdmStore(bridge, undefined);
    await s.getState().load();
    expect(s.getState()).toMatchObject({ status: status(), installing: false });
  });

  it('installs, following progress only while it runs', async () => {
    const listeners: ((p: OdmInstallProgress) => void)[] = [];
    const seen: (OdmInstallProgress | null)[] = [];
    const p: OdmInstallProgress = { phase: 'download', bytesDone: 5, bytesTotal: 10 };
    const held: { s?: ReturnType<typeof createOdmStore> } = {};
    const { bridge, calls } = fakeBridge({
      'odm:status': () => status(),
      'odm:install': () => {
        listeners.forEach((l) => {
          l(p);
        });
        seen.push(held.s?.getState().progress ?? null);
        return { ok: true, status: INSTALLED };
      },
    });
    const s = createOdmStore(bridge, ((ch: string, l: (p: OdmInstallProgress) => void) => {
      if (ch === 'odm:progress') listeners.push(l);
      return () => undefined;
    }) as never);
    held.s = s;
    await s.getState().load();
    listeners.forEach((l) => {
      l(p);
    });
    expect(s.getState().progress).toBeNull();
    await s.getState().install();
    expect(calls.find((c) => c.channel === 'odm:install')?.req).toEqual({});
    expect(seen).toEqual([p]);
    expect(s.getState()).toMatchObject({ status: INSTALLED, installing: false, progress: null });
  });

  it('asks before it replaces another ODM, then sends replaceOther', async () => {
    const { bridge, calls } = fakeBridge({
      'odm:install': (req) =>
        (req as { replaceOther?: boolean }).replaceOther === true
          ? { ok: true, status: INSTALLED }
          : { ok: false, error: 'Another ODM is installed.', code: 'other-install' },
    });
    const s = createOdmStore(bridge, undefined);
    await s.getState().install();
    expect(s.getState()).toMatchObject({ askReplace: true, installing: false, error: null });
    await s.getState().install(true);
    expect(calls.map((c) => c.req)).toEqual([{}, { replaceOther: true }]);
    expect(s.getState()).toMatchObject({ askReplace: false, status: INSTALLED });
    await s.getState().install();
    s.getState().keep();
    expect(s.getState().askReplace).toBe(false);
  });

  it('cancels, removes and switches the card', async () => {
    const { bridge, calls } = fakeBridge({
      'odm:cancel': () => ({ ok: true }),
      'odm:remove': () => ({ ok: true, status: status() }),
      'odm:setGpu': () => ({ ok: true, status: INSTALLED }),
    });
    const s = createOdmStore(bridge, undefined);
    await s.getState().cancel();
    await s.getState().setGpu(false);
    await s.getState().remove();
    expect(calls).toEqual([
      { channel: 'odm:cancel', req: {} },
      { channel: 'odm:setGpu', req: { gpu: 'off' } },
      { channel: 'odm:remove', req: {} },
    ]);
    expect(s.getState().status).toEqual(status());
  });

  it('subscribes to progress once, and again after dispose', async () => {
    let subscribed = 0;
    let disposed = 0;
    const on = ((ch: string) => {
      if (ch === 'odm:progress') subscribed += 1;
      return () => {
        disposed += 1;
      };
    }) as never;
    const { bridge } = fakeBridge({ 'odm:status': () => status() });
    const s = createOdmStore(bridge, on);
    await s.getState().load();
    await s.getState().load();
    expect(subscribed).toBe(1);
    s.getState().dispose();
    expect(disposed).toBe(1);
    s.getState().dispose();
    expect(disposed).toBe(1);
    await s.getState().load();
    expect(subscribed).toBe(2);
  });

  it('ignores progress that arrives after the install ended', async () => {
    const listeners: ((p: OdmInstallProgress) => void)[] = [];
    const { bridge } = fakeBridge({
      'odm:status': () => status(),
      'odm:install': () => ({ ok: true, status: INSTALLED }),
    });
    const s = createOdmStore(bridge, ((ch: string, l: (p: OdmInstallProgress) => void) => {
      if (ch === 'odm:progress') listeners.push(l);
      return () => undefined;
    }) as never);
    await s.getState().load();
    await s.getState().install();
    listeners.forEach((l) => {
      l({ phase: 'download', bytesDone: 1, bytesTotal: 2 });
    });
    expect(s.getState().progress).toBeNull();
  });

  it('shows why remove and the card switch failed', async () => {
    const { bridge } = fakeBridge({
      'odm:remove': () => ({ ok: false, error: 'ODM is in use.', code: 'busy' }),
    });
    const s = createOdmStore(bridge, undefined);
    await s.getState().remove();
    expect(s.getState().error).toBe('ODM is in use.');
    await s.getState().setGpu(true);
    expect(s.getState().error).toBe('no odm:setGpu');
    const { bridge: b2 } = fakeBridge({
      'odm:setGpu': () => ({ ok: false, error: 'Settings could not be saved.' }),
    });
    const s2 = createOdmStore(b2, undefined);
    await s2.getState().setGpu(false);
    expect(s2.getState().error).toBe('Settings could not be saved.');
  });

  it.each([
    ['unsupported', 'ODM installs on Windows x64 only.'],
    ['dev', 'ODM comes from QUADRION_ODM_DIR here; install and remove are off.'],
    ['offline-only', 'This computer is set to offline only.'],
    ['disk', 'Not enough free space on E:\\: about 1.3 GB needed.'],
    ['busy', 'ODM is already being installed.'],
    ['failed', 'The download failed.'],
  ] as const)(
    'a refusal with code %s shows its message, leaves the card usable and reads the status again',
    async (code, error) => {
      const { bridge, calls } = fakeBridge({
        'odm:status': () =>
          status({ state: code === 'unsupported' ? 'unsupported' : 'not-installed' }),
        'odm:install': () => ({ ok: false, error, code }),
      });
      const s = createOdmStore(bridge, undefined);
      await s.getState().install();
      expect(s.getState()).toMatchObject({
        error,
        installing: false,
        askReplace: false,
        progress: null,
      });
      expect(s.getState().status).not.toBeNull();
      expect(calls.filter((c) => c.channel === 'odm:status')).toHaveLength(1);
      // a second try is allowed
      await s.getState().install();
      expect(calls.filter((c) => c.channel === 'odm:install')).toHaveLength(2);
    },
  );

  it('a cancel is silent and puts the card back', async () => {
    const { bridge, calls } = fakeBridge({
      'odm:status': () => status(),
      'odm:install': () => ({ ok: false, error: 'The download was cancelled.', code: 'cancelled' }),
    });
    const s = createOdmStore(bridge, undefined);
    await s.getState().install();
    expect(s.getState()).toMatchObject({ error: null, installing: false, progress: null });
    expect(calls.filter((c) => c.channel === 'odm:status')).toHaveLength(1);
  });

  it('shows why an answer was refused, and stays quiet about a cancel', async () => {
    let code: string | undefined = 'disk';
    const { bridge } = fakeBridge({
      'odm:status': () => status(),
      'odm:install': () => ({ ok: false, error: 'Not enough space.', code }),
    });
    const s = createOdmStore(bridge, undefined);
    await s.getState().install();
    expect(s.getState().error).toBe('Not enough space.');
    code = 'cancelled';
    await s.getState().install();
    expect(s.getState().error).toBeNull();
  });
});
