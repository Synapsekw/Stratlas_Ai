// @vitest-environment jsdom
import type { HardwareCheck, IpcResponse } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  answers: new Map<string, (req: unknown) => unknown>(),
  calls: [] as { channel: string; req: unknown }[],
}));

vi.mock('../../shell', () => ({
  bridge: {
    call: (channel: string, req: unknown) => {
      h.calls.push({ channel, req });
      const a = h.answers.get(channel);
      if (!a) return Promise.resolve({ ok: false, error: `no ${channel}` });
      // an answer may be a promise: an install that is still running
      return Promise.resolve(a(req)).then((value) => ({ ok: true, value }));
    },
  },
  useShell: (sel: (s: object) => unknown) => sel({ settings: { dataRoot: 'D:\\data' } }),
}));

import { analyticsPack } from '../../analyticsPack';
import { AnalyticsPack } from './AnalyticsPack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Status = IpcResponse<'analyticsPack:status'>;

const OFFER = {
  path: 'C:\\Users\\someone\\Downloads\\analytics-pack-0.23.0-win-x64.tar.gz',
  version: '0.23.0',
};
const NONE: Status = { installed: null, offer: OFFER, unusable: [] };
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

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  h.answers.clear();
  h.calls.length = 0;
  analyticsPack.setState(analyticsPack.getInitialState());
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

async function show(status: Status, hardware: HardwareCheck = CARD) {
  h.answers.set('analyticsPack:status', () => status);
  h.answers.set('analytics:hardware', () => hardware);
  root = createRoot(host);
  act(() => root?.render(<AnalyticsPack />));
  await flush();
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Settings, Analytics pack', () => {
  it('not installed shows the offer and Install', async () => {
    await show(NONE);
    expect(host.textContent).toContain('Analytics pack');
    expect(host.textContent).toContain(
      'Runs detectors on this computer, with no internet. It needs an NVIDIA graphics card with 8 GB of memory and takes about 7 GB of disk.',
    );
    expect(host.textContent).toContain(
      'Includes llama.cpp (MIT) and Qwen2.5-VL-7B-Instruct (Apache-2.0).',
    );
    expect(q('ap-version')?.textContent).toBe('Not installed');
    expect(q('ap-offer')?.textContent).toContain('analytics-pack-0.23.0-win-x64.tar.gz');
    h.answers.set('analyticsPack:install', () => ({ ok: true, version: '0.23.0' }));
    h.answers.set('analyticsPack:status', () => INSTALLED);
    await act(async () => {
      q('ap-install')?.click();
      await Promise.resolve();
    });
    await flush();
    expect(h.calls.find((c) => c.channel === 'analyticsPack:install')?.req).toEqual({
      path: OFFER.path,
    });
    expect(q('ap-note')?.textContent).toContain('0.23.0');
    expect(q('ap-offer')).toBeNull();
  });

  it('an install shows its progress and can be cancelled', async () => {
    await show(NONE);
    let finish: (v: unknown) => void = () => undefined;
    h.answers.set('analyticsPack:install', () => new Promise((r) => (finish = r)));
    h.answers.set('analyticsPack:cancel', () => ({ ok: true }));
    await act(async () => {
      q('ap-install')?.click();
      await Promise.resolve();
    });
    expect(q('ap-progress')?.textContent).toContain('Installing the Analytics pack');
    expect(q('ap-choose')?.hasAttribute('disabled')).toBe(true);
    act(() => q('ap-cancel')?.click());
    expect(h.calls.at(-1)?.channel).toBe('analyticsPack:cancel');
    await act(async () => {
      finish({ ok: false, code: 'cancelled', error: 'cancelled' });
      await Promise.resolve();
    });
    await flush();
    expect(q('ap-progress')).toBeNull();
    expect(q('ap-error')).toBeNull();
    expect(q('ap-offer')).not.toBeNull();
  });

  it('installed shows the version and Remove with an inline confirm', async () => {
    await show(INSTALLED);
    expect(q('ap-version')?.textContent).toBe('0.23.0');
    expect(q('ap-offer')).toBeNull();
    expect(q('ap-remove-yes')).toBeNull();
    act(() => q('ap-remove')?.click());
    expect(h.calls.some((c) => c.channel === 'analyticsPack:remove')).toBe(false);
    h.answers.set('analyticsPack:remove', () => ({ ok: true }));
    h.answers.set('analyticsPack:status', () => ({ ...NONE, offer: null }));
    await act(async () => {
      q('ap-remove-yes')?.click();
      await Promise.resolve();
    });
    await flush();
    expect(h.calls.find((c) => c.channel === 'analyticsPack:remove')?.req).toEqual({
      version: '0.23.0',
    });
    expect(q('ap-version')?.textContent).toBe('Not installed');
    expect(q('ap-note')?.textContent).toContain('0.23.0');
  });

  it('shows why an installed pack cannot be used', async () => {
    await show({
      installed: null,
      offer: null,
      unusable: [
        {
          version: '0.22.0',
          reason: 'Analytics pack 0.22.0 does not work with this version of AIO (>=0.23.0).',
        },
      ],
    });
    expect(q('ap-unusable')?.textContent).toContain(
      'Analytics pack 0.22.0 does not work with this version of AIO (>=0.23.0).',
    );
  });

  it('the hardware line shows the card and free memory', async () => {
    await show(INSTALLED);
    expect(q('ap-hw')?.textContent).toContain('NVIDIA GeForce RTX 5070 Ti · 16 GB · 13.2 GB free');
    expect(q('ap-hw-recheck')).toBeNull();
  });

  it('the hardware line shows the refusal reason and Check again', async () => {
    const busy = 'Only 2 GB of graphics memory is free; detectors need about 6.5 GB.';
    await show(INSTALLED, { ok: false, code: 'tooBusy', reason: busy });
    expect(q('ap-hw')?.textContent).toContain(busy);
    const before = h.calls.filter((c) => c.channel === 'analytics:hardware').length;
    h.answers.set('analytics:hardware', () => CARD);
    await act(async () => {
      q('ap-hw-recheck')?.click();
      await Promise.resolve();
    });
    await flush();
    expect(h.calls.filter((c) => c.channel === 'analytics:hardware').length).toBe(before + 1);
    expect(q('ap-hw')?.textContent).toContain('13.2 GB free');
  });

  it('on a Mac the section says it is not available', async () => {
    await show(NONE, { ok: false, code: 'mac', reason: 'Not available on this computer yet.' });
    expect(q('ap-hw')?.textContent).toContain('Not available on this computer yet.');
    expect(q('ap-hw-recheck')).toBeNull();
    expect(q('ap-install')).toBeNull();
    expect(q('ap-choose')).toBeNull();
    expect(q('ap-offer')).toBeNull();
  });
});
