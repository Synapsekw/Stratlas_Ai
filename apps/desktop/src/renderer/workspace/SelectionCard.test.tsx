// @vitest-environment jsdom
import type * as Engine from '@aio/engine';
import type { ComponentInfo } from '@aio/engine';
import type { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const light: ComponentInfo = {
  id: 'light-l1-2',
  name: 'Warning light 2',
  category: 'Lighting',
  description: 'Red lens facing south.',
  tag: 'WL-2',
  basis: 'measured',
  status: 'accepted',
  parent: 'flue-1',
  unobserved: ['back', 'top'],
  quality: {
    params: { height: 'measured', lensDiameter: 'inferred', colour: 'user' },
    residualM: 0.012,
    coverage: 0.3,
  },
  dimensions: {
    height: { value: 32.4, unit: 'm' },
    size: { value: [1.2, 0.8], unit: 'm' },
    yawDeg: { value: 270, unit: 'deg' },
  },
};
const flue: ComponentInfo = { id: 'flue-1', name: 'Flue 1', category: 'Structure' };
import { fakeComponentStage } from './__fixtures__/fakeComponentStage';

const stage = fakeComponentStage({ chimney: [flue, light] });
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  getActiveStage: () => stage,
}));

const { SelectionCard, firstPoint } = await import('./SelectionCard');

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = (georef?: unknown) =>
  ({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32640 },
    origin: [0, 0, 0],
    captures: [],
    layers: [
      {
        kind: 'mesh',
        id: 'chimney',
        name: 'Chimney model',
        visible: true,
        src: { path: 'models/chimney.glb' },
        transform: I,
        ...(georef ? { georef } : {}),
      },
    ],
    severityModels: [],
    classCatalogues: [],
  }) as unknown as ProjectManifest;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  stage.reset();
  workspace.getState().openProject({ id: 'p', root: '/p', manifest: manifest() });
  root = createRoot(host);
  act(() => root?.render(<SelectionCard />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const selectLight = () => {
  act(() => {
    workspace.getState().select({ kind: 'asset', id: 'light-l1-2', layer: 'chimney' });
  });
};

describe('SelectionCard for an engineering component', () => {
  it('shows the record: id, tag, basis per value, fit, coverage in words, unseen sides', () => {
    selectLight();
    const card = q('component-card');
    const text = card?.textContent ?? '';
    expect(text).toContain('Warning light 2');
    expect(text).toContain('Lighting');
    expect(text).toContain('Red lens facing south.');
    expect(q('component-id')?.textContent).toBe('light-l1-2');
    expect(text).toContain('WL-2');
    expect(q('component-basis')?.textContent).toBe('Measured');
    const values = [...host.querySelectorAll('[data-testid="component-value"]')].map(
      (v) => v.textContent,
    );
    expect(values).toEqual([
      'Height32.4 m · Measured',
      'Size1.2 × 0.8 m',
      'Yaw270°',
      'Lens diameterInferred',
      'ColourSet by you',
    ]);
    expect(q('component-scale')).toBeNull();
    expect(text).toContain('Within 12 mm of the measured points');
    expect(text).toContain('Sparsely covered by the evidence');
    expect(text).not.toMatch(/\d+ ?%/);
    expect(text).toContain('Back, Top');
    expect(text).toContain('Flue 1');
    expect(text).not.toMatch(/[–—]/);
  });

  it('focuses the component through the selection framing and clears', () => {
    selectLight();
    const flyTo = vi.spyOn(workspace.getState(), 'flyTo');
    act(() => q('component-focus')?.click());
    expect(flyTo).toHaveBeenCalledWith({
      kind: 'selection',
      selection: { kind: 'asset', id: 'light-l1-2', layer: 'chimney' },
    });
    flyTo.mockRestore();
    act(() => q('component-clear')?.click());
    expect(workspace.getState().selection).toBeNull();
  });

  it('clears the selection on Escape in the card', () => {
    selectLight();
    const card = q('component-card');
    act(() => {
      card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(workspace.getState().selection).toBeNull();
  });

  it('labels lengths provisional, never measured metres, while the scale is provisional', () => {
    act(() => {
      workspace.getState().openProject({
        id: 'p',
        root: '/p',
        manifest: manifest({ scale: { factor: 1, status: 'provisional' } }),
      });
    });
    selectLight();
    const values = [...host.querySelectorAll('[data-testid="component-value"]')].map(
      (v) => v.textContent,
    );
    expect(values[0]).toBe('Height32.4 m (provisional scale) · Measured, provisional scale');
    // an angle does not depend on the scale
    expect(values[2]).toBe('Yaw270°');
    expect(q('component-scale')?.textContent).toBe('Provisional: lengths are not yet true metres');
    expect(q('component-basis')?.textContent).toBe('Measured, provisional scale');
  });

  it('says when the engine hides the component and shows it again', () => {
    stage.setNodeVisible('chimney', 'light-l1-2', false);
    selectLight();
    expect(q('component-card')?.textContent).toContain('Hidden in the 3D view');
    act(() => q('component-show')?.click());
    expect(stage.setNodeVisible).toHaveBeenLastCalledWith('chimney', 'light-l1-2', true);
    expect(q('component-card')?.textContent).not.toContain('Hidden in the 3D view');
  });

  it('keeps the list, its search and the focused row from the layer card to a component', () => {
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'chimney' });
    });
    const search = q('component-search') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'light',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const rowButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="component-row"][data-id="light-l1-2"] .cl-name',
    );
    act(() => {
      rowButton?.focus();
      rowButton?.click();
    });
    expect(q('component-card')).not.toBeNull();
    expect(q('component-search')).toBe(search);
    expect(search.value).toBe('light');
    expect(document.activeElement).toBe(rowButton);
  });

  it('lists the components when the engineering layer itself is selected', () => {
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'chimney' });
    });
    expect(q('component-list')).not.toBeNull();
  });

  it('offers Place model on the card of a model layer', async () => {
    const { builder } = await import('../builder/state');
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'chimney' });
    });
    act(() => q('layer-place-model')?.click());
    expect(builder.getState().align).toEqual({ kind: 'place', layerId: 'chimney' });
    builder.getState().stopAlign();
  });

  it('follows a rebuilt layer: new components and changed values show at once', () => {
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'chimney' });
    });
    const rows = () =>
      [...host.querySelectorAll('[data-testid="component-row"]')].map((r) =>
        r.getAttribute('data-id'),
      );
    expect(rows()).toEqual(['light-l1-2', 'flue-1']);
    const flue2: ComponentInfo = { id: 'flue-2', name: 'Flue 2', category: 'Structure' };
    act(() => {
      stage.load('chimney', [flue, flue2, light]);
    });
    expect(rows()).toEqual(['light-l1-2', 'flue-1', 'flue-2']);
    // same ids, a corrected value: the card shows the new one
    selectLight();
    act(() => {
      stage.load('chimney', [
        flue,
        flue2,
        { ...light, dimensions: { ...light.dimensions, height: { value: 25, unit: 'm' } } },
      ]);
    });
    const values = [...host.querySelectorAll('[data-testid="component-value"]')].map(
      (v) => v.textContent,
    );
    expect(values[0]).toBe('Height25 m · Measured');
  });

  it('puts the card and a long list in one scrolling host', () => {
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'chimney' });
    });
    const scroller = host.querySelector('[data-testid="selection-scroll"]');
    expect(scroller).not.toBeNull();
    expect(scroller?.querySelector('[data-testid="component-list"]')).toBeInstanceOf(HTMLElement);
    expect(scroller?.querySelector('section.ctx')).toBeInstanceOf(HTMLElement);
  });

  it('leaves Place model out of a read-only package', async () => {
    const { setAnnotateReadOnly } = await import('@aio/annotate');
    act(() => {
      setAnnotateReadOnly(true);
      workspace.getState().select({ kind: 'layer', id: 'chimney' });
    });
    expect(q('layer-place-model')).toBeNull();
    act(() => {
      setAnnotateReadOnly(false);
    });
    expect(q('layer-place-model')).not.toBeNull();
  });

  it('keeps the plain asset card for a node without a component record', () => {
    act(() => {
      workspace.getState().select({ kind: 'asset', id: 'Pipe_3', layer: 'chimney' });
    });
    expect(q('component-card')).toBeNull();
    expect(host.textContent).toContain('Pipe_3');
  });
});

describe('firstPoint', () => {
  it('reads an issue pin where its lined-up date is drawn', () => {
    const issue = {
      sightings: [{ on: 'mesh', layer: 'chimney', geom: { type: 'spoint', p: [10, 4, 20] } }],
    } as unknown as Issue;
    expect(firstPoint(issue)).toEqual([10, 4, 20]);
    expect(firstPoint(issue, () => ({ eastM: 2, northM: 1 }))).toEqual([12, 4, 19]);
  });
});
