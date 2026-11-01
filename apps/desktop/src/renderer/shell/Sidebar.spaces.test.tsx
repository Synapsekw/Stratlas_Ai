// @vitest-environment jsdom
import { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shell } from '../shell';
import { activeSpace, setActiveSpace } from '../spaces/activeSpace';
import { LayersColumn } from './LayersColumn';
import { removal } from './removal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const model = (id: string, space: string) => ({
  kind: 'mesh' as const,
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  space,
});
const localSpace = (id: string) => ({
  id,
  name: `Tank ${id}`,
  crs: { local: 'flyability' },
  origin: [0, 0, 0],
  source: { kind: 'flyability' as const, inspectionId: `insp-${id}` },
});
const manifest = (captures: unknown[]) =>
  ProjectManifest.parse({
    schema: 'aio.project/1',
    id: 'p',
    name: 'P',
    crs: { epsg: 32633 },
    origin: [500000, 4500000, 0],
    captures,
    layers: [model('la', 's-a'), model('lb', 's-b'), model('lb2', 's-b')],
    spaces: [localSpace('s-a'), localSpace('s-b')],
    severityModels: [],
    classCatalogues: [],
  });
const undated = manifest([]);
// survey dates on: the Layers column draws date folders ("Every date" holds the undated layers)
const dated = manifest([{ id: 'c1', label: 'Survey', date: '2026-10-12' }]);

let host: HTMLDivElement;
let root: Root | undefined;

function render(m: ProjectManifest) {
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: m });
  removal.setState({
    trash: null,
    held: 0,
    loadTrash: () => Promise.resolve(),
    ask: () => Promise.resolve(),
  });
  act(() => {
    root = createRoot(host);
    root.render(<LayersColumn />);
  });
}

const q = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const rows = () =>
  [...document.body.querySelectorAll<HTMLElement>('[data-testid^="tree-row-"]')]
    .map((el) => el.dataset.testid?.slice('tree-row-'.length))
    .filter((id): id is string => id !== undefined);
const count = () => q('.tree-h-title .mono')?.textContent;

beforeEach(() => {
  shell.setState({
    pkg: null,
    screen: 'scene',
    settings: { ...shell.getState().settings, sidebarCollapsed: false },
  });
  host = document.createElement('div');
  document.body.append(host);
  activeSpace().setState({ byProject: {} });
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
  workspace.setState({ project: null } as never);
});

describe('the Layers column in a project with several spaces', () => {
  it.each([
    ['without survey dates', undated],
    ['with survey dates', dated],
  ])('lists and counts only the active space %s', (_, m) => {
    setActiveSpace('p', 's-b');
    render(m);
    // kind groups start folded: open every one so the rows are drawn
    for (const t of document.body.querySelectorAll<HTMLElement>(
      '[data-testid^="tree-group-toggle-"][aria-expanded="false"]',
    ))
      act(() => {
        t.click();
      });
    expect(rows()).not.toContain('la');
    expect(rows()).toEqual(expect.arrayContaining(['lb', 'lb2']));
    expect(count()).toBe('2');
  });
});
