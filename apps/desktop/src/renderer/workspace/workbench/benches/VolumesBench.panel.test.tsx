// @vitest-environment jsdom
import { volumetric } from '@aio/volumetric';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { VolumesBench } from './VolumesBench';

// the bench with the package's real inventory under its switches (VolumesBench.test.tsx stubs it)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  volumetric.setState({
    status: 'ready',
    epoch: 'e1',
    surface: 'photo',
    swipe: false,
    selected: null,
    piles: [],
    file: {
      captures: [
        { epoch: 'e1', date: '2026-01-12', label: '12 Jan 2026' },
        { epoch: 'e2', date: '2026-02-09', label: '9 Feb 2026' },
      ],
      bases: [],
      pileChange: { cut: 0, fill: 0, net: 0 },
    } as never,
  });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle', file: null });
});

it('shows one Survey date switch: the inventory below has none of its own', () => {
  root = createRoot(host);
  act(() => {
    root?.render(<VolumesBench />);
  });
  expect(host.querySelector('[data-testid="vol-register"]')).not.toBeNull();
  expect(host.querySelectorAll('[role="group"][aria-label="Survey date"]')).toHaveLength(1);
});
