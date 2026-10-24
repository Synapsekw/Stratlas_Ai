// @vitest-environment jsdom
import { volumetric } from '@aio/volumetric';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { volumesPane } from '../../../survey/volumes/volumesPane';
import { VolumesBench } from './VolumesBench';

// the bench with its real panes and stores (VolumesBench.test.tsx stubs them), on a kit project
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
  volumesPane.setState({ pane: 'inventory' });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle', file: null });
});

it('has no kit switches of its own: the Show control and the notch carry them', () => {
  root = createRoot(host);
  act(() => {
    root?.render(<VolumesBench />);
  });
  expect(host.querySelector('[data-testid="volumes-view"]')).not.toBeNull();
  for (const label of ['Survey date', 'Surface colours', 'Volume bodies'])
    expect(host.querySelector(`[role="group"][aria-label="${label}"]`)).toBeNull();
  const names = [...host.querySelectorAll('button')].map((b) => b.textContent);
  expect(names).not.toContain('Section line between the surveys');
  expect(names).not.toContain('Swipe');
  // the three panes are there
  expect(
    [...host.querySelectorAll('[data-testid="volumes-segment"]')].map((b) => b.textContent),
  ).toEqual(['Inventory', 'Cut & fill', 'Materials']);
});
