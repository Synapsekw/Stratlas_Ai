// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineerLayer, engineerUi } from './EngineerLayer';
import { ENGINEERING_MODEL_UI } from './flags';

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
  root = undefined;
  host.remove();
  engineerUi.setState({ open: false });
});

describe('EngineerLayer', () => {
  it('stays hidden while the engineering model UI is off, even when asked to open', () => {
    expect(ENGINEERING_MODEL_UI).toBe(false);
    act(() => {
      engineerUi.getState().show();
    });
    act(() => root?.render(<EngineerLayer />));
    expect(host.innerHTML).toBe('');
  });
});
