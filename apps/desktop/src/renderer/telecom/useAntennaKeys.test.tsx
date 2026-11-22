// @vitest-environment jsdom
/** The review keys of the selected antenna: what Delete does, and where it is left alone. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antennaDeleteStore } from './antennaDelete';
import { antennaStore } from './antennaStore';
import { useAntennaKeys } from './useAntennaKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  return {
    jobs: createStore<{ jobs: unknown[] }>()(() => ({ jobs: [] })),
    bridge: {
      call: vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'telecom:writeAntennas'
            ? { ok: true, value: { ok: true } }
            : { ok: false, error: 'unexpected' },
        ),
      ),
    },
  };
});

const contract = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../../../packages/schema/src/__fixtures__/antennas-contract.json',
    ),
    'utf8',
  ),
) as { example: unknown };

function Probe({ on }: { on: boolean }) {
  useAntennaKeys(on);
  return (
    <div>
      <ul role="tree" data-testid="datasets-tree" tabIndex={0} />
      <ul className="pl-rows" data-testid="issue-rows" role="none">
        <li>
          <button type="button" data-testid="issue-row" />
        </li>
      </ul>
      <ul className="pl-rows" role="tree" data-antenna-tree="" data-testid="antenna-rows">
        <li role="none">
          <button type="button" role="treeitem" data-testid="antenna-row" />
        </li>
      </ul>
      <input data-testid="field" />
      <button type="button" data-testid="plain" />
    </div>
  );
}

let host: HTMLElement;
let root: Root;
const q = (id: string): Element => {
  const el = host.querySelector(`[data-testid="${id}"]`);
  if (!el) throw new Error(id);
  return el;
};
const press = (el: Element, key: string) => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  antennaDeleteStore.setState({ ask: null, busy: false });
  antennaStore.setState({
    ...antennaStore.getInitialState(),
    projectId: 'p1',
    root: 'C:/p1',
    status: 'ready',
    readOnly: false,
    file: AntennasFile.parse(structuredClone(contract.example)),
    selected: 'ant-a3',
  });
  act(() => {
    root.render(<Probe on />);
  });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('useAntennaKeys', () => {
  it('Delete asks to delete the selected unit', () => {
    press(q('plain'), 'Delete');
    expect(antennaDeleteStore.getState().ask?.ids).toEqual(['ant-a3']);
  });

  it('Delete in the Datasets tree is left to the tree', () => {
    press(q('datasets-tree'), 'Delete');
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });

  it('Delete on a row of the antenna list asks', () => {
    press(q('antenna-row'), 'Delete');
    expect(antennaDeleteStore.getState().ask?.ids).toEqual(['ant-a3']);
  });

  it('Delete on a row of another group is left to that group', () => {
    press(q('issue-row'), 'Delete');
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });

  it('Delete in a field is typing', () => {
    press(q('field'), 'Delete');
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });

  it('Escape still clears the selection', () => {
    press(q('plain'), 'Escape');
    expect(antennaStore.getState().selected).toBeNull();
  });

  it('does nothing while disabled', () => {
    act(() => {
      root.render(<Probe on={false} />);
    });
    press(q('plain'), 'Delete');
    expect(antennaDeleteStore.getState().ask).toBeNull();
  });

  it('A on an accepted unit sets it back to Draft and a second A accepts it, before the stage sees it', async () => {
    const stage = vi.fn();
    window.addEventListener('keydown', stage);
    const status = () => antennaStore.getState().file?.units.find((u) => u.id === 'ant-a3')?.status;
    // the unit is accepted already: A sets it back to Draft, a second A accepts it again
    expect(status()).toBe('accepted');
    press(q('plain'), 'a');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(status()).toBe('draft');
    press(q('plain'), 'a');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(status()).toBe('accepted');
    press(q('plain'), 'r');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(status()).toBe('rejected');
    window.removeEventListener('keydown', stage);
    // the stage's A (Annotate) never fired
    expect(stage).not.toHaveBeenCalled();
  });

  it('Shift+A or Ctrl+A is not a review key', async () => {
    const before = antennaStore.getState().file?.units.find((u) => u.id === 'ant-a3')?.status;
    act(() => {
      q('plain').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'A', shiftKey: true, bubbles: true, cancelable: true }),
      );
      q('plain').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(antennaStore.getState().file?.units.find((u) => u.id === 'ant-a3')?.status).toBe(before);
  });
});
