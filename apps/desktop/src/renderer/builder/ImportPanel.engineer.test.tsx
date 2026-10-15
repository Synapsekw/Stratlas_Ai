// @vitest-environment jsdom
import type { ImportItem, PackageInfo, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { ImportLayer } = await import('./ImportPanel');
const { engineeringAction } = await import('./importSummary');
const { builder } = await import('./state');
const { engineerUi } = await import('../engineer/ui');
const { engineerHost } = await import('../engineer/host');
const { shell } = await import('../shell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'pointcloud',
      id: 'cloud-scan',
      name: 'scan',
      visible: true,
      src: { path: 'clouds/scan.copc.laz' },
      format: 'copc',
    },
    {
      kind: 'vector',
      id: 'vec-plan',
      name: 'plan',
      visible: true,
      src: { path: 'vectors/plan.geojson' },
      format: 'geojson',
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

const laz = {
  file: 'scan.laz',
  kind: 'pointcloud',
  status: 'imported',
  layerId: 'cloud-scan',
} as ImportItem;
const plan = {
  file: 'plan.geojson',
  kind: 'unknown',
  status: 'imported',
  layerId: 'vec-plan',
} as ImportItem;
const items: ImportItem[] = [laz, plan];

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  workspace.getState().openProject({ id: 'p', root: 'E:/p', manifest });
  engineerUi.setState({ open: false, preselect: [] });
  builder.setState({ importResult: { items, error: null }, importing: null });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  builder.setState({ importResult: null });
  shell.setState({ pkg: null });
  workspace.getState().closeProject();
});

const render = () => {
  act(() => {
    root = createRoot(host);
    root.render(<ImportLayer />);
  });
};
const buttons = () => [
  ...host.querySelectorAll<HTMLButtonElement>('[data-testid="import-create-engineering"]'),
];

describe('Create engineering model after an import', () => {
  it('is a structured action on point clouds, models and photos, not on a vector', () => {
    expect(engineeringAction(laz, manifest.layers)).toEqual({
      kind: 'engineer',
      layerId: 'cloud-scan',
    });
    expect(engineeringAction(plan, manifest.layers)).toBeNull();
    expect(engineeringAction({ ...laz, status: 'error' }, manifest.layers)).toBeNull();
  });

  it('shows a button on the LAZ row that opens the setup with the cloud chosen, starting nothing', () => {
    render();
    expect(buttons()).toHaveLength(1);
    expect(buttons()[0]?.textContent).toContain('Create engineering model');
    act(() => buttons()[0]?.click());
    expect(engineerUi.getState()).toMatchObject({ open: true, preselect: ['cloud-scan'] });
    // only the setup opened: no run exists, nothing is measured or sent
    expect(engineerHost.getState().store?.getState().run ?? null).toBeNull();
  });

  it('is not offered in a read-only package', () => {
    shell.setState({ pkg: { header: { readOnly: true, exports: [] } } as unknown as PackageInfo });
    render();
    expect(buttons()).toHaveLength(0);
  });
});
