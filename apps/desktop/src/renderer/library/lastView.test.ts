import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stage = { id: 'stage' };
const renderSnapshot = vi.fn<(...args: unknown[]) => unknown>(() => null);
let hook: ((id: string) => void) | null = null;

vi.mock('@aio/engine', () => ({ getActiveStage: () => stage }));
vi.mock('../exports/exports', () => ({
  renderSnapshot: (...args: unknown[]) => renderSnapshot(...args),
}));
vi.mock('../shell', () => ({ shell: { getState: () => ({ setLastView: () => undefined }) } }));
vi.mock('../store', () => ({
  onLeaveView: (h: ((id: string) => void) | null) => {
    hook = h;
  },
}));

const { COVER_MAX } = await import('./cover');
const { installLastView } = await import('./lastView');

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  renderSnapshot.mockClear();
  stop = installLastView();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

const leave = (id: string) => {
  hook?.(id);
};

describe('installLastView', () => {
  it('draws the 3D view straight at cover size', () => {
    leave('yard');
    expect(renderSnapshot).toHaveBeenCalledWith(stage, false, COVER_MAX);
  });

  it('takes one picture of a project left twice within two seconds', () => {
    leave('yard');
    vi.advanceTimersByTime(500);
    leave('yard');
    expect(renderSnapshot).toHaveBeenCalledTimes(1);
    leave('quarry');
    expect(renderSnapshot).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    leave('yard');
    expect(renderSnapshot).toHaveBeenCalledTimes(3);
  });
});
