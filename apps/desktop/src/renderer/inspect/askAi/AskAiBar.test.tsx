// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { TIP_DELAY_MS, type PhotoPick } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const answers: Record<string, unknown> = {};
  const run: unknown = null;
  return {
    answers,
    start: vi.fn(),
    openSettingsPage: vi.fn(),
    loadPack: vi.fn(),
    readOnly: false,
    run,
  };
});

vi.mock('../../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  const { useStore } = await import('zustand');
  const settings = createStore(() => ({ settings: { cloudAi: false } }));
  return {
    // an answer may depend on the key, as main's answer depends on what the key names
    useCall: (channel: string, _req: unknown, key: unknown) => {
      const a = h.answers[channel];
      return (typeof a === 'function' ? (a as (k: unknown) => unknown)(key) : a) ?? null;
    },
    useShell: <T,>(sel: (s: { settings: Record<string, unknown> }) => T) => useStore(settings, sel),
    shell: { getState: () => ({ openSettingsPage: h.openSettingsPage }) },
    settingsStore: settings,
  };
});
vi.mock('../../analyticsPack', async () => {
  const { createStore } = await import('zustand/vanilla');
  const { useStore } = await import('zustand');
  const analyticsPack = createStore(() => ({
    status: null,
    hardware: null,
    hardwareError: null as string | null,
    error: null as string | null,
    load: h.loadPack,
  }));
  return {
    analyticsPack,
    useAnalyticsPack: <T,>(sel: (s: object) => T) => useStore(analyticsPack, sel),
  };
});
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => h.readOnly }));
vi.mock('../../thumbs/Thumb', () => ({ MediaThumb: () => <i data-testid="thumb" /> }));
vi.mock('./runs', () => ({
  startAskRun: h.start,
  useAskAiRun: (sel: (s: { run: unknown }) => unknown) => sel({ run: h.run }),
}));

const { AskAiBar } = await import('./AskAiBar');
const { setAskAiPrefs, rememberCheck, cloudConfirmSkipped } = await import('./prefs');
const { settingsStore } = (await import('../../shell')) as unknown as {
  settingsStore: StoreApi<{ settings: Record<string, unknown> }>;
};
const { analyticsPack } = (await import('../../analyticsPack')) as unknown as {
  analyticsPack: StoreApi<Record<string, unknown>>;
};

const manifest = {
  layers: [
    { kind: 'photos', id: 'photos', name: 'Photos', items: [{ id: 'p1' }, { id: 'p2' }] },
    { kind: 'video', id: 'clip', name: 'Clip', src: { path: 'clip.mp4' } },
    { kind: 'walk', id: 'walk', name: 'Walk', durationS: 10, src: { path: 'w.mp4' } },
    { kind: 'walk', id: 'long', name: 'Long walk', durationS: 4000, src: { path: 'l.mp4' } },
  ],
  classCatalogues: [
    { id: 'cat', assetType: 'asset', classes: [{ id: 'corr', label: 'Corrosion' }] },
  ],
  severityModels: [],
} as unknown as ProjectManifest;

const P1: PhotoPick = { layerId: 'photos', photoId: 'p1' };
const P2: PhotoPick = { layerId: 'photos', photoId: 'p2' };

const MODELS_ON = {
  ok: true,
  value: {
    runtime: { available: true },
    models: [
      {
        id: 'yolo',
        card: { name: 'Y', classes: ['rust'], input: { width: 640, height: 640 } },
      },
    ],
  },
};
const MODELS_OFF = { ok: true, value: { runtime: { available: false }, models: [] } };
const NO_DETECTORS = { ok: true, value: { items: [] } };
const CLOUD_ON = {
  ok: true,
  value: {
    ready: true,
    cloud: true,
    route: { task: 'vision', provider: 'anthropic', model: 'claude-opus-4-1' },
  },
};
const CLOUD_OFF = { ok: true, value: { ready: false, cloud: true, reason: 'no-key' } };
const DETECTORS = {
  ok: true,
  value: {
    items: [
      {
        where: 'library',
        detector: {
          id: 'rust-v1',
          name: 'Rust',
          classId: 'corr',
          threshold: 0.8,
          assetTypes: ['asset'],
        },
      },
    ],
  },
};
const PACK = { installed: { version: '1.0.0', dir: 'D:/pack' }, offer: null, unusable: [] };
const CARD = { ok: true, name: 'RTX', vramMb: 16000, freeMb: 12000 };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.localStorage.clear();
  setAskAiPrefs({ backend: 'auto', localModel: null, cloudBatch: 4 });
  h.start.mockReset();
  h.start.mockResolvedValue(undefined);
  h.openSettingsPage.mockReset();
  h.loadPack.mockReset();
  settingsStore.setState({ settings: { cloudAi: false } });
  analyticsPack.setState({ status: PACK, hardware: CARD, hardwareError: null, error: null });
  h.readOnly = false;
  h.run = null;
  h.answers = {
    'inference:models': MODELS_ON,
    'detectors:list': NO_DETECTORS,
    'ai:status': CLOUD_OFF,
  };
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
/** Off, whether natively or (to keep its tip reachable) through aria-disabled. */
const isOff = (id: string) =>
  q(id)?.disabled === true || q(id)?.getAttribute('aria-disabled') === 'true';

/** Hovers a control and returns the text of the tip it opens. */
function tipOf(el: HTMLElement | null): string | undefined {
  vi.useFakeTimers();
  try {
    act(() => {
      el?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    });
    act(() => {
      vi.advanceTimersByTime(TIP_DELAY_MS);
    });
  } finally {
    vi.useRealTimers();
  }
  return document.querySelector('[role="tooltip"]')?.textContent ?? undefined;
}
const click = async (id: string) => {
  await act(async () => {
    q(id)?.click();
    await Promise.resolve();
  });
};

function bar(p: { current?: PhotoPick | null; selected?: PhotoPick[]; all?: PhotoPick[] } = {}) {
  act(() => {
    root.render(
      <AskAiBar
        projectId="proj"
        projectRoot="C:/proj"
        manifest={manifest}
        current={p.current ?? null}
        selected={p.selected ?? []}
        all={p.all ?? [P1, P2]}
        durations={{ clip: 20_000 }}
      />,
    );
  });
}

const startedWith = () => h.start.mock.calls[0]?.[0] as Record<string, unknown>;

describe('AskAiBar', () => {
  it('runs the remembered check on this photo with one click when a local model can', async () => {
    bar({ current: P1 });
    expect(q('ask-ai-scope-photo')?.getAttribute('aria-pressed')).toBe('true');
    await click('ask-ai');
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(startedWith()).toMatchObject({
      items: [{ kind: 'photo', layer: 'photos', photo: 'p1' }],
      backend: { kind: 'local' },
      check: { kind: 'everything' },
    });
    expect(startedWith().confirmed).toBeUndefined();
  });

  it('uses the check last asked for in this project, and the one picked in the menu', async () => {
    rememberCheck('proj', { kind: 'class', classId: 'corr' });
    h.answers['ai:status'] = CLOUD_ON;
    setAskAiPrefs({ backend: 'cloud' });
    bar({ current: P1 });
    await click('ask-ai-checks');
    expect(q('ask-ai-check-1')?.getAttribute('aria-checked')).toBe('true');
    expect(q('ask-ai-check-0')?.getAttribute('aria-checked')).toBe('false');
    await click('ask-ai-check-0');
    expect(q('ask-ai-check-0')).toBeNull();
    await click('ask-ai-checks');
    expect(q('ask-ai-check-0')?.getAttribute('aria-checked')).toBe('true');
  });

  it('scopes to the picks when there are some', async () => {
    bar({ current: P1, selected: [P1, P2] });
    expect(q('ask-ai-scope-selected')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('ask-ai-scope-selected')?.textContent).toBe('Selected (2)');
    await click('ask-ai');
    expect(startedWith().items).toEqual([
      { kind: 'photo', layer: 'photos', photo: 'p1' },
      { kind: 'photo', layer: 'photos', photo: 'p2' },
    ]);
  });

  it('looks at every photo with the All scope', async () => {
    bar({ current: P1 });
    await click('ask-ai-scope-all');
    await click('ask-ai');
    expect((startedWith().items as unknown[]).length).toBe(2);
  });

  it('samples walk frames every N seconds from the frames popover', async () => {
    bar({ current: P1 });
    await click('ask-ai-scope-frames');
    expect(q('ask-ai-frames')).not.toBeNull();
    const source = host.querySelector<HTMLSelectElement>('[data-testid="ask-ai-frames-source"]');
    act(() => {
      if (source) {
        source.value = 'walk';
        source.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await click('ask-ai-frames-every-5');
    expect(q('ask-ai-frames-count')?.textContent).toBe('2 frames');
    await click('ask-ai');
    expect(startedWith().items).toEqual([
      { kind: 'frame', layer: 'walk', t: 2.5 },
      { kind: 'frame', layer: 'walk', t: 7.5 },
    ]);
    expect(startedWith().backend).toMatchObject({ kind: 'local' });
  });

  it('asks before sending to the cloud, then sends', async () => {
    h.answers['inference:models'] = MODELS_OFF;
    h.answers['ai:status'] = CLOUD_ON;
    bar({ current: P1 });
    await click('ask-ai');
    expect(q('cloud-confirm')).toHaveProperty(
      'textContent',
      expect.stringContaining('Send 1 photo to Anthropic, about'),
    );
    expect(h.start).not.toHaveBeenCalled();
    await click('cloud-confirm-preview-open');
    expect(q('cloud-confirm-preview')?.querySelectorAll('[data-testid="thumb"]').length).toBe(1);
    await click('cloud-confirm-send');
    expect(startedWith()).toMatchObject({ confirmed: true, backend: { kind: 'cloud' } });
    expect(q('cloud-confirm')).toBeNull();
    expect(cloudConfirmSkipped('proj')).toBe(false);
  });

  it('rebuilds the confirm when the scope changes while it is open', async () => {
    h.answers['inference:models'] = MODELS_OFF;
    h.answers['ai:status'] = CLOUD_ON;
    bar({ current: P1 });
    await click('ask-ai');
    await click('ask-ai-scope-all');
    expect(q('cloud-confirm')?.textContent).toContain('Send 2 photos to Anthropic');
    await click('cloud-confirm-send');
    expect((startedWith().items as unknown[]).length).toBe(2);
  });

  it('sends nothing on Cancel', async () => {
    h.answers['inference:models'] = MODELS_OFF;
    h.answers['ai:status'] = CLOUD_ON;
    bar({ current: P1 });
    await click('ask-ai');
    await click('cloud-confirm-cancel');
    expect(q('cloud-confirm')).toBeNull();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('does not ask again for this project once told so', async () => {
    h.answers['inference:models'] = MODELS_OFF;
    h.answers['ai:status'] = CLOUD_ON;
    bar({ current: P1 });
    await click('ask-ai');
    await click('cloud-confirm-dont-ask');
    await click('cloud-confirm-send');
    expect(cloudConfirmSkipped('proj')).toBe(true);
    h.start.mockClear();
    await click('ask-ai');
    expect(q('cloud-confirm')).toBeNull();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(startedWith().confirmed).toBeUndefined();
  });

  it('says why nothing can run and links to Settings', async () => {
    h.answers['inference:models'] = MODELS_OFF;
    bar({ current: P1 });
    // focusable, so the reason can show on hover and on keyboard focus
    expect(q('ask-ai')?.disabled).toBe(false);
    expect(q('ask-ai')?.getAttribute('aria-disabled')).toBe('true');
    expect(tipOf(q('ask-ai'))).toContain('Install a local model or detector in Settings');
    await click('ask-ai');
    expect(h.start).not.toHaveBeenCalled();
    expect(q('ask-ai-blocked')?.textContent).toContain('No AI can look at this.');
    await click('ask-ai-settings');
    expect(h.openSettingsPage).toHaveBeenCalledWith('ai');
  });

  it('shows the error when a run cannot start', async () => {
    h.start.mockRejectedValue(new Error('nope'));
    bar({ current: P1 });
    await click('ask-ai');
    await act(async () => {
      await Promise.resolve();
    });
    expect(q('ask-ai-error')?.textContent).toContain('nope');
  });

  it('is off while a run is going', () => {
    h.run = { phase: 'running' };
    bar({ current: P1 });
    expect(isOff('ask-ai')).toBe(true);
    h.run = { phase: 'stopping' };
    bar({ current: P1 });
    expect(isOff('ask-ai')).toBe(true);
  });

  it('is off in a read-only package', async () => {
    h.readOnly = true;
    bar({ current: P1, selected: [P1] });
    expect(q('ask-ai')?.getAttribute('aria-disabled')).toBe('true');
    expect(tipOf(q('ask-ai'))).toBe('This package is read only.');
    expect(q('ask-ai-checks')?.disabled).toBe(true);
    expect(q('ask-ai-scope-all')?.disabled).toBe(true);
    expect(q('ask-ai-readonly')?.textContent).toBe('This package is read only.');
    await click('ask-ai');
    expect(h.start).not.toHaveBeenCalled();
  });

  it('says when a frames run is capped, and at how many frames', async () => {
    bar({ current: P1 });
    await click('ask-ai-scope-frames');
    const source = host.querySelector<HTMLSelectElement>('[data-testid="ask-ai-frames-source"]');
    act(() => {
      if (source) {
        source.value = 'long';
        source.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await click('ask-ai-frames-every-1');
    expect(q('ask-ai-frames-count')?.textContent).toBe('2000 frames');
    expect(q('ask-ai-frames-capped')?.textContent).toBe(
      'At most 2000 frames per run. Pick a longer interval to cover the whole video.',
    );
    await click('ask-ai-frames-every-2');
    expect(q('ask-ai-frames-capped')).toBeNull();
    // not for photos
    await click('ask-ai-frames-every-1');
    await click('ask-ai-scope-photo');
    expect(q('ask-ai-frames-capped')).toBeNull();
  });

  it('starts one run on a double click', async () => {
    h.start.mockReturnValue(new Promise(() => undefined));
    bar({ current: P1 });
    await act(async () => {
      q('ask-ai')?.click();
      q('ask-ai')?.click();
      await Promise.resolve();
    });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('sends once on a double click of Send', async () => {
    h.start.mockReturnValue(new Promise(() => undefined));
    h.answers['inference:models'] = MODELS_OFF;
    h.answers['ai:status'] = CLOUD_ON;
    bar({ current: P1 });
    await click('ask-ai');
    await act(async () => {
      const send = q('cloud-confirm-send');
      send?.click();
      send?.click();
      await Promise.resolve();
    });
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('follows the cloud setting while open', () => {
    h.answers['inference:models'] = MODELS_OFF;
    h.answers['ai:status'] = (key: unknown) =>
      (key as { aiKey: string }).aiKey.includes('true') ? CLOUD_ON : CLOUD_OFF;
    bar({ current: P1 });
    expect(isOff('ask-ai')).toBe(true);
    act(() => {
      settingsStore.setState({ settings: { cloudAi: true } });
    });
    expect(isOff('ask-ai')).toBe(false);
    expect(q('ask-ai-blocked')).toBeNull();
  });

  it("asks again when the project's manifest (its own cloud AI policy) is reloaded", () => {
    const keys: unknown[] = [];
    h.answers['inference:models'] = MODELS_OFF;
    // main reads the project's aiPolicy from manifest.json: forbidden first, allowed after
    h.answers['ai:status'] = (key: unknown) => {
      if (!keys.includes(key)) keys.push(key);
      return keys.indexOf(key) === 0 ? CLOUD_OFF : CLOUD_ON;
    };
    bar({ current: P1 });
    expect(isOff('ask-ai')).toBe(true);
    act(() => {
      root.render(
        <AskAiBar
          projectId="proj"
          projectRoot="C:/proj"
          manifest={{ ...manifest }}
          current={P1}
          selected={[]}
          all={[P1, P2]}
          durations={{ clip: 20_000 }}
        />,
      );
    });
    expect(isOff('ask-ai')).toBe(false);
  });

  describe('local detectors', () => {
    beforeEach(() => {
      h.answers['detectors:list'] = DETECTORS;
      // no local model and no cloud unless a test says so: only the detectors could look
      h.answers['inference:models'] = MODELS_OFF;
    });

    it('checks the Analytics pack and runs the detector when it can', async () => {
      bar({ current: P1 });
      expect(h.loadPack).toHaveBeenCalled();
      await click('ask-ai');
      expect(startedWith().backend).toMatchObject({ kind: 'detectors' });
    });

    it('falls back to the local model when the pack is missing', async () => {
      h.answers['inference:models'] = MODELS_ON;
      analyticsPack.setState({ status: { ...PACK, installed: null } });
      bar({ current: P1 });
      expect(isOff('ask-ai')).toBe(false);
      expect(q('ask-ai-blocked')).toBeNull();
      await click('ask-ai');
      expect(startedWith().backend).toMatchObject({ kind: 'local' });
    });

    it('falls back to the cloud, which still asks first, when the pack is missing', async () => {
      h.answers['ai:status'] = CLOUD_ON;
      analyticsPack.setState({ status: { ...PACK, installed: null } });
      bar({ current: P1 });
      await click('ask-ai');
      expect(q('cloud-confirm')).not.toBeNull();
      expect(h.start).not.toHaveBeenCalled();
    });

    it('blocks a check that names the detector, even with a local model ready', async () => {
      h.answers['inference:models'] = MODELS_ON;
      rememberCheck('proj', { kind: 'detector', where: 'library', id: 'rust-v1' });
      analyticsPack.setState({ status: { ...PACK, installed: null } });
      bar({ current: P1 });
      expect(isOff('ask-ai')).toBe(true);
      expect(q('ask-ai-blocked')?.textContent).toContain(
        'Install the Analytics pack in Settings to run detectors.',
      );
      await click('ask-ai');
      expect(h.start).not.toHaveBeenCalled();
    });

    it('waits while the pack is checked, even with a local model ready', () => {
      h.answers['inference:models'] = MODELS_ON;
      analyticsPack.setState({ status: null, hardware: null });
      bar({ current: P1 });
      expect(isOff('ask-ai')).toBe(true);
      expect(tipOf(q('ask-ai'))).toBe('Checking the Analytics pack and the graphics card.');
    });

    it('says the pack is missing when nothing else can look, and starts nothing', async () => {
      analyticsPack.setState({ status: { ...PACK, installed: null } });
      bar({ current: P1 });
      const why = 'Install the Analytics pack in Settings to run detectors.';
      expect(q('ask-ai')?.getAttribute('aria-disabled')).toBe('true');
      expect(q('ask-ai-blocked')?.textContent).toContain(why);
      expect(tipOf(q('ask-ai'))).toBe(why);
      await click('ask-ai');
      expect(h.start).not.toHaveBeenCalled();
      await click('ask-ai-settings');
      expect(h.openSettingsPage).toHaveBeenCalledWith('tools');
    });

    it('names why an installed pack cannot be used', () => {
      analyticsPack.setState({
        status: {
          ...PACK,
          installed: null,
          unusable: [{ version: '0.9.0', reason: 'Analytics pack 0.9.0 does not work here.' }],
        },
      });
      bar({ current: P1 });
      expect(q('ask-ai-blocked')?.textContent).toContain(
        'Analytics pack 0.9.0 does not work here.',
      );
    });

    it('on a Mac the Mac refusal is the reason, not the missing pack', () => {
      const reason = 'Detectors run on Windows with an NVIDIA card.';
      analyticsPack.setState({
        status: { ...PACK, installed: null },
        hardware: { ok: false, code: 'mac', reason },
      });
      bar({ current: P1 });
      expect(q('ask-ai-blocked')?.textContent).toContain(reason);
      expect(q('ask-ai-blocked')?.textContent).not.toContain('Install the Analytics pack');
    });

    it('a hardware refusal blocks the run; too busy only says so, the gate queues it', async () => {
      analyticsPack.setState({ hardware: { ok: false, code: 'noGpu', reason: 'No NVIDIA card.' } });
      bar({ current: P1 });
      expect(isOff('ask-ai')).toBe(true);
      expect(q('ask-ai-blocked')?.textContent).toContain('No NVIDIA card.');

      const busy = 'Only 3.1 GB of graphics memory is free; detectors need about 6.5 GB.';
      act(() => {
        analyticsPack.setState({ hardware: { ok: false, code: 'tooBusy', reason: busy } });
      });
      expect(isOff('ask-ai')).toBe(false);
      expect(q('ask-ai-blocked')).toBeNull();
      expect(q('ask-ai-busy')?.textContent).toBe(busy);
      await click('ask-ai');
      expect(h.start).toHaveBeenCalledTimes(1);
    });

    it('a failed graphics card check says so', () => {
      analyticsPack.setState({ hardware: null, hardwareError: 'no answer' });
      bar({ current: P1 });
      expect(q('ask-ai-blocked')?.textContent).toContain('Could not check the graphics card.');
    });
  });
});
