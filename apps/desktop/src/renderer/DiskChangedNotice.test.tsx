// @vitest-environment jsdom
import { clearToasts, Icon, ToastHost } from '@aio/ui';
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
  act(() => {
    clearToasts();
  });
});

describe('error toast', () => {
  it('shows on the toast host as an alert, led by the error icon', () => {
    host = document.createElement('div');
    document.body.append(host);
    diskChanged.getState().report('x was changed by someone else since you opened it.');
    root = createRoot(host);
    act(() =>
      root?.render(
        <>
          <DiskChangedNotice />
          <ToastHost placement="window" />
        </>,
      ),
    );
    const toast = host.querySelector('[role="alert"] [data-testid="disk-changed"]');
    expect(toast?.getAttribute('data-tone')).toBe('error');
    expect(toast?.textContent).toContain('x was changed by someone else since you opened it.');
    const lead = toast?.querySelector('svg.q-toast-icon');
    expect(lead).not.toBeNull();
    expect(lead?.innerHTML).toBe(
      new DOMParser()
        .parseFromString(renderToStaticMarkup(<Icon name="warn" />), 'text/html')
        .querySelector('svg')?.innerHTML,
    );
  });
});
