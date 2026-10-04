// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DatasetTree, VisibilityEye } from './DatasetTree';
import { eyeTarget, groupLayerIds, treeLayerIds, visibilityOf, type TreeGroup } from './model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const groups: TreeGroup[] = [
  {
    kind: 'models',
    label: 'Models',
    icon: 'scene',
    count: 1,
    items: [{ id: 'tank', layerId: 'tank', layerKind: 'mesh', name: 'Tank' }],
  },
  {
    kind: 'pointclouds',
    label: 'Point clouds',
    icon: 'cloud',
    count: 2,
    items: [
      { id: 'c1', layerId: 'c1', layerKind: 'pointcloud', name: 'Cloud 1' },
      { id: 'c2', layerId: 'c2', layerKind: 'pointcloud', name: 'Cloud 2' },
    ],
  },
  {
    kind: 'video',
    label: 'Video',
    icon: 'video',
    count: 2,
    items: [
      {
        id: 'flight:f1',
        flightId: 'f1',
        name: 'Flight 1',
        children: [
          { id: 'v1', layerId: 'v1', layerKind: 'video', name: 'clip 1' },
          { id: 'v2', layerId: 'v2', layerKind: 'video', name: 'clip 2' },
        ],
      },
    ],
  },
  {
    kind: 'annotations',
    label: 'Annotations',
    icon: 'anno',
    count: 3,
    items: [{ id: 'issues', name: 'Issues', meta: '3' }],
  },
];

const LABELS = { all: 'Hide all layers', none: 'Show all layers', mixed: 'Show all, mixed' };

/** The sidebar's wiring: a master eye and the tree, over one `hidden` map, one update per click. */
function Harness({ log }: { log: string[][] }) {
  const [hidden, setHidden] = useState<Record<string, true>>({});
  const set = (ids: string[], visible: boolean) => {
    log.push([visible ? 'show' : 'hide', ...ids]);
    setHidden((h) => {
      const next = { ...h };
      for (const id of ids) {
        if (visible) Reflect.deleteProperty(next, id);
        else next[id] = true;
      }
      return next;
    });
  };
  return (
    <>
      <VisibilityEye
        layerIds={treeLayerIds(groups)}
        hidden={hidden}
        onSet={set}
        labels={LABELS}
        className="master"
      />
      <DatasetTree
        groups={groups}
        hidden={hidden}
        selectedId={null}
        activeClip={null}
        collapsed={false}
        onToggleVisible={(id, visible) => {
          set([id], visible);
        }}
        onSetVisible={set}
        onSelect={() => undefined}
        defaultOpen={['models', 'pointclouds']}
      />
    </>
  );
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(log: string[][]): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Harness log={log} />));
  return host;
}

const click = (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
  act(() => {
    el.click();
  });
};

describe('layer visibility of a group and of the whole tree', () => {
  it('collects layer ids, flight clips included', () => {
    expect(groups.filter((g) => g.kind === 'video').flatMap(groupLayerIds)).toEqual(['v1', 'v2']);
    expect(treeLayerIds(groups)).toEqual(['tank', 'c1', 'c2', 'v1', 'v2']);
  });

  it('is all, none or mixed; a click shows all unless all show', () => {
    expect(visibilityOf(['a', 'b'], {})).toBe('all');
    expect(visibilityOf(['a', 'b'], { a: true, b: true })).toBe('none');
    expect(visibilityOf(['a', 'b'], { b: true })).toBe('mixed');
    expect(eyeTarget('all')).toBe(false);
    expect(eyeTarget('none')).toBe(true);
    expect(eyeTarget('mixed')).toBe(true);
  });

  it('the master eye hides every layer in one update and shows them all again', () => {
    const log: string[][] = [];
    const host = mount(log);
    const master = () => host.querySelector('.master');
    expect(master()?.getAttribute('aria-label')).toBe('Hide all layers');
    click(master());
    expect(log).toEqual([['hide', 'tank', 'c1', 'c2', 'v1', 'v2']]);
    expect(master()?.getAttribute('data-visibility')).toBe('none');
    expect(host.querySelectorAll('.tgroup-row > .eye.off')).toHaveLength(3);
    click(master());
    expect(log[1]).toEqual(['show', 'tank', 'c1', 'c2', 'v1', 'v2']);
    expect(host.querySelectorAll('.titem.hidden')).toHaveLength(0);
  });

  it('a group eye covers its group; from mixed it shows all', () => {
    const log: string[][] = [];
    const host = mount(log);
    const cloudEye = () => host.querySelector('[aria-label^="Point clouds:"]');
    expect(cloudEye()?.getAttribute('aria-label')).toBe('Point clouds: hide all');
    // one cloud hidden by its own eye: the group and the master are mixed
    click(host.querySelector('[aria-label="Hide Cloud 1"]'));
    expect(cloudEye()?.getAttribute('data-visibility')).toBe('mixed');
    expect(cloudEye()?.getAttribute('aria-pressed')).toBe('mixed');
    expect(cloudEye()?.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('.master')?.getAttribute('data-visibility')).toBe('mixed');
    expect(cloudEye()?.getAttribute('aria-label')).toBe('Point clouds: show all (some are hidden)');
    click(cloudEye());
    expect(log.at(-1)).toEqual(['show', 'c1', 'c2']);
    expect(cloudEye()?.getAttribute('data-visibility')).toBe('all');
    click(cloudEye());
    expect(log.at(-1)).toEqual(['hide', 'c1', 'c2']);
    // the other groups are untouched
    expect(host.querySelector('[aria-label^="Models:"]')?.getAttribute('data-visibility')).toBe(
      'all',
    );
  });

  it('groups without layers (annotations) get no eye, and the icon rail shows none', () => {
    const host = mount([]);
    expect(host.querySelector('[aria-label^="Annotations:"]')).toBeNull();
    expect(host.querySelectorAll('.tgroup-row > .eye')).toHaveLength(3);
  });
});
