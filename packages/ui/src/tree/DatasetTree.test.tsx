import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DatasetTree, type DatasetTreeProps } from './DatasetTree';
import type { TreeGroup } from './model';

const groups: TreeGroup[] = [
  {
    kind: 'pointclouds',
    label: 'Point clouds',
    icon: 'cloud',
    count: 1,
    items: [{ id: 'cloud', layerId: 'cloud', layerKind: 'pointcloud', name: 'Photogrammetry' }],
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
          { id: 'c1', layerId: 'c1', layerKind: 'video', name: 'clip 1' },
          { id: 'c2', layerId: 'c2', layerKind: 'video', name: 'clip 2' },
        ],
      },
    ],
  },
];

const base: DatasetTreeProps = {
  groups,
  hidden: {},
  selectedId: null,
  activeClip: 'c1',
  collapsed: false,
  onToggleVisible: () => undefined,
  onSelect: () => undefined,
};

describe('DatasetTree', () => {
  it('the eye on a flight row shows and hides its flight path, not its clips', () => {
    const shown = renderToStaticMarkup(
      <DatasetTree
        {...base}
        defaultOpen={['video']}
        flightPath={{ shown: () => true, onToggle: () => undefined }}
      />,
    );
    expect(shown).toContain('aria-label="Hide the flight path of Flight 1"');
    const hidden = renderToStaticMarkup(
      <DatasetTree
        {...base}
        defaultOpen={['video']}
        flightPath={{ shown: () => false, onToggle: () => undefined }}
      />,
    );
    expect(hidden).toContain('aria-label="Show the flight path of Flight 1"');
    // the clips keep their own eyes for the layers
    expect(hidden).toContain('aria-label="Hide clip 1"');
  });

  it('a point cloud row offers its display settings', () => {
    const html = renderToStaticMarkup(
      <DatasetTree {...base} defaultOpen={['pointclouds']} onLayerSettings={() => undefined} />,
    );
    expect(html).toContain('aria-label="Point cloud colour and display: Photogrammetry"');
  });
});
