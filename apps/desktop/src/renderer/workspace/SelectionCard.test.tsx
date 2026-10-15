// @vitest-environment jsdom
import type * as Engine from '@aio/engine';
import type { ComponentInfo } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
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
};
const flue: ComponentInfo = { id: 'flue-1', name: 'Flue 1', category: 'Structure' };
const stage = {
  components: vi.fn((layerId: string) => (layerId === 'chimney' ? [flue, light] : [])),
  setNodeVisible: vi.fn(() => true),
};
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  getActiveStage: () => stage,
}));

const { SelectionCard } = await import('./SelectionCard');
const { componentVisibility } = await import('./ComponentList');

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
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
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as ProjectManifest;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  componentVisibility.setState({ hidden: {} });
  workspace.getState().openProject({ id: 'p', root: '/p', manifest });
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
    expect(values).toEqual(['HeightMeasured', 'Lens diameterInferred', 'ColourSet by you']);
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

  it('says when the component is hidden and shows it again', () => {
    componentVisibility.setState({ hidden: { chimney: ['light-l1-2'] } });
    selectLight();
    expect(q('component-card')?.textContent).toContain('Hidden in the 3D view');
    act(() => q('component-show')?.click());
    expect(stage.setNodeVisible).toHaveBeenCalledWith('chimney', 'light-l1-2', true);
    expect(componentVisibility.getState().hidden.chimney).toEqual([]);
  });

  it('lists the components when the engineering layer itself is selected', () => {
    act(() => {
      workspace.getState().select({ kind: 'layer', id: 'chimney' });
    });
    expect(q('component-list')).not.toBeNull();
  });

  it('keeps the plain asset card for a node without a component record', () => {
    act(() => {
      workspace.getState().select({ kind: 'asset', id: 'Pipe_3', layer: 'chimney' });
    });
    expect(q('component-card')).toBeNull();
    expect(host.textContent).toContain('Pipe_3');
  });
});
