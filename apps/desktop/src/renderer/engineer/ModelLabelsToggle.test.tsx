// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ModelLabelsToggle } from './ModelLabelsToggle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});

it('toggles the controlled label state with a clear action and pressed state', () => {
  function Harness() {
    const [on, setOn] = useState(true);
    return <ModelLabelsToggle on={on} onChange={setOn} />;
  }
  act(() => root?.render(<Harness />));
  const button = host.querySelector('button');
  expect(button).not.toBeNull();
  expect(button?.textContent).toBe('Labels on');
  expect(button?.getAttribute('aria-pressed')).toBe('true');
  expect(button?.getAttribute('aria-label')).toBe('Hide all model labels');
  act(() => button?.click());
  expect(button?.textContent).toBe('Labels off');
  expect(button?.getAttribute('aria-pressed')).toBe('false');
  expect(button?.getAttribute('aria-label')).toBe('Show all model labels');
  act(() => button?.click());
  expect(button?.textContent).toBe('Labels on');
  expect(button?.getAttribute('aria-pressed')).toBe('true');
});
