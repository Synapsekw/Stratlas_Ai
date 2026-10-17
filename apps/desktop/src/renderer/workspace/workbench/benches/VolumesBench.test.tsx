// @vitest-environment jsdom
import { volumetric } from '@aio/volumetric';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VolumetricModule from '@aio/volumetric';
import { WIDE_TAB_PX, workbench } from '../workbenchStore';
import { VolumesBench } from './VolumesBench';

// the inventory is the package's: here only that it sits under the controls
vi.mock('@aio/volumetric', async (importOriginal) => ({
  ...(await importOriginal<typeof VolumetricModule>()),
  VolumesPanel: () => <p data-testid="inventory">inventory</p>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<VolumesBench />);
  });
};
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name);
const click = (el: Element | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  volumetric.setState({
    status: 'ready',
    epoch: 'e1',
    surface: 'photo',
    swipe: false,
    body: 'lift',
    file: {
      captures: [
        { epoch: 'e1', label: 'Jan 2026' },
        { epoch: 'e2', label: 'Feb 2026' },
      ],
    } as never,
  });
  workbench.getState().reset();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  volumetric.setState({ status: 'idle', file: null });
});

describe('VolumesBench', () => {
  it('keeps the switches and their names above the inventory', () => {
    render();
    const names = (label: string) =>
      [
        ...(host
          .querySelector(`[role="group"][aria-label="${label}"]`)
          ?.querySelectorAll('button') ?? []),
      ].map((b) => b.textContent);
    expect(names('Survey date')).toEqual(['Jan', 'Feb', 'Swipe']);
    expect(names('Surface colours')).toEqual(['Photo', 'Elevation', 'Cut / fill']);
    expect(names('Volume bodies')).toEqual(['Lifted', 'In place', 'Hidden']);
    expect(button('Section line between the surveys')).toBeDefined();
    // the controls come before the inventory
    const controls = host.querySelector('.vol-bench-controls');
    const inventory = host.querySelector('[data-testid="inventory"]');
    expect(controls?.compareDocumentPosition(inventory as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('Cut / fill sets the change surface; a date puts the photo back', () => {
    render();
    click(button('Cut / fill'));
    expect(volumetric.getState().surface).toBe('change');
    expect(button('Cut / fill')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Feb'));
    expect(volumetric.getState().surface).toBe('photo');
    expect(volumetric.getState().epoch).toBe('e2');
  });

  it('sets the bodies and starts the section line', () => {
    render();
    click(button('Hidden'));
    expect(volumetric.getState().body).toBe('off');
    click(button('Section line between the surveys'));
    expect(volumetric.getState().section.mode).toBe('picking');
    expect(button('Section line between the surveys')?.getAttribute('aria-pressed')).toBe('true');
    click(button('Section line between the surveys'));
    expect(volumetric.getState().section.mode).toBe('idle');
  });

  it('is the fixed Volumes tab, which opens at least 470 px wide', () => {
    const tab = workbench.getState().tabs.find((t) => t.id === 'volumes');
    expect(tab).toMatchObject({ fixed: true, minWidth: 470 });
    expect(WIDE_TAB_PX).toBe(470);
  });
});
