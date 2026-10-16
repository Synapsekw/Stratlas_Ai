// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState';

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

describe('EmptyState', () => {
  it('renders a heading, the body and the action', () => {
    render(
      <EmptyState
        icon="media"
        title="No media yet"
        body={<span id="b">Import a flight.</span>}
        action={<button type="button">Import</button>}
      />,
    );
    expect(host.querySelector('h3')?.textContent).toBe('No media yet');
    expect(host.querySelector('.empty')).not.toBeNull();
    expect(host.querySelector('#b')?.textContent).toBe('Import a flight.');
    expect(host.querySelector('.empty-act button')?.textContent).toBe('Import');
    expect(host.querySelector('svg')).not.toBeNull();
  });

  it('omits what is not given', () => {
    render(<EmptyState title="Nothing" />);
    expect(host.querySelector('svg')).toBeNull();
    expect(host.querySelector('.empty-body')).toBeNull();
    expect(host.querySelector('.empty-act')).toBeNull();
  });
});
