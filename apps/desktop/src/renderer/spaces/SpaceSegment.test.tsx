// @vitest-environment jsdom
import { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeSpace } from './activeSpace';
import { SpaceSegment } from './SpaceSegment';
import { scopedManifest } from './spaceModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photos = (id: string, space?: string) => ({
  kind: 'photos' as const,
  id,
  name: id,
  items: [],
  ...(space ? { space } : {}),
});
const localSpace = (id: string) => ({
  id,
  name: `Tank ${id}`,
  crs: { local: 'flyability' },
  origin: [0, 0, 0],
  source: { kind: 'flyability' as const, inspectionId: 'insp-1' },
});
const base = {
  schema: 'aio.project/1' as const,
  id: 'p1',
  name: 'Tank survey',
  crs: { epsg: 32636 },
  origin: [10, 20, 30] as [number, number, number],
  captures: [],
  severityModels: [],
  classCatalogues: [],
};
const one = ProjectManifest.parse({ ...base, layers: [photos('l1')] });
const two = ProjectManifest.parse({
  ...base,
  layers: [photos('la', 's-a'), photos('lb', 's-b')],
  spaces: [localSpace('s-a'), localSpace('s-b')],
});

let host: HTMLDivElement;
let root: Root;
const open = (manifest: typeof one) => {
  workspace.setState({ project: { id: 'p1', root: 'x', manifest } } as never);
};
const render = () => {
  act(() => {
    root = createRoot(host);
    root.render(<SpaceSegment />);
  });
};
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  activeSpace().setState({ byProject: {} });
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
  workspace.setState({ project: null } as never);
});

describe('SpaceSegment', () => {
  it('the segment is hidden with one space', () => {
    open(one);
    render();
    expect(q('crumb-space')).toBeNull();
  });

  it('picking a space sets it for the project', () => {
    open(two);
    render();
    const trigger = q('crumb-space');
    expect(trigger?.textContent).toContain('Tank s-a');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    act(() => {
      trigger?.click();
    });
    const item = [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((e) =>
      e.textContent.includes('Tank s-b'),
    );
    expect(item).toBeTruthy();
    act(() => {
      item?.click();
    });
    expect(activeSpace().getState().byProject.p1).toBe('s-b');
    expect(q('crumb-space')?.textContent).toContain('Tank s-b');
  });

  it('the Layers column lists only the active space', () => {
    expect(scopedManifest(two, 's-b').layers.map((l) => l.id)).toEqual(['lb']);
    expect(scopedManifest(one, 'main')).toBe(one);
  });
});
