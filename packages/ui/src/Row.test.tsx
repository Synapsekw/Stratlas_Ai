// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Row } from './Row';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});
const render = (ui: ReactElement) => {
  act(() => {
    root.render(ui);
  });
};
function row(): HTMLElement {
  const el = host.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no row');
  return el;
}

describe('Row', () => {
  it('has class row, data-kind and the label', () => {
    render(<Row kind="tree" label="Orthophoto" />);
    expect(row().tagName).toBe('DIV');
    expect(row().classList.contains('row')).toBe(true);
    expect(row().getAttribute('data-kind')).toBe('tree');
    expect(row().querySelector('.row-label')?.textContent).toBe('Orthophoto');
    expect(row().hasAttribute('data-selected')).toBe(false);
  });

  it('sets data-selected and leaves aria to the caller', () => {
    render(<Row kind="nav" label="Scene" selected aria-current="page" />);
    expect(row().hasAttribute('data-selected')).toBe(true);
    expect(row().getAttribute('aria-current')).toBe('page');
    expect(row().hasAttribute('aria-selected')).toBe(false);
  });

  it('puts the count in .row-count and actions in .row-acts', () => {
    render(
      <Row kind="menu" label="Layers" count={12} actions={<button type="button">m</button>} />,
    );
    expect(row().querySelector('.row-count')?.textContent).toBe('12');
    expect(row().querySelector('.row-acts button')?.textContent).toBe('m');
  });

  it('renders the element named by as, and an icon', () => {
    render(<Row kind="palette" as="button" label="Go" icon="map" />);
    expect(row().tagName).toBe('BUTTON');
    expect(row().querySelector('svg')).not.toBeNull();
  });
});
