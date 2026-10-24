// @vitest-environment jsdom
/**
 * Inspect's viewer draws, places its chips and scales a Fix edit back with one photo size: the
 * one the photo is drawn at. The library's size (read from the file header, before the EXIF turn)
 * may be the other way round and must not be used for any of them.
 */
import type * as Annotate from '@aio/annotate';
import { rememberImageSize, type ShapeItem } from '@aio/annotate';
import type { Detection } from '@aio/annotate/detections';
import type { ImageGeom, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ViewerProps {
  extraShapes: (n: { width: number; height: number }) => readonly ShapeItem[];
  onExtraEdit: (key: string, geom: ImageGeom) => void;
  overlay: (toStage: (p: { x: number; y: number }) => { x: number; y: number }) => ReactNode;
}

const h = vi.hoisted(() => {
  (globalThis as { aio?: unknown }).aio = {
    invoke: () => Promise.resolve({ ok: true }),
    on: () => () => undefined,
  };
  return {
    props: null as ViewerProps | null,
    shapes: [] as readonly ShapeItem[],
    // the photo as the browser draws it: EXIF turned, portrait
    natural: { width: 3000, height: 4000 },
  };
});

// PhotoViewer's order: the photo loads, `extraShapes` gets its size, then the overlay is drawn
vi.mock('@aio/annotate', async (importOriginal) => ({
  ...(await importOriginal<typeof Annotate>()),
  PhotoViewer: (p: ViewerProps) => {
    h.props = p;
    h.shapes = p.extraShapes(h.natural);
    return <div data-testid="pv">{p.overlay((pt) => pt)}</div>;
  },
}));

const { InspectViewer } = await import('./InspectViewer');

const manifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [{ id: 'a', src: { path: 'photos/a.jpg' } }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;

const norm: Detection = {
  id: 'd1',
  pass: 'ai-r1.json',
  source: { kind: 'photo', layer: 'photos', photo: 'a' },
  size: [1, 1],
  geom: { type: 'box', x: 0.25, y: 0.5, w: 0.1, h: 0.2 },
  classId: '',
  label: 'rust',
  severity: null,
  uncertain: false,
  note: '',
  confidence: 0.9,
  status: 'draft',
  origin: { kind: 'ai', provider: 'x', model: 'm', promptVersion: 'v1', runId: 'r1' },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest }, []);
  // the library's size, from the file header: landscape, the other way round
  rememberImageSize('photos', 'a', [4000, 3000]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  workspace.getState().closeProject();
});

describe('InspectViewer', () => {
  it('draws, places the chip and scales a Fix edit back with the size the photo is drawn at', () => {
    const onEdit = vi.fn();
    const onSize = vi.fn();
    act(() => {
      root.render(
        <InspectViewer
          projectId="p1"
          layers={manifest.layers}
          photo={{ layerId: 'photos', photoId: 'a' }}
          frame={null}
          drafts={[norm]}
          currentId="d1"
          fixing
          readOnly={false}
          handle={createRef()}
          fitSignal={0}
          onSelect={vi.fn()}
          onEdit={onEdit}
          onAccept={vi.fn()}
          onDismiss={vi.fn()}
          onSize={onSize}
        />,
      );
    });
    expect(h.shapes[0]?.geom).toEqual({ type: 'box', x: 750, y: 2000, w: 300, h: 800 });
    // the chip under the box: its left edge, 4 px under its bottom
    const chip = host.querySelector<HTMLElement>('[data-testid="inspect-inline"]');
    expect(chip?.style.left).toBe('750px');
    expect(chip?.style.top).toBe('2804px');

    act(() => {
      h.props?.onExtraEdit('det:d1', { type: 'box', x: 300, y: 400, w: 600, h: 800 });
    });
    const [id, geom] = onEdit.mock.calls[0] as [
      string,
      { x: number; y: number; w: number; h: number },
    ];
    expect(id).toBe('d1');
    expect(geom.x).toBeCloseTo(0.1, 9);
    expect(geom.y).toBeCloseTo(0.1, 9);
    expect(geom.w).toBeCloseTo(0.2, 9);
    expect(geom.h).toBeCloseTo(0.2, 9);
    // the screen gets the same size for mask assist
    expect(onSize).toHaveBeenCalledWith('photo:photos:a', { width: 3000, height: 4000 });
  });
});
