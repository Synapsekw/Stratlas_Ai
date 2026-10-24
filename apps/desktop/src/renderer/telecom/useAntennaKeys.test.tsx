// @vitest-environment jsdom
/** The review keys of the selected antenna: what Delete does, and where it is left alone. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntennasFile } from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antennaDeleteStore } from './antennaDelete';
import { antennaStore } from './antennaStore';
import { useAntennaKeys } from './useAntennaKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});
