// @vitest-environment jsdom
import { pinDisplay } from '@aio/annotate';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shell } from '../../../shell';
import { threeDates } from '../../__fixtures__/threeDates';
import { sectionStore } from '../sectionState';
import { DisplayBench } from './DisplayBench';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const section = (id: string) => q(`[data-testid="wb-section-${id}"]`);
const open = (id: string) => section(id)?.getAttribute('data-open');

const render = () => {
  root = createRoot(host);
  act(() => root?.render(<DisplayBench />));
};

beforeEach(() => {
  // the street map's basemap probe draws to a canvas; jsdom has none
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  shell.getState().setStageMode('3d');
  shell.getState().setLabelMode('key');
  pinDisplay.getState().setFilter('all');
  workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
  vi.restoreAllMocks();
});

describe('DisplayBench', () => {
  it('has Labels, Pins and Layers sections, with Labels and Pins open', () => {
    render();
    expect(open('display-labels')).toBe('true');
    expect(open('display-pins')).toBe('true');
    expect(open('display-layers')).toBe('false');
  });

  it('sets the label mode', () => {
    render();
    const off = q('[aria-label="Component labels"] button:first-child');
    act(() => off?.click());
    expect(shell.getState().labelMode).toBe('off');
  });

  it('hides Labels on the map, where the 3D view has none', () => {
    shell.getState().setStageMode('map');
    render();
    expect(section('display-labels')).toBeNull();
    expect(section('display-pins')).not.toBeNull();
  });

  it('lists layers by kind with an eye each, and only the kinds the project has', () => {
    render();
    expect(q('[data-testid="display-kind-mesh"]')).not.toBeNull();
    expect(q('[data-testid="display-kind-video"]')).not.toBeNull();
    // threeDates has no point cloud and no photos
    expect(q('[data-testid="display-kind-pointcloud"]')).toBeNull();
    expect(q('[data-testid="display-kind-photos"]')).toBeNull();
    const eye = q('[data-testid="display-kind-mesh"] button');
    expect(eye?.getAttribute('aria-pressed')).toBe('true');
    act(() => eye?.click());
    expect(workspace.getState().hidden['model-sep']).toBe(true);
    expect(q('[data-testid="display-kind-mesh"] button')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('says so when a project has no layers', () => {
    workspace.getState().openProject({
      id: 'p0',
      root: '/p0',
      manifest: { ...threeDates, layers: [] },
    });
    render();
    expect(section('display-layers')?.textContent).toContain('No layers yet');
  });

  it('turns the issue pins off and on', () => {
    render();
    act(() => q('[data-testid="display-pins-toggle"]')?.click());
    expect(pinDisplay.getState().filter).toBe('off');
    act(() => q('[data-testid="display-pins-toggle"]')?.click());
    expect(pinDisplay.getState().filter).not.toBe('off');
  });
});
