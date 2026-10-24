// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudConfirm as ConfirmInfo } from './backend';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../thumbs/Thumb', () => ({ MediaThumb: () => <i data-testid="thumb" /> }));
vi.mock('../../detections/prepare', () => ({ frameThumb: () => new Promise(() => undefined) }));

const { CloudConfirm } = await import('./CloudConfirm');
const { cloudConfirmSkipped } = await import('./prefs');

const layers = [
  {
    kind: 'photos',
    id: 'photos',
    name: 'Photos',
    items: Array.from({ length: 14 }, (_, k) => ({ id: `p${String(k)}`, src: { path: 'x.jpg' } })),
  },
] as unknown as Layer[];

const info = (over: Partial<ConfirmInfo> = {}): ConfirmInfo => ({
  provider: 'anthropic',
  providerLabel: 'Anthropic',
  model: 'claude-opus-4-1',
  photos: 14,
  frames: 0,
  estimate: { requests: 4, inputTokens: 1000, outputTokens: 100, costUsd: 0.4321 },
  preview: Array.from({ length: 12 }, (_, k) => ({
    kind: 'photo' as const,
    layer: 'photos',
    photo: `p${String(k)}`,
  })),
  hint: '',
  instructions: 'Find defects.',
  userText: 'Look at these 4 images.',
  ...over,
});

let host: HTMLDivElement;
let root: Root;
const onSend = vi.fn();
const onCancel = vi.fn();
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  window.localStorage.clear();
  onSend.mockReset();
  onCancel.mockReset();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  act(() => {
    q(id)?.click();
  });
};
const show = (c: ConfirmInfo) => {
  act(() => {
    root.render(
      <CloudConfirm
        projectId="proj"
        layers={layers}
        confirm={c}
        onSend={onSend}
        onCancel={onCancel}
      />,
    );
  });
};

describe('CloudConfirm', () => {
  it('says in one line how many photos go where and about what it costs', () => {
    show(info());
    expect(q('cloud-confirm-line')?.textContent).toBe('Send 14 photos to Anthropic, about $0.43?');
    expect(q('cloud-confirm-preview')).toBeNull();
  });

  it('rounds a tiny cost up to a cent', () => {
    show(
      info({
        photos: 1,
        estimate: { requests: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
      }),
    );
    expect(q('cloud-confirm-line')?.textContent).toBe('Send 1 photo to Anthropic, about $0.01?');
  });

  it('calls video frames frames', () => {
    show(info({ photos: 0, frames: 3 }));
    expect(q('cloud-confirm-line')?.textContent).toContain('Send 3 frames to Anthropic');
    show(info({ photos: 0, frames: 1 }));
    expect(q('cloud-confirm-line')?.textContent).toContain('Send 1 frame to Anthropic');
  });

  it('shows the first 12 images and the text exactly as sent, one click away', () => {
    show(info());
    click('cloud-confirm-preview-open');
    const preview = q('cloud-confirm-preview');
    expect(preview?.querySelectorAll('[data-testid="thumb"]').length).toBe(12);
    expect(preview?.textContent).toContain('and 2 more images');
    expect(preview?.textContent).toContain('Find defects.');
    expect(preview?.textContent).toContain('Look at these 4 images.');
    click('cloud-confirm-preview-open');
    expect(q('cloud-confirm-preview')).toBeNull();
  });

  it('sends, and turns the confirm off for this project when asked', () => {
    show(info());
    click('cloud-confirm-send');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(cloudConfirmSkipped('proj')).toBe(false);
    click('cloud-confirm-dont-ask');
    click('cloud-confirm-send');
    expect(cloudConfirmSkipped('proj')).toBe(true);
  });

  it('cancels', () => {
    show(info());
    click('cloud-confirm-cancel');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });
});
