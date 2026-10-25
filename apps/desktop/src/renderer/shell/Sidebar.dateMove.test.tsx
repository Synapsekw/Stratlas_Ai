// @vitest-environment jsdom
import { ProjectManifest, type WalkLayer } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  move: vi.fn(),
  undo: vi.fn(),
}));
vi.mock('./dateFolders', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  moveLayersToDate: h.move,
  undoDateMove: h.undo,
}));

import { shell } from '../shell';
import { announceDateMove } from './dateMoveNote';
import { Sidebar } from './Sidebar';

const walk = (id: string, capture?: string): WalkLayer => ({
  kind: 'walk',
  id: `walk-${id}`,
  name: `Walk ${id}`,
  visible: true,
  record: { path: `walks/${id}/walk.json` },
  src: { path: `walks/${id}/playback.mp4` },
  durationS: 12,
  ...(capture ? { capture } : {}),
});
const dated = ProjectManifest.parse({
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32633 },
  origin: [500000, 4500000, 0],
  captures: [
    { id: 'c1', label: 'Survey', date: '2026-10-12' },
    { id: 'c2', label: 'Survey', date: '2026-10-19' },
  ],
  layers: [walk('a', 'c2'), walk('b')],
  severityModels: [],
  classCatalogues: [],
});

let host: HTMLDivElement;
let root: Root | undefined;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  const el = q(id) ?? expect.fail(`no ${id}`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};
const rightClick = (id: string) => {
  const el = q(id) ?? expect.fail(`no ${id}`);
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
  });
};
const flush = async () => {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await Promise.resolve();
    });
};

beforeEach(() => {
  h.move.mockReset();
  h.undo.mockReset();
  h.undo.mockResolvedValue(null);
  shell.setState({
    pkg: null,
    screen: 'scene',
    settings: { ...shell.getState().settings, sidebarCollapsed: false },
  });
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: dated });
  act(() => {
    root = createRoot(host);
    root.render(<Sidebar />);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  workspace.getState().closeProject();
  host.remove();
  document.body.replaceChildren();
});

describe('Datasets: re-filing one dataset', () => {
  it('File under a date says so and offers Undo, which puts the date back', async () => {
    h.move.mockResolvedValue({ error: null, stays: {}, moved: [{ id: 'walk-b', capture: null }] });
    rightClick('tree-row-walk-b');
    click('move-to-c1');
    await flush();
    expect(h.move).toHaveBeenCalledWith(['walk-b'], 'c1');
    expect(q('date-note')?.textContent).toContain('Moved Walk b to');
    expect(q('date-note')?.textContent).toContain('12 Oct 2026');
    click('date-undo');
    expect(h.undo).toHaveBeenCalledWith([{ id: 'walk-b', capture: null }], 'c1');
    expect(q('date-note')).toBeNull();
  });

  it('a move from the Selection card announces itself the same way', () => {
    act(() => {
      announceDateMove([{ id: 'walk-b', capture: null }], 'c1');
    });
    expect(q('date-note')?.textContent).toContain('Moved Walk b to');
    click('date-undo');
    expect(h.undo).toHaveBeenCalledWith([{ id: 'walk-b', capture: null }], 'c1');
  });

  it('taking the date off says the layer no longer belongs to one', () => {
    act(() => {
      announceDateMove([{ id: 'walk-b', capture: 'c2' }], null);
    });
    expect(q('date-note')?.textContent).toContain('Walk b no longer belongs to a date');
    expect(q('date-undo')).not.toBeNull();
  });
});
