// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { pictureRun } from './captureViews';
import { exportRun } from './editorView';
import { showPictureProgress } from './PictureProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let hide: (() => void) | null = null;
afterEach(() => {
  act(() => hide?.());
  hide = null;
  pictureRun.setState({ running: false, stopping: false, done: 0, total: 0, label: '' });
  exportRun.setState({ phase: 'idle', format: null, error: null });
});

const card = () =>
  document.querySelector<HTMLElement>('[data-testid="volumetric-picture-progress"]');
const key = (k: string, shift = false) => {
  const el = document.activeElement ?? document.body;
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));
  });
};
const stopButton = () =>
  [...(card()?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent.includes('Stop taking pictures'),
  );
const show = async () => {
  await act(async () => {
    hide = showPictureProgress();
    await Promise.resolve();
  });
};
const bar = () => card()?.querySelector<HTMLElement>('[role="progressbar"]');

describe('PictureProgress', () => {
  it('is a named modal that holds the focus and stops the run on Escape', async () => {
    pictureRun.setState({ running: true, stopping: false, done: 1, total: 4, label: 'Site, June' });
    await show();
    const box = card();
    expect(box?.getAttribute('role')).toBe('alertdialog');
    expect(box?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(box?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toContain('Taking the report pictures');
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
    expect(card()?.dataset.phase).toBe('stopping');
  });

  it('says what is pictured, with the count and a bar that follows it', async () => {
    pictureRun.setState({
      running: true,
      stopping: false,
      done: 11,
      total: 97,
      label: 'Pile 4 of 31: Pile D',
    });
    await show();
    expect(card()?.dataset.phase).toBe('pictures');
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe('Pile 4 of 31: Pile D');
    // the picture being taken now is the twelfth
    expect(card()?.textContent).toContain('Picture 12 of 97');
    expect(bar()?.getAttribute('aria-valuenow')).toBe('11');
    expect(bar()?.getAttribute('aria-valuemax')).toBe('97');
    expect(bar()?.querySelector('i')?.style.width).toBe('11%');
    act(() => {
      pictureRun.setState({ done: 97 });
    });
    // never "Picture 98 of 97" while the last one is saved
    expect(card()?.textContent).toContain('Picture 97 of 97');
  });

  it('shows a bar without a figure while the 3D view is still opening', async () => {
    await show();
    expect(card()?.textContent).not.toContain('Picture 0');
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar()?.dataset.busy).toBe('true');
  });

  it('stops from its Stop button too', async () => {
    pictureRun.setState({ running: true, stopping: false, done: 0, total: 4 });
    await show();
    act(() => stopButton()?.click());
    expect(pictureRun.getState().stopping).toBe(true);
  });

  it('says it is writing the file, and Stop no longer stops', async () => {
    exportRun.setState({ phase: 'writing', format: 'volumetric-pdf', error: null });
    pictureRun.setState({ running: false, stopping: false, done: 4, total: 4, label: '' });
    await show();
    expect(card()?.dataset.phase).toBe('writing');
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe('Writing the PDF');
    expect(card()?.textContent).not.toContain('Picture 4 of 4');
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    const stop = stopButton();
    // still focusable (the card holds the focus), but it says it does nothing now
    expect(stop?.getAttribute('aria-disabled')).toBe('true');
    act(() => stop?.click());
    key('Escape');
    expect(pictureRun.getState().stopping).toBe(false);
    act(() => {
      exportRun.setState({ format: 'volumetric-html' });
    });
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe('Writing the HTML file');
  });
});
