// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogue, makeIssue, tankModel } from '../testing';
import { pinDisplay } from '../tools/pinDisplay';
import { PinControls } from './PinControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel],
  classCatalogues: [catalogue],
};

function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => {
    root.render(<PinControls />);
  });
  return {
    el,
    button: (name: string) =>
      [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      el.remove();
    },
  };
}

describe('PinControls', () => {
  afterEach(() => {
    workspace.getState().closeProject();
    pinDisplay.getState().setFilter('all');
    pinDisplay.getState().setHeat(false);
  });

  it('offers all, each severity threshold of the model and off', () => {
    workspace.getState().openProject({ id: 'p', root: 'r', manifest }, [makeIssue()]);
    const ui = mount();
    const labels = [...ui.el.querySelectorAll('[role="group"] button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'All pins',
      'Severity 2 and above',
      'Severity 3 and above',
      'Severity 4 and above',
      'Severity 5 and above',
      'No pins',
    ]);
    ui.unmount();
  });

  it('sets the pin filter and the heat map', () => {
    workspace.getState().openProject({ id: 'p', root: 'r', manifest }, [makeIssue()]);
    const ui = mount();
    act(() => {
      ui.button('Severity 4 and above')?.click();
    });
    expect(pinDisplay.getState().filter).toBe(4);
    expect(ui.button('Severity 4 and above')?.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      ui.button('No pins')?.click();
    });
    expect(pinDisplay.getState().filter).toBe('off');
    const heat = ui.el.querySelector<HTMLInputElement>('input[type="checkbox"]');
    act(() => {
      heat?.click();
    });
    expect(pinDisplay.getState().heat).toBe(true);
    ui.unmount();
  });
});
