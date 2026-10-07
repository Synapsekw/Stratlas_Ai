// @vitest-environment jsdom
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { DateBar, isTypingTarget } from './DateBar';
import { timeline } from './timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  // The timeline singleton remembers the last focus per project, in memory and in storage.
  localStorage.clear();
  timeline.setState({ byProject: {} });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  timeline.getState().attach('p3', captureIndex(threeDates));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  timeline.getState().attach(null, null);
  workspace.getState().closeProject();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const render = () => {
  root = createRoot(host);
  act(() => root?.render(<DateBar />));
};

describe('DateBar', () => {
  it('shows the focused date and position', () => {
    render();
    expect(q('date-bar-open')?.textContent).toContain('6 Nov 2024');
    expect(q('date-bar-count')?.textContent).toBe('3 of 3 surveys');
  });
  it('previous arrow steps back', () => {
    render();
    act(() => q('date-bar-prev')?.click());
    expect(timeline.getState().focus).toBe('oct');
  });
  it('opens the calendar and picks a date', () => {
    render();
    act(() => q('date-bar-open')?.click());
    act(() => q('cal-prev')?.click()); // Nov -> Oct
    act(() => q('cal-prev')?.click()); // Oct -> Sep
    act(() => q('cal-day-2024-09-04')?.click());
    expect(timeline.getState().focus).toBe('sep');
    expect(q('calendar')).toBeNull();
  });
  it('opens a labelled dialog, as the opener announces', () => {
    render();
    expect(q('date-bar-open')?.getAttribute('aria-haspopup')).toBe('dialog');
    act(() => q('date-bar-open')?.click());
    const dialog = host.querySelector('.dbar-pop [role="dialog"]');
    expect(dialog).toBe(q('calendar'));
    expect(dialog?.getAttribute('aria-label')).toBeTruthy();
  });
  it('keeps the calendar day focused, and Escape closes it and returns focus', async () => {
    render();
    const opener = q('date-bar-open');
    opener?.focus();
    act(() => opener?.click());
    expect(document.activeElement).toBe(q('cal-day-2024-11-06'));
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(q('calendar')).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(opener);
  });
});

describe('isTypingTarget', () => {
  it('is true for inputs, textareas and contenteditable', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    const div = document.createElement('div');
    // jsdom has no contentEditable property or isContentEditable; the attribute is what it reads
    div.setAttribute('contenteditable', 'true');
    expect([isTypingTarget(input), isTypingTarget(area), isTypingTarget(div)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
