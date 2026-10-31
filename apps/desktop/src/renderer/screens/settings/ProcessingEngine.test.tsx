// @vitest-environment jsdom
import type { OdmInstallProgress, OdmStatus } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { channel: string; req: unknown }[],
  answers: new Map<string, (req: unknown) => unknown>(),
  resume: null as 'create-maps' | null,
  focus: null as string | null,
  clearSettingsFocus: undefined as unknown as () => void,
  resumeAfterTools: undefined as unknown as () => void,
  autoPrepare: undefined as boolean | undefined,
  updateSettings: undefined as unknown as (patch: object) => Promise<string | null>,
}));
h.updateSettings = vi.fn(() => Promise.resolve(null));
h.clearSettingsFocus = vi.fn(() => {
  h.focus = null;
});
h.resumeAfterTools = vi.fn();

vi.mock('../../odm', async () => {
  const { createOdmStore } = await import('../../odmStore');
  const { useStore } = await import('zustand');
  const bridge = {
    call: (channel: string, req: unknown) => {
      h.calls.push({ channel, req });
      const a = h.answers.get(channel);
      return a
        ? Promise.resolve(a(req)).then((value) => ({ ok: true, value }))
        : Promise.resolve({ ok: false, error: `no ${channel}` });
    },
  };
  const odm = createOdmStore(bridge as never, undefined);
  return { odm, useOdm: (sel: (s: never) => unknown) => useStore(odm, sel as never) };
});
vi.mock('../../processingTools', () => ({
  useProcessingTools: (sel: (s: object) => unknown) => sel({ resume: h.resume }),
  resumeAfterTools: () => {
    h.resumeAfterTools();
  },
}));
vi.mock('../../shell', () => ({
  shell: {
    getState: () => ({
      clearSettingsFocus: h.clearSettingsFocus,
      updateSettings: h.updateSettings,
    }),
  },
  useShell: (sel: (s: object) => unknown) =>
    sel({
      settings: {
        dataRoot: 'D:\\data',
        ...(h.autoPrepare === undefined ? {} : { autoPrepareSurfaces: h.autoPrepare }),
      },
      settingsFocus: h.focus,
    }),
}));

import { odm } from '../../odm';
import { ProcessingEngine } from './ProcessingEngine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = (over: Partial<OdmStatus> = {}): OdmStatus => ({
  state: 'not-installed',
  pinned: { version: '3.6.2', downloadBytes: 244_864_104, installedBytes: 1_100_000_000 },
  other: null,
  gpu: { setting: 'auto', nvidia: 'NVIDIA GeForce RTX 5070 Ti', cuda: true },
  dev: false,
  mayAskAdmin: false,
  installing: false,
  ...over,
});
const INSTALLED = status({ state: 'installed', version: '3.6.2', dir: 'E:\\Q\\odm-3.6.2' });

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  h.calls.length = 0;
  h.answers.clear();
  h.resume = null;
  h.focus = null;
  h.autoPrepare = undefined;
  vi.mocked(h.updateSettings).mockClear();
  odm.setState({
    status: null,
    progress: null,
    installing: false,
    error: null,
    askReplace: false,
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  act(() => {
    q(id)?.click();
  });
};
async function mount(s: OdmStatus) {
  h.answers.set('odm:status', () => s);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ProcessingEngine />);
    await Promise.resolve();
  });
}
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('the Processing engine card', () => {
  it('shows the state of each kind of install', async () => {
    const cases: [OdmStatus, string][] = [
      [status(), 'not-installed'],
      [INSTALLED, 'installed'],
      [status({ state: 'update-available', version: '3.5.6', dir: 'E:\\Q' }), 'update-available'],
      [status({ state: 'broken', problem: 'run.bat is missing.' }), 'broken'],
      [status({ state: 'unsupported', problem: 'ODM needs 64-bit Windows.' }), 'unsupported'],
    ];
    for (const [s, state] of cases) {
      odm.setState({ status: null });
      await mount(s);
      expect(q('engine-state')?.getAttribute('data-state')).toBe(state);
      act(() => root?.unmount());
      root = undefined;
    }
  });

  it('a start check that ran out of time: says why, and Try again asks main to install', async () => {
    const problem = 'ODM is installed, but its start check has not passed yet.';
    await mount(
      status({ state: 'unverified', version: '3.6.2', dir: 'E:\\Q\\odm-3.6.2', problem }),
    );
    expect(q('engine-state')?.textContent).toBe('Needs a start check');
    expect(q('engine-detail')?.textContent).toBe(problem);
    expect(q('engine-remove')).not.toBeNull();
    expect(q('engine-retry')?.textContent).toBe('Try again');
    h.answers.set('odm:install', () => ({ ok: true, status: INSTALLED }));
    click('engine-retry');
    await settle();
    expect(h.calls.filter((c) => c.channel === 'odm:install')).toEqual([
      { channel: 'odm:install', req: {} },
    ]);
  });

  it('offers the install with the sizes, and none for an unsupported computer', async () => {
    await mount(status());
    expect(q('engine-about')?.textContent).toContain('AGPL-3.0');
    expect(q('engine-detail')?.textContent).toBe('Download 234 MB, about 1.0 GB installed.');
    expect(q('engine-install')).not.toBeNull();
    expect(q('engine-gpu')?.hasAttribute('disabled')).toBe(true);
    act(() => root?.unmount());
    root = undefined;
    odm.setState({ status: null });
    await mount(status({ state: 'unsupported', problem: 'ODM needs 64-bit Windows.' }));
    expect(host.textContent).not.toContain('234 MB');
    expect(q('engine-detail')?.textContent).toBe('ODM needs 64-bit Windows.');
    expect(q('engine-install')).toBeNull();
  });

  it('installed: version, folder, the card switch and a remove that asks first', async () => {
    await mount(INSTALLED);
    expect(q('engine-version')?.textContent).toBe('ODM 3.6.2, in E:\\Q\\odm-3.6.2');
    const sw = q('engine-gpu');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    h.answers.set('odm:setGpu', () => ({
      ok: true,
      status: { ...INSTALLED, gpu: { ...INSTALLED.gpu, setting: 'off' } },
    }));
    click('engine-gpu');
    click('engine-gpu');
    await settle();
    expect(h.calls.filter((c) => c.channel === 'odm:setGpu')).toHaveLength(1);
    expect(q('engine-gpu')?.getAttribute('aria-checked')).toBe('false');

    click('engine-remove');
    expect(h.calls.some((c) => c.channel === 'odm:remove')).toBe(false);
    expect(document.activeElement).toBe(q('engine-remove-confirm'));
    click('engine-remove-keep');
    expect(document.activeElement).toBe(q('engine-remove'));

    h.answers.set('odm:remove', () => ({ ok: true, status: status() }));
    click('engine-remove');
    click('engine-remove-confirm');
    await settle();
    expect(q('engine-state')?.getAttribute('data-state')).toBe('not-installed');
    expect(document.activeElement).toBe(q('engine-install'));
  });

  it('keeps focus on the bar while it installs, and announces phases only', async () => {
    await mount(status());
    const live = host.querySelector('[role="status"]');
    expect(live?.textContent).toBe('');
    let finish: (v: unknown) => void = () => undefined;
    h.answers.set(
      'odm:install',
      () =>
        new Promise((res) => {
          finish = res;
        }),
    );
    click('engine-install');
    await settle();
    expect(document.activeElement).toBe(q('engine-cancel'));
    const send = (p: OdmInstallProgress) => {
      act(() => {
        odm.setState({ progress: p });
      });
    };
    send({ phase: 'download', bytesDone: 1_000_000, bytesTotal: 244_864_104 });
    expect(live?.textContent).toBe('Downloading');
    send({ phase: 'download', bytesDone: 2_000_000, bytesTotal: 244_864_104 });
    expect(live?.textContent).toBe('Downloading');
    expect(q('engine-progress')?.textContent).toContain('Downloading 1.9 MB of 234 MB');
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-label')).toBe('Downloading');
    send({ phase: 'verify', bytesDone: 0, bytesTotal: 0 });
    expect(live?.textContent).toBe('Checking the download');
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe(
      'Checking the download',
    );
    send({ phase: 'install', bytesDone: 0, bytesTotal: 0 });
    expect(live?.textContent).toBe('Installing');
    send({ phase: 'check', bytesDone: 0, bytesTotal: 0 });
    expect(live?.textContent).toBe('Starting ODM for the first time; this can take a few minutes');
    await act(async () => {
      finish({ ok: true, status: INSTALLED });
      await Promise.resolve();
    });
    expect(live?.textContent).toBe('Installed');
    expect(document.activeElement).toBe(q('engine-remove'));
  });

  it('announces a failure', async () => {
    await mount(status());
    h.answers.set('odm:install', () => ({ ok: false, error: 'Not enough space.', code: 'disk' }));
    click('engine-install');
    await settle();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Not enough space.');
    expect(q('engine-error')?.textContent).toBe('Not enough space.');
  });

  it('asks before it replaces another ODM, and takes the focus for the question', async () => {
    await mount(status({ other: { dir: 'C:\\ODM' } }));
    h.answers.set('odm:install', (req) =>
      (req as { replaceOther?: boolean }).replaceOther === true
        ? { ok: true, status: INSTALLED }
        : { ok: false, error: 'Another ODM is installed.', code: 'other-install' },
    );
    click('engine-install');
    await settle();
    expect(q('engine-replace')?.getAttribute('role')).toBe('alert');
    expect(q('engine-replace')?.textContent).toContain('Another ODM is installed in C:\\ODM.');
    expect(q('engine-replace-no')?.textContent).toBe('Keep it');
    expect(document.activeElement).toBe(q('engine-replace-yes'));
    click('engine-replace-no');
    expect(q('engine-replace')).toBeNull();
    expect(document.activeElement).toBe(q('engine-install'));
    click('engine-install');
    await settle();
    click('engine-replace-yes');
    await settle();
    expect(h.calls.filter((c) => c.channel === 'odm:install').map((c) => c.req)).toEqual([
      {},
      {},
      { replaceOther: true },
    ]);
    expect(q('engine-state')?.getAttribute('data-state')).toBe('installed');
  });

  it('offers the way back to Create maps once installed', async () => {
    h.resume = 'create-maps';
    await mount(INSTALLED);
    click('engine-back');
    expect(h.resumeAfterTools).toHaveBeenCalled();
  });

  it('takes the focus when Settings was opened for it', async () => {
    h.focus = 'processing-engine';
    host.scrollIntoView = () => undefined;
    Element.prototype.scrollIntoView = () => undefined;
    await mount(status());
    expect(document.activeElement).toBe(q('engine-install'));
    expect(h.clearSettingsFocus).toHaveBeenCalled();
  });

  it('the auto-prepare switch is on by default and writes autoPrepareSurfaces: false', async () => {
    await mount(INSTALLED);
    const sw = q('auto-prepare');
    expect(sw?.getAttribute('role')).toBe('switch');
    expect(sw?.getAttribute('aria-checked')).toBe('true');
    expect(q('auto-prepare-row')?.textContent).toContain(
      'Prepare survey surfaces when a project opens',
    );
    expect(q('auto-prepare-row')?.textContent).toContain(
      'Runs in the background and shows in Jobs. You can cancel it.',
    );
    click('auto-prepare');
    expect(h.updateSettings).toHaveBeenCalledWith({ autoPrepareSurfaces: false });
  });

  it('every switch row keeps its title and description apart, inside the engine card', async () => {
    await mount(INSTALLED);
    const card = q('engine');
    for (const row of ['auto-prepare-row', 'auto-check-row', 'engine-hardware-row']) {
      const el = q(row);
      expect(el, row).not.toBeNull();
      expect(card?.contains(el ?? null), row).toBe(true);
      // two lines, each its own element, and a space between them in the text
      const lines = el?.querySelector('.pe-gpu-t')?.children;
      expect(lines?.length, row).toBe(2);
      const [title, text] = [lines?.[0]?.textContent ?? '', lines?.[1]?.textContent ?? ''];
      expect(el?.textContent, row).toContain(`${title} ${text}`);
    }
  });

  it('the auto-prepare switch shows off when the setting is off, and turns it on', async () => {
    h.autoPrepare = false;
    await mount(INSTALLED);
    expect(q('auto-prepare')?.getAttribute('aria-checked')).toBe('false');
    click('auto-prepare');
    expect(h.updateSettings).toHaveBeenCalledWith({ autoPrepareSurfaces: true });
  });
});
