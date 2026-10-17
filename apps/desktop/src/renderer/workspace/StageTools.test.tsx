// @vitest-environment jsdom
import { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup } from '../pointcloud/cleanupStore';
import { CloudTools } from './tools/cloud';
import { ViewTools } from './tools/view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('ViewTools', () => {
  it('centres on the project beside Whole site, with its own key', () => {
    root = createRoot(host);
    act(() => root?.render(<ViewTools stage={null} map={false} />));
    const labels = [...host.querySelectorAll('button.tool')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels.slice(0, 2)).toEqual(['Whole site', 'Centre on project']);
    const centre = host.querySelector<HTMLButtonElement>('[aria-label="Centre on project"]');
    expect(centre?.getAttribute('aria-keyshortcuts')).toBe('G');
    act(() => centre?.click());
    expect(workspace.getState().camera?.target).toEqual({ kind: 'site' });
  });
});

describe('CloudTools', () => {
  it('opens and closes the Clean up panel from the point cloud group', () => {
    workspace.getState().openProject({
      id: 'p',
      root: 'D:/p',
      manifest: ProjectManifest.parse({
        schema: 'aio.project/1',
        id: 'p',
        name: 'P',
        customer: 'E2E',
        site: 'Synthetic site',
        origin: [500000, 3200000, 0],
        crs: { epsg: 32639 },
        captures: [],
        layers: [
          {
            kind: 'pointcloud',
            id: 'a',
            name: 'Scan',
            src: { path: 'clouds/a.copc.laz' },
            format: 'copc',
          },
        ],
        severityModels: [],
        classCatalogues: [],
      }),
    });
    cleanup.closePanel();
    root = createRoot(host);
    act(() => root?.render(<CloudTools />));
    const tool = host.querySelector<HTMLButtonElement>('[data-testid="cleanup-tool"]');
    expect(tool?.getAttribute('aria-label')).toBe('Clean up the point cloud');
    expect(tool?.getAttribute('aria-pressed')).toBe('false');
    act(() => tool?.click());
    expect(cleanup.store.getState().panelOpen).toBe(true);
    expect(tool?.getAttribute('aria-pressed')).toBe('true');
    act(() => tool?.click());
    expect(cleanup.store.getState().panelOpen).toBe(false);
  });
});
