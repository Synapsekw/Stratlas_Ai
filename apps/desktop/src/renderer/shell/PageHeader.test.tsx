// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('PageHeader', () => {
  it('renders the title and the actions', () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <PageHeader
          heading="nav.issues"
          actions={
            <button type="button" data-testid="act">
              Export
            </button>
          }
        />,
      );
    });
    const head = host.querySelector('.pg-head');
    expect(head?.querySelector('.pg-title')?.textContent).toBe('Issues');
    expect(head?.querySelector('[data-testid="act"]')?.textContent).toBe('Export');
  });
});
