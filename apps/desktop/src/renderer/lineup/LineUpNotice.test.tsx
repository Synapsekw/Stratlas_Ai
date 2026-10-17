// @vitest-environment jsdom
import type { CaptureLineUp } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../shell';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpStore } from './lineUpStore';
import { LineUpNotice } from './LineUpNotice';
import { LineUpOffer } from './LineUpOffer';
import { lineUpManifest, measureOf } from './testing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement;
const byId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const press = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

async function linedUp() {
  const workspace = createWorkspace();
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest() });
  const saves: [string, CaptureLineUp | null][] = [];
  const store = createLineUpStore({
    workspace,
    measure: () => Promise.resolve(measureOf()),
    saveCapture: (id, lineUp) => {
      saves.push([id, lineUp]);
      return Promise.resolve(null);
    },
    pinCaptures: () => Promise.resolve(null),
    hints: () => ({}),
    issues: () => [],
    measurements: () => [],
    memory: createLineUpMemory(null),
    now: () => '2026-10-17T10:00:00.000Z',
  });
  root = createRoot(host);
  act(() => root?.render(<LineUpNotice store={store} />));
  await act(async () => {
    await store.getState().open('d1', 'd2');
    store.getState().choose('d1');
    await store.getState().confirm();
  });
  return { store, saves };
}

describe('LineUpNotice', () => {
  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'));
    shell.setState({ screen: 'scene' });
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
  });

  it('undoes on Ctrl+Z', async () => {
    const { saves } = await linedUp();
    expect(byId('lineup-text')?.textContent).toBe(
      'Survey 13 April 2026 lined up with Survey 2 March 2026 (2.00 m).',
    );
    expect(byId('lineup-undo')).not.toBeNull();
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    press({ key: 'z', ctrlKey: true });
    window.removeEventListener('keydown', spy);
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(saves.at(-1)).toEqual(['d2', null]);
    expect(byId('lineup-text')?.textContent).toBe('Line-up undone.');
    expect(byId('lineup-redo')).not.toBeNull();
    press({ key: 'y', ctrlKey: true });
    await flush();
    expect(saves.at(-1)?.[1]).toMatchObject({ eastM: -2, northM: 0, with: 'd1' });
    expect(byId('lineup-text')?.textContent).toBe('Lined up again.');
  });

  it('leaves Ctrl+Z to a field', async () => {
    const { saves } = await linedUp();
    const input = host.appendChild(document.createElement('input'));
    press({ key: 'z', ctrlKey: true }, input);
    await flush();
    expect(saves).toHaveLength(1);
    expect(byId('lineup-undo')).not.toBeNull();
  });

  it('offers a line-up with Line up dates and Not now', async () => {
    const { store } = await linedUp();
    act(() => root?.render(<LineUpOffer store={store} />));
    act(() => {
      store.getState().offerFrom(measureOf(), 'o1|o2');
    });
    expect(byId('lineup-offer-text')?.textContent).toBe(
      "Survey 13 April 2026 doesn't line up with Survey 2 March 2026. Its ortho sits 2.00 m away.",
    );
    await act(async () => {
      byId('lineup-offer-go')?.click();
      await Promise.resolve();
    });
    expect(store.getState().offer).toBeNull();
    expect(store.getState().dialog).toMatchObject({ a: 'd1', b: 'd2', measure: measureOf() });
    act(() => {
      store.getState().offerFrom(measureOf(), 'o1|o2');
    });
    act(() => {
      byId('lineup-offer-later')?.click();
    });
    expect(store.getState().offer).toBeNull();
    expect(byId('lineup-offer')).toBeNull();
  });
});
