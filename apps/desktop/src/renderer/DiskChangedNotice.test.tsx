// @vitest-environment jsdom
import { Icon } from '@aio/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { diskChanged } from './diskChanged';
import { DiskChangedNotice } from './DiskChangedNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  diskChanged.getState().dismiss();
});

describe('error toast', () => {
  it('leads with the error icon, since the stripe is gone', () => {
    host = document.createElement('div');
    document.body.append(host);
    diskChanged.getState().report('x was changed by someone else since you opened it.');
    root = createRoot(host);
    act(() => root?.render(<DiskChangedNotice />));
    const toast = host.querySelector('.toast.error');
    const lead = toast?.querySelector('.toast-h > svg.i');
    expect(lead).not.toBeNull();
    expect(lead?.innerHTML).toBe(
      new DOMParser()
        .parseFromString(renderToStaticMarkup(<Icon name="warn" />), 'text/html')
        .querySelector('svg')?.innerHTML,
    );
  });
});
