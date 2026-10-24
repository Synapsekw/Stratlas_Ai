// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import type { PhotoPick } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const answers: Record<string, unknown> = {};
  const run: unknown = null;
  return { answers, start: vi.fn(), openSettingsPage: vi.fn(), readOnly: false, run };
});

vi.mock('../../shell', () => ({
  useCall: (channel: string) => h.answers[channel] ?? null,
  shell: { getState: () => ({ openSettingsPage: h.openSettingsPage }) },
}));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => h.readOnly }));
vi.mock('../../thumbs/Thumb', () => ({ MediaThumb: () => <i data-testid="thumb" /> }));
vi.mock('./runs', () => ({
  startAskRun: h.start,
  useAskAiRun: (sel: (s: { run: unknown }) => unknown) => sel({ run: h.run }),
}));

const { AskAiBar } = await import('./AskAiBar');
const { setAskAiPrefs, rememberCheck, cloudConfirmSkipped } = await import('./prefs');

const manifest = {
  layers: [
    { kind: 'photos', id: 'photos', name: 'Photos', items: [{ id: 'p1' }, { id: 'p2' }] },
    { kind: 'video', id: 'clip', name: 'Clip', src: { path: 'clip.mp4' } },
    { kind: 'walk', id: 'walk', name: 'Walk', durationS: 10, src: { path: 'w.mp4' } },
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
    expect(q('ask-ai')?.disabled).toBe(true);
    expect(q('ask-ai')?.title).toContain('Install a local model or detector in Settings');
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
    expect(q('ask-ai')?.disabled).toBe(true);
  });

  it('is off in a read-only package', async () => {
    h.readOnly = true;
    bar({ current: P1, selected: [P1] });
    expect(q('ask-ai')?.disabled).toBe(true);
    expect(q('ask-ai-checks')?.disabled).toBe(true);
    expect(q('ask-ai-scope-all')?.disabled).toBe(true);
    expect(q('ask-ai-readonly')?.textContent).toBe('This package is read only.');
    await click('ask-ai');
    expect(h.start).not.toHaveBeenCalled();
  });
});
