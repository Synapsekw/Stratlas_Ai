// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { pictureRun } from './captureViews';
import { showPictureProgress } from './PictureProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hide: (() => void) | null = null;
afterEach(() => {
  act(() => hide?.());
  hide = null;
  pictureRun.setState({ running: false, stopping: false, done: 0, total: 0 });
});

const card = () =>
  document.querySelector<HTMLElement>('[data-testid="volumetric-picture-progress"]');
const key = (k: string, shift = false) => {
  const el = document.activeElement ?? document.body;
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));
  });
};

describe('PictureProgress', () => {
  it('is a named modal that holds the focus and stops the run on Escape', async () => {
    pictureRun.setState({ running: true, stopping: false, done: 1, total: 4 });
    await act(async () => {
      hide = showPictureProgress();
      await Promise.resolve();
    });
    const box = card();
    expect(box?.getAttribute('role')).toBe('alertdialog');
    expect(box?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(box?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toContain('Taking the report pictures');
    expect(box?.textContent).toContain('Taking pictures, 1 of 4');
    // focus is inside, and Tab keeps it there
    expect(box?.contains(document.activeElement)).toBe(true);
    key('Tab');
    expect(box?.contains(document.activeElement)).toBe(true);
    key('Tab', true);
    expect(box?.contains(document.activeElement)).toBe(true);
    // Escape asks the run to stop; the card says so until the run ends
    key('Escape');
    expect(pictureRun.getState().stopping).toBe(true);
    expect(card()?.textContent).toContain('Stopping after this picture');
  });

  it('stops from its Stop button too', async () => {
    pictureRun.setState({ running: true, stopping: false, done: 0, total: 4 });
    await act(async () => {
      hide = showPictureProgress();
      await Promise.resolve();
    });
    const stop = [...(card()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Stop taking pictures',
    );
    act(() => stop?.click());
    expect(pictureRun.getState().stopping).toBe(true);
  });
});
