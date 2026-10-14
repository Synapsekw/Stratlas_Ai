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

  it('shows why an answer was refused, and stays quiet about a cancel', async () => {
    let code: string | undefined = 'disk';
    const { bridge } = fakeBridge({
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
