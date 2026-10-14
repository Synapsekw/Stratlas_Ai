// @vitest-environment jsdom
import { captureIndex, workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threeDates } from './__fixtures__/threeDates';
import { DateRow } from './DateRow';
import { timeline } from './timeline';
import { timelinePref } from './timelinePref';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  localStorage.clear();
  timeline.setState({ byProject: {} });
  timelinePref.setState({ byProject: {} });
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
  act(() => root?.render(<DateRow />));
};

describe('DateRow', () => {
  it('shows the focused date between the arrows', () => {
    render();
    expect(q('date-row')).not.toBeNull();
    expect(q('date-bar-open')?.textContent).toContain('6 Nov 2024');
    act(() => q('date-bar-prev')?.click());
    expect(timeline.getState().focus).toBe('oct');
  });
  it('opens the calendar above itself', () => {
    render();
    act(() => q('date-bar-open')?.click());
    expect(host.querySelector('.dbar-pop.up [data-testid="calendar"]')).not.toBeNull();
  });
  it('brings the timeline back', () => {
    render();
    act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Show the timeline"]')?.click(),
    );
    // the project has video, so the timeline was shown by default: the button flips the choice
    expect(timelinePref.getState().byProject.p3).toBe(false);
  });
});
