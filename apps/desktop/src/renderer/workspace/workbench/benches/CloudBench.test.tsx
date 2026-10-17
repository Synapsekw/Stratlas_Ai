// @vitest-environment jsdom
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '../../../pointcloud/cleanupStore';
import { qaStore } from '../../../survey/qaStore';
import { threeDates } from '../../__fixtures__/threeDates';
import { sectionStore } from '../sectionState';
import { CloudBench } from './CloudBench';

vi.mock('@aio/pointcloud', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  PointCloudControls: () => <p>controls</p>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const section = (id: string) => q(`[data-testid="wb-section-${id}"]`);

const cloud = (id: string, name: string) => ({
  kind: 'pointcloud',
  id,
  name,
  visible: true,
  src: { path: `${id}.copc.laz` },
  format: 'copc',
});
const withClouds = {
  ...threeDates,
  layers: [...threeDates.layers, cloud('scan-a', 'Scan A'), cloud('scan-b', 'Scan B')],
} as unknown as typeof threeDates;

const render = () => {
  root = createRoot(host);
  act(() => root?.render(<CloudBench />));
};

beforeEach(() => {
  localStorage.clear();
  sectionStore.setState({ byBench: {} });
  cleanup.closePanel();
  qaStore.setState({ panel: null });
  workspace.getState().openProject({ id: 'pc', root: '/pc', manifest: withClouds });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  workspace.getState().closeProject();
});

describe('CloudBench', () => {
  it('has Show, Colour, Clouds, Clean up and Survey QA sections', () => {
    render();
    for (const id of ['cloud-show', 'cloud-colour', 'cloud-clouds', 'cloud-cleanup', 'cloud-qa'])
      expect(section(id), id).not.toBeNull();
    // the controls keep the testid the specs find them by
    expect(q('[data-testid="cloud-panel"]')?.textContent).toContain('controls');
  });

  it('shows and hides every cloud with the switch, and each with its eye', () => {
    render();
    const all = q('[data-testid="cloud-show-all"]');
    expect(all?.getAttribute('aria-pressed')).toBe('true');
    act(() => all?.click());
    expect(workspace.getState().hidden['scan-a']).toBe(true);
    expect(workspace.getState().hidden['scan-b']).toBe(true);
    act(() => q('[data-testid="cloud-eye-scan-a"]')?.click());
    expect(workspace.getState().hidden['scan-a']).toBeUndefined();
    expect(workspace.getState().hidden['scan-b']).toBe(true);
  });

  it('lists the clouds with a count', () => {
    render();
    expect(section('cloud-clouds')?.textContent).toContain('Scan A');
    expect(section('cloud-clouds')?.textContent).toContain('Scan B');
  });

  it('Clean up opens the panel (its tab) and the button closes it again', () => {
    render();
    act(() => q('[data-testid="cleanup-tool"]')?.click());
    expect(cleanup.store.getState().panelOpen).toBe(true);
    act(() => q('[data-testid="cleanup-tool"]')?.click());
    expect(cleanup.store.getState().panelOpen).toBe(false);
  });

  it('Survey QA opens the check panel', () => {
    render();
    act(() => q('[data-testid="cloud-qa-open"]')?.click());
    expect(qaStore.getState().panel).toBe('qa');
  });

  it('says there is no point cloud when the project has none', () => {
    workspace.getState().openProject({ id: 'p3', root: '/p3', manifest: threeDates });
    render();
    expect(host.textContent).toContain('No point clouds');
    expect(section('cloud-show')).toBeNull();
  });
});
