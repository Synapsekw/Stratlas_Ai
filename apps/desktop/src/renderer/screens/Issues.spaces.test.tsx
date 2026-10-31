// @vitest-environment jsdom
import { Issue, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the register itself is covered in @aio/annotate: here only the filter the screen hands it
const seen = vi.hoisted(() => ({ filter: undefined as ((i: Issue) => boolean) | undefined }));
vi.mock('@aio/annotate', async (load) => ({
  ...(await load<object>()),
  IssueRegister: ({ issueFilter }: { issueFilter?: (i: Issue) => boolean }) => {
    seen.filter = issueFilter;
    return <div data-testid="issue-register" />;
  },
}));

const { IssuesScreen } = await import('./Issues');
const { setActiveSpace } = await import('../spaces/activeSpace');

const photos = (id: string, space?: string) => ({
  kind: 'photos' as const,
  id,
  name: id,
  items: [],
  ...(space ? { space } : {}),
});
const base = {
  schema: 'aio.project/1' as const,
  id: 'p1',
  name: 'Tank survey',
  crs: { epsg: 32640 },
  origin: [10, 20, 30] as [number, number, number],
  captures: [],
  severityModels: [],
  classCatalogues: [],
};
const space = (id: string) => ({
  id,
  name: id,
  crs: { local: 'flyability' },
  origin: [0, 0, 0],
});
const issue = (id: string, layer: string): Issue =>
  Issue.parse({
    id,
    code: 'F01',
    classId: 'c',
    severityModelId: 'm',
    severity: 'uncertain',
    status: 'draft',
    title: id,
    note: '',
    author: 'a',
    createdAt: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    sightings: [{ on: 'mesh', layer, geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } }],
    source: 'human',
  });

let root: Root | undefined;
const render = (m: ProjectManifest) => {
  act(() => {
    workspace.getState().openProject({ id: 'p1', root: 'r', manifest: m });
  });
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => {
    root?.render(<IssuesScreen />);
  });
};
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  seen.filter = undefined;
  document.body.innerHTML = '';
  workspace.getState().closeProject();
});

describe('Issues screen and spaces', () => {
  it('with one space the filter lets every issue through', () => {
    // one listed space holding every layer: an issue on a layer that is gone falls to `main`,
    // which is not a space here, yet the list must still show it
    render(
      ProjectManifest.parse({
        ...base,
        layers: [photos('la', 's-a')],
        spaces: [space('s-a')],
      }),
    );
    const f = seen.filter;
    expect(f).toBeDefined();
    expect([issue('i1', 'la'), issue('i2', 'gone')].filter((i) => f?.(i))).toHaveLength(2);
  });

  it('with two spaces the filter keeps the active space only', () => {
    render(
      ProjectManifest.parse({
        ...base,
        layers: [photos('lm'), photos('la', 's-a')],
        spaces: [space('s-a')],
      }),
    );
    act(() => {
      setActiveSpace('p1', 's-a');
    });
    const all = [issue('i-main', 'lm'), issue('i-in', 'la'), issue('i-none', 'gone')];
    expect(all.filter((i) => seen.filter?.(i)).map((i) => i.id)).toEqual(['i-in']);
    act(() => {
      setActiveSpace('p1', 'main');
    });
    expect(all.filter((i) => seen.filter?.(i)).map((i) => i.id)).toEqual(['i-main', 'i-none']);
  });
});
