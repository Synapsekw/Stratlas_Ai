// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const newSurveyDate = vi.hoisted(() => vi.fn());
const moveLayersToDate = vi.hoisted(() => vi.fn());
vi.mock('../change/SurveyDate', () => ({ newSurveyDate }));
vi.mock('./dateFolders', () => ({ moveLayersToDate }));

import { builder } from '../builder/state';
import { DatePrompt } from './DatePrompt';
import { datePromptPref } from './datePromptPref';

const photos = (id: string, takenAt: string, name = id) => ({
  id,
  kind: 'photos',
  name,
  items: [{ takenAt }],
});
const video = (id: string, startUtcMs: number) => ({
  id,
  kind: 'video',
  name: id,
  flight: { startUtcMs },
});

function open(layers: unknown[], captures: unknown[] = [], id = 'p1') {
  const manifest = { crs: { local: true }, origin: [0, 0, 0], captures, layers };
  workspace.setState({ project: { id, root: 'C:/p', manifest } as never });
}

let host: HTMLDivElement;
let root: Root | undefined;
const onResult = vi.fn();
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function mount(canEdit = true) {
  root = createRoot(host);
  act(() => root?.render(<DatePrompt canEdit={canEdit} onResult={onResult} />));
}
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  datePromptPref.setState({ done: {} });
  builder.setState({ importing: null });
  newSurveyDate.mockReset();
  moveLayersToDate.mockReset();
  onResult.mockReset();
  moveLayersToDate.mockResolvedValue({ error: null, stays: {}, moved: [] });
  open([photos('ph', '2024-11-06T08:00:00'), video('vid', Date.UTC(2024, 10, 7, 9))]);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.setState({ project: null });
});

describe('DatePrompt', () => {
  it('files both groups, adding the missing dates, then finishes', async () => {
    newSurveyDate.mockImplementation((day: string) =>
      Promise.resolve({ captureId: `capture-${day}` }),
    );
    moveLayersToDate.mockImplementation((ids: string[]) =>
      Promise.resolve({
        error: null,
        stays: {},
        moved: ids.map((id) => ({ id, capture: null })),
      }),
    );
    mount();
    expect(q('date-prompt')).not.toBeNull();
    act(() => q('date-prompt-file')?.click());
    await flush();
    await flush();
    expect(newSurveyDate.mock.calls).toEqual([['2024-11-06'], ['2024-11-07']]);
    expect(moveLayersToDate).toHaveBeenCalledWith(['ph'], 'capture-2024-11-06');
    expect(moveLayersToDate).toHaveBeenCalledWith(['vid'], 'capture-2024-11-07');
    expect(datePromptPref.getState().done).toEqual({ p1: true });
    expect(onResult).toHaveBeenCalledWith({ text: 'Filed 2 datasets.' });
  });

  it('stops at the first error and does not finish', async () => {
    newSurveyDate.mockResolvedValue({ error: 'Disk full.' });
    mount();
    act(() => q('date-prompt-file')?.click());
    await flush();
    await flush();
    expect(moveLayersToDate).not.toHaveBeenCalled();
    expect(datePromptPref.getState().done).toEqual({});
    expect(host.textContent).toContain('Disk full.');
  });

  it('Not now finishes without filing', () => {
    mount();
    act(() => q('date-prompt-later')?.click());
    expect(datePromptPref.getState().done).toEqual({ p1: true });
    expect(moveLayersToDate).not.toHaveBeenCalled();
    expect(q('date-prompt')).toBeNull();
  });

  it('is hidden when done, read-only or importing', () => {
    datePromptPref.setState({ done: { p1: true } });
    mount();
    expect(q('date-prompt')).toBeNull();
    act(() => root?.unmount());
    datePromptPref.setState({ done: {} });
    mount(false);
    expect(q('date-prompt')).toBeNull();
    act(() => root?.unmount());
    builder.setState({ importing: { done: 0, total: 1, file: 'a' } });
    mount();
    expect(q('date-prompt')).toBeNull();
  });

  it('does not count layers that were not moved, and offers no undo then', async () => {
    open(
      [photos('ph', '2024-11-06T08:00:00')],
      [{ id: 'c1', label: 'Survey', date: '2024-11-06' }],
    );
    mount();
    act(() => q('date-prompt-file')?.click());
    await flush();
    await flush();
    expect(datePromptPref.getState().done).toEqual({ p1: true });
    expect(onResult).not.toHaveBeenCalled();
  });

  it('stops quietly when the project changes while filing', async () => {
    let release: (v: { captureId: string }) => void = () => undefined;
    newSurveyDate.mockReturnValue(new Promise((r) => (release = r)));
    mount();
    act(() => q('date-prompt-file')?.click());
    act(() => {
      open([], [], 'p2');
    });
    await act(async () => {
      release({ captureId: 'capture-x' });
      await Promise.resolve();
    });
    await flush();
    expect(moveLayersToDate).not.toHaveBeenCalled();
    expect(datePromptPref.getState().done).toEqual({});
    expect(onResult).not.toHaveBeenCalled();
    act(() => {
      open([photos('ph', '2024-11-06T08:00:00')], [], 'p2');
    });
    expect(q('date-prompt-file')?.hasAttribute('disabled')).toBe(false);
  });

  it('frees the buttons when the first project comes back after a switch while filing', async () => {
    let release: (v: { captureId: string }) => void = () => undefined;
    newSurveyDate.mockReturnValue(new Promise((r) => (release = r)));
    const layers = [photos('ph', '2024-11-06T08:00:00')];
    open(layers);
    mount();
    act(() => q('date-prompt-file')?.click());
    act(() => {
      open([], [], 'p2');
    });
    await act(async () => {
      release({ captureId: 'capture-x' });
      await Promise.resolve();
    });
    await flush();
    act(() => {
      open(layers);
    });
    expect(q('date-prompt-file')?.hasAttribute('disabled')).toBe(false);
    expect(q('date-prompt-later')?.hasAttribute('disabled')).toBe(false);
  });

  it('leaves a name-dated layer alone', () => {
    open(
      [photos('ph', '2024-11-06T08:00:00', 'Photos 2024-11-06')],
      [
        { id: 'c1', label: 'Survey', date: '2024-11-06' },
        { id: 'c2', label: 'Survey', date: '2024-12-01' },
      ],
    );
    mount();
    expect(q('date-prompt')).toBeNull();
  });
});
