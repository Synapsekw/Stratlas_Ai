import type {
  IpcChannel,
  IpcEvent,
  PackArchive,
  PackInstallProgress,
  PipelinePackStatus,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Bridge, Res } from './bridge';
import {
  createProcessingToolsStore,
  packNoticeKey,
  type NoticeStorage,
} from './processingToolsStore';

const status = (over: Partial<PipelinePackStatus> = {}): PipelinePackStatus => ({
  state: 'too-old',
  version: '0.2.0',
  dir: 'D:\\data\\runtime\\pipeline-pack-0.2.0',
  runtimeDir: 'D:\\data\\runtime',
  platform: 'win32-x64',
  needs: ['Creating maps from photos needs version 0.4.0 or later.'],
  others: [],
  installing: false,
  notify: true,
  ...over,
});
const UP_TO_DATE = status({
  state: 'ok',
  version: '0.5.0',
  dir: 'D:\\data\\runtime\\pipeline-pack-0.5.0',
  needs: [],
  others: [
    {
      name: 'pipeline-pack-0.2.0',
      version: '0.2.0',
      dir: 'D:\\data\\runtime\\pipeline-pack-0.2.0',
      bytes: 500,
      valid: true,
    },
  ],
});
const OFFER: PackArchive = {
  path: 'C:\\Users\\someone\\Downloads\\pipeline-pack-0.5.0-win-x64.tar.gz',
  version: '0.5.0',
  where: 'downloads',
  bytes: 400,
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

function memory(): NoticeStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe('packNoticeKey', () => {
  it('is the pack that is the problem, or nothing', () => {
    expect(packNoticeKey(null)).toBeNull();
    expect(packNoticeKey(status())).toBe('too-old:0.2.0');
    expect(packNoticeKey(status({ state: 'missing', version: undefined }))).toBe('missing');
    expect(packNoticeKey(status({ state: 'incompatible', version: undefined }))).toBe(
      'incompatible',
    );
    expect(packNoticeKey(UP_TO_DATE)).toBeNull();
    expect(packNoticeKey(status({ state: 'dev', version: 'dev' }))).toBeNull();
    // an automated run never shows the notice
    expect(packNoticeKey(status({ notify: false }))).toBeNull();
  });
});

describe('the processing tools store', () => {
  it('reads the status and the archive found on this computer', async () => {
    const { bridge } = fakeBridge({
      'pipelinePack:status': () => status(),
      'pipelinePack:find': () => ({ offer: OFFER, startDir: 'C:\\Users\\someone\\Downloads' }),
    });
    const s = createProcessingToolsStore(bridge, undefined);
    await s.getState().load();
    expect(s.getState()).toMatchObject({ status: status(), offer: OFFER, installing: false });
  });

  it('installs, then tells whoever shows the pack to read it again', async () => {
    let installed = false;
    let changed = 0;
    const listeners: ((p: PackInstallProgress) => void)[] = [];
    const seen: (PackInstallProgress | null)[] = [];
    const { bridge, calls } = fakeBridge({
      'pipelinePack:status': () => (installed ? UP_TO_DATE : status()),
      'pipelinePack:find': () => ({ offer: installed ? null : OFFER, startDir: null }),
      'pipelinePack:install': () => {
        // main reports progress while the request is open
        for (const l of listeners)
          l({ phase: 'unpack', bytesDone: 200, bytesTotal: 400, entries: 7 });
        seen.push(s.getState().progress);
        installed = true;
        return { ok: true, version: '0.5.0', status: UP_TO_DATE };
      },
    });
    const s = createProcessingToolsStore(
      bridge,
      (event, listener) => {
        if (event === 'pipelinePack:progress')
          listeners.push(listener as (p: IpcEvent<'pipelinePack:progress'>) => void);
        return () => undefined;
      },
      {
        onChanged: () => {
          changed += 1;
        },
      },
    );
    await s.getState().load();
    await s.getState().install(OFFER.path);
    expect(calls.find((c) => c.channel === 'pipelinePack:install')?.req).toEqual({
      path: OFFER.path,
    });
    expect(seen).toEqual([{ phase: 'unpack', bytesDone: 200, bytesTotal: 400, entries: 7 }]);
    expect(s.getState()).toMatchObject({
      status: UP_TO_DATE,
      offer: null,
      installing: false,
      progress: null,
      error: null,
      note: { kind: 'installed', version: '0.5.0' },
      revision: 1,
    });
    expect(changed).toBe(1);
  });

  it('asks before replacing an installed version, and replaces only on a yes', async () => {
    const requests: unknown[] = [];
    const { bridge } = fakeBridge({
      'pipelinePack:find': () => ({ offer: null, startDir: null }),
      'pipelinePack:install': (req) => {
        requests.push(req);
        return (req as { replace?: boolean }).replace
          ? { ok: true, version: '0.5.0', status: UP_TO_DATE }
          : { ok: false, code: 'exists', version: '0.5.0', error: 'already installed' };
      },
    });
    const s = createProcessingToolsStore(bridge, undefined);
    await s.getState().install('D:\\pack.tar.gz');
    expect(s.getState()).toMatchObject({
      replace: { path: 'D:\\pack.tar.gz', version: '0.5.0' },
      error: null,
      note: null,
    });
    s.getState().keepInstalled();
    expect(s.getState().replace).toBeNull();
    expect(requests).toEqual([{ path: 'D:\\pack.tar.gz' }]);

    await s.getState().install('D:\\pack.tar.gz', true);
    expect(requests[1]).toEqual({ path: 'D:\\pack.tar.gz', replace: true });
    expect(s.getState().note).toEqual({ kind: 'installed', version: '0.5.0' });
  });

  it('shows why an install failed, and nothing after a cancel', async () => {
    let answer: unknown = {
      ok: false,
      error: 'These processing tools are for an Intel Mac, and this computer is Windows (x64).',
    };
    const { bridge, calls } = fakeBridge({ 'pipelinePack:install': () => answer });
    const s = createProcessingToolsStore(bridge, undefined);
    await s.getState().install('D:\\pack.tar.gz');
    expect(s.getState().error).toContain('Intel Mac');
    answer = { ok: false, code: 'cancelled', error: 'cancelled' };
    await s.getState().install('D:\\pack.tar.gz');
    expect(s.getState()).toMatchObject({ error: null, note: null, installing: false });
    s.getState().cancel();
    expect(calls.at(-1)?.channel).toBe('pipelinePack:cancel');
  });

  it('picks a file with the dialog and installs it; a closed dialog does nothing', async () => {
    let picked: string | null = null;
    const { bridge, calls } = fakeBridge({
      'pipelinePack:choose': () => ({ path: picked }),
      'pipelinePack:find': () => ({ offer: null, startDir: null }),
      'pipelinePack:install': () => ({ ok: true, version: '0.5.0', status: UP_TO_DATE }),
    });
    const s = createProcessingToolsStore(bridge, undefined);
    await s.getState().choose();
    expect(calls.map((c) => c.channel)).toEqual(['pipelinePack:choose']);
    picked = 'D:\\kit\\pipeline-pack-0.5.0-win-x64.tar.gz';
    await s.getState().choose();
    expect(calls.find((c) => c.channel === 'pipelinePack:install')?.req).toEqual({ path: picked });
  });

  it('removes a pack that is not in use', async () => {
    let changed = 0;
    const { bridge } = fakeBridge({
      'pipelinePack:remove': (req) =>
        (req as { name: string }).name === 'pipeline-pack-0.2.0'
          ? { ok: true, status: { ...UP_TO_DATE, others: [] } }
          : { ok: false, error: 'This version is the one in use. Install a newer one first.' },
    });
    const s = createProcessingToolsStore(bridge, undefined, {
      onChanged: () => {
        changed += 1;
      },
    });
    await s.getState().remove('pipeline-pack-0.5.0');
    expect(s.getState().error).toContain('the one in use');
    expect(changed).toBe(0);
    await s.getState().remove('pipeline-pack-0.2.0');
    expect(s.getState()).toMatchObject({
      error: null,
      note: { kind: 'removed', name: 'pipeline-pack-0.2.0' },
    });
    expect(s.getState().status?.others).toEqual([]);
    expect(changed).toBe(1);
  });

  it('follows an install it found running to its end', async () => {
    let running = true;
    let changed = 0;
    const listeners: ((p: PackInstallProgress) => void)[] = [];
    const { bridge } = fakeBridge({
      'pipelinePack:status': () => (running ? status({ installing: true }) : UP_TO_DATE),
      'pipelinePack:find': () => ({ offer: null, startDir: null }),
    });
    const s = createProcessingToolsStore(
      bridge,
      (event, listener) => {
        if (event === 'pipelinePack:progress')
          listeners.push(listener as (p: IpcEvent<'pipelinePack:progress'>) => void);
        return () => undefined;
      },
      {
        onChanged: () => {
          changed += 1;
        },
      },
    );
    await s.getState().load();
    expect(s.getState().installing).toBe(true);
    const emit = (p: PackInstallProgress) => {
      for (const l of listeners) l(p);
    };
    emit({ phase: 'unpack', bytesDone: 1, bytesTotal: 4, entries: 2 });
    expect(s.getState().progress).toMatchObject({ phase: 'unpack', entries: 2 });
    running = false;
    emit({ phase: 'done', bytesDone: 4, bytesTotal: 4, entries: 9 });
    expect(s.getState()).toMatchObject({ installing: false, progress: null });
    expect(changed).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getState().status).toEqual(UP_TO_DATE);
  });

  it('remembers a dismissed notice for that pack only', async () => {
    const storage = memory();
    let current = status();
    const { bridge } = fakeBridge({
      'pipelinePack:status': () => current,
      'pipelinePack:find': () => ({ offer: null, startDir: null }),
    });
    const s = createProcessingToolsStore(bridge, undefined, { storage });
    await s.getState().load();
    expect(s.getState().dismissed).toBeNull();
    s.getState().dismissNotice();
    expect(s.getState().dismissed).toBe('too-old:0.2.0');
    expect(packNoticeKey(s.getState().status)).toBe(s.getState().dismissed);

    // the next start: still dismissed for 0.2.0
    const next = createProcessingToolsStore(bridge, undefined, { storage });
    expect(next.getState().dismissed).toBe('too-old:0.2.0');
    // another pack that is too old is a new notice
    current = status({ version: '0.3.0' });
    await next.getState().load();
    expect(packNoticeKey(next.getState().status)).not.toBe(next.getState().dismissed);

    // storage that refuses: dismissed for this run
    const blocked: NoticeStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const b = createProcessingToolsStore(bridge, undefined, { storage: blocked });
    await b.getState().load();
    b.getState().dismissNotice();
    expect(b.getState().dismissed).toBe('too-old:0.3.0');
  });
});
