// @vitest-environment jsdom
import type { AntennasFile, AntennaUnit } from '@aio/schema';
import { clearToasts, ToastHost } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennaUndoStore, type AntennaUndo } from './antennaDelete';
import { antennaStore } from './antennaStore';
import { AntennaUndoNotice } from './AntennaUndoNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ writes: [] as AntennasFile[] }));

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: {
      call: vi.fn((channel: string, req: { file?: AntennasFile }) => {
        if (channel === 'telecom:writeAntennas' && req.file) {
          h.writes.push(req.file);
          return Promise.resolve({ ok: true, value: { ok: true } });
        }
        return Promise.resolve({ ok: false, error: 'unexpected' });
      }),
    },
  };
});

const unit = (id: string): AntennaUnit =>
  ({ id, name: id.toUpperCase() }) as unknown as AntennaUnit;
const fileOf = (units: AntennaUnit[]) =>
  ({ schema: 'aio.antennas/1', run: { id: 'run-1' }, units }) as unknown as AntennasFile;
const undoOf = (ids: string[], seq: number): AntennaUndo => ({
  projectId: 'p1',
  seq,
  removed: ids.map((id, index) => ({ unit: unit(id), index })),
  places: [],
});

let root: Root | undefined;
let host: HTMLElement;
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.writes = [];
  antennaStore.setState({
    ...antennaStore.getInitialState(),
    projectId: 'p1',
    root: '/p',
    status: 'ready',
    file: fileOf([unit('b')]),
  });
  antennaUndoStore.setState({ undo: [] });
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => {
    root?.render(
      <>
        <AntennaUndoNotice />
        <ToastHost placement="window" />
      </>,
    );
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  act(() => {
    clearToasts();
  });
});

describe('AntennaUndoNotice', () => {
  it('shows nothing until units are deleted', () => {
    expect(q('[data-testid="antenna-undo"]')).toBeNull();
  });

  it('names one deleted unit, and Undo writes it back at its place', async () => {
    act(() => {
      antennaUndoStore.setState({ undo: [undoOf(['a'], 1)] });
    });
    expect(q('[data-testid="antenna-undo"]')?.textContent).toContain('A deleted');
    act(() => {
      q('[data-testid="antenna-undo-button"]')?.click();
    });
    await settle();
    expect(h.writes.at(-1)?.units.map((u) => u.id)).toEqual(['a', 'b']);
    expect(q('[data-testid="antenna-undo"]')).toBeNull();
  });

  it('counts several units; Dismiss lets go of the undo', () => {
    act(() => {
      antennaUndoStore.setState({ undo: [undoOf(['a', 'c'], 1)] });
    });
    expect(q('[data-testid="antenna-undo"]')?.textContent).toContain('2 units deleted');
    act(() => {
      q('[data-testid="antenna-undo-dismiss"]')?.click();
    });
    expect(q('[data-testid="antenna-undo"]')).toBeNull();
    expect(antennaUndoStore.getState().undo).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it('shows nothing for another project’s delete', () => {
    act(() => {
      antennaUndoStore.setState({ undo: [{ ...undoOf(['a'], 1), projectId: 'p2' }] });
    });
    expect(q('[data-testid="antenna-undo"]')).toBeNull();
  });

  it('Undo is greyed with its reason while an antenna job runs', async () => {
    act(() => {
      antennaUndoStore.setState({ undo: [undoOf(['a'], 1)] });
      antennaStore.setState({ running: true });
    });
    const button = q('[data-testid="antenna-undo-button"]');
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      button?.click();
    });
    await settle();
    expect(h.writes).toEqual([]);
  });
});
