// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogue, makeIssue, photoSighting, tankModel } from '../testing';
import type { ShapeItem } from './DrawLayer';
import { IssueDetail } from './IssueDetail';
import { IssueRegister } from './IssueRegister';
import { PhotoViewer } from './PhotoViewer';
import { VideoAnnotator } from './VideoAnnotator';
import { AnnotationToolbar } from './AnnotationToolbar';
import { setAnnotateReadOnly } from '../runtime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver: a stand-in that never fires.
const noop = () => undefined;
globalThis.ResizeObserver = class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
};
// jsdom has no layout: scrolling is a no-op.
Element.prototype.scrollIntoView = function scrollIntoView() {
  return undefined;
};

function renderToString(node: ReactNode): string {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  act(() => {
    root.render(node);
  });
  const html = el.innerHTML;
  act(() => {
    root.unmount();
  });
  el.remove();
  return html;
}

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'hcl',
  name: 'HCl',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [{ id: 'F01', src: { path: 'photos/F01.jpg' } }],
    },
    {
      kind: 'video',
      id: 'f108',
      name: 'Flight 108',
      visible: true,
      src: { path: 'video/f108.mp4' },
      flight: { src: { path: 'flights/f108.json' }, startUtcMs: 0 },
      lens: { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 },
      offsetMs: 0,
    },
  ],
  severityModels: [tankModel],
  classCatalogues: [catalogue],
};

describe('components render', () => {
  afterEach(() => {
    workspace.getState().closeProject();
  });

  it('lists issues with codes and model severity colours', () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, [
      makeIssue(),
      makeIssue({
        id: 'b',
        code: 'F02',
        title: 'Roof blisters',
        severity: 3,
        classId: 'blister',
      }),
    ]);
    workspace.getState().select({ kind: 'issue', id: 'b' });
    const html = renderToString(<IssueRegister />);
    expect(html).toContain('F01');
    expect(html).toContain('Roof blisters');
    expect(html).toContain('#e5484d');
    expect(html).toMatch(
      /aria-selected="true"[^>]*data-id="b"|data-id="b"[^>]*aria-selected="true"/,
    );
  });

  it('shows the detail form with workflow buttons', () => {
    workspace
      .getState()
      .openProject({ id: 'hcl', root: 'r', manifest }, [makeIssue({ sightings: [photoSighting] })]);
    const html = renderToString(<IssueDetail issueId="i1" />);
    expect(html).toContain('Mark reviewed');
    expect(html).toContain('Photo F01 · box');
    expect(html).toContain('aio://project/hcl/photos/F01.jpg');
  });

  it('renders the photo viewer, video annotator and 3D toolbar', () => {
    workspace.getState().openProject({ id: 'hcl', root: 'r', manifest }, []);
    expect(renderToString(<PhotoViewer layerId="photos" photoId="F01" />)).toContain(
      'aio://project/hcl/photos/F01.jpg',
    );
    expect(renderToString(<PhotoViewer layerId="photos" photoId="F01" viewOnly />)).toContain(
      'Turn 90 degrees clockwise',
    );
    expect(renderToString(<VideoAnnotator layerId="f108" />)).toContain('Annotate');
    expect(renderToString(<AnnotationToolbar />)).toContain('Cloud box');
  });

  it('in a read-only package shows issues without any edit control or annotation tool', () => {
    workspace
      .getState()
      .openProject({ id: 'hcl', root: 'r', manifest }, [
        makeIssue({ sightings: [photoSighting, photoSighting], note: 'Lining blistered at seam' }),
      ]);
    setAnnotateReadOnly(true);
    try {
      const detail = renderToString(<IssueDetail issueId="i1" />);
      expect(detail).toContain('Lining blistered at seam');
      expect(detail).toContain('Photo F01 · box');
      for (const edit of [
        'Mark reviewed',
        'Delete issue',
        'Merge here',
        '<input',
        '<textarea',
        '<select',
      ]) {
        expect(detail).not.toContain(edit);
      }
      expect(renderToString(<IssueRegister />)).not.toContain('Undo');
      expect(renderToString(<AnnotationToolbar />)).toBe('');
      expect(renderToString(<VideoAnnotator layerId="f108" />)).not.toContain('Annotate');
      const photo = renderToString(<PhotoViewer layerId="photos" photoId="F01" />);
      expect(photo).toContain('aio://project/hcl/photos/F01.jpg');
      expect(photo).not.toContain('Rotated box');
      expect(photo).not.toContain('Turn 90 degrees clockwise');
    } finally {
      setAnnotateReadOnly(false);
    }
  });
});

describe('the photo viewer with suggestions (Inspect)', () => {
  type ViewerProps = Partial<Parameters<typeof PhotoViewer>[0]>;
  type ToStage = (p: { x: number; y: number }) => { x: number; y: number };
  let host: HTMLDivElement;
  let root: Root;
  const BOX = { type: 'box', x: 100, y: 100, w: 50, h: 40 } as const;
  // the toolbar of a viewer with no new props: five tools, a separator, Fit and Rotate
  const BEFORE = 8;

  beforeEach(() => {
    // jsdom has no layout or pointer capture: a 400 x 300 stage
    Element.prototype.setPointerCapture = () => undefined;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 300,
    });
    workspace
      .getState()
      .openProject({ id: 'hcl', root: 'r', manifest }, [makeIssue({ sightings: [photoSighting] })]);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    workspace.getState().closeProject();
  });

  const renderViewer = (props: ViewerProps) => {
    act(() => {
      root.render(<PhotoViewer layerId="photos" photoId="F01" {...props} />);
    });
  };
  // the photo arrives: 800 x 600 pixels
  const loaded = () => {
    const img = host.querySelector<HTMLImageElement>('img.ann-img');
    if (!img) throw new Error('no photo');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    act(() => {
      img.dispatchEvent(new Event('load'));
    });
  };
  const pointer = (
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    at: { x: number; y: number },
  ) => {
    act(() => {
      host
        .querySelector('svg')
        ?.dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: at.x, clientY: at.y, button: 0 }),
        );
    });
  };
  // the overlay hands out the image to stage mapping, used here to aim the clicks
  const capture = () => {
    const ref: { f: ToStage | null } = { f: null };
    const overlay = (f: ToStage) => {
      ref.f = f;
      return null;
    };
    const toStage: ToStage = (p) => {
      if (!ref.f) throw new Error('no overlay');
      return ref.f(p);
    };
    return { overlay, toStage };
  };

  it('draws extra shapes dashed after the issue shapes and reports their clicks', () => {
    const onExtraSelect = vi.fn();
    const { overlay, toStage } = capture();
    const extra: ShapeItem = { key: 'det:d1', geom: BOX, color: 'var(--warn)', dashed: true };
    renderViewer({ extraShapes: () => [extra], onExtraSelect, overlay });
    loaded();
    const ai = host.querySelector('svg .shape.ai');
    expect(ai).not.toBeNull();
    // drawn last, after the issue's own shape
    const shapes = [...host.querySelectorAll('svg .shape')];
    expect(shapes).toHaveLength(2);
    expect(shapes[1]).toBe(ai);
    const mid = toStage({ x: 125, y: 120 });
    pointer('pointerdown', mid);
    pointer('pointerup', mid);
    expect(onExtraSelect).toHaveBeenCalledWith('det:d1');
    expect(workspace.getState().selection).toBeNull();
  });

  it('reports the edit of an editable extra shape to onExtraEdit, not to the issues', () => {
    const onExtraEdit = vi.fn();
    const { overlay, toStage } = capture();
    renderViewer({
      extraShapes: () => [
        {
          key: 'det:d1',
          geom: BOX,
          color: 'var(--warn)',
          dashed: true,
          selected: true,
          editable: true,
        },
      ],
      onExtraEdit,
      overlay,
    });
    loaded();
    // move the whole box 10 photo pixels to the right
    pointer('pointerdown', toStage({ x: 125, y: 120 }));
    pointer('pointermove', toStage({ x: 135, y: 120 }));
    pointer('pointerup', toStage({ x: 135, y: 120 }));
    expect(onExtraEdit).toHaveBeenCalledTimes(1);
    const [key, geom] = onExtraEdit.mock.calls[0] as [string, { type: string; x: number }];
    expect(key).toBe('det:d1');
    expect(geom.type).toBe('box');
    expect(geom.x).toBeCloseTo(110);
    expect(workspace.getState().issues[0]?.sightings).toEqual([photoSighting]);
  });

  it('renders as before without the new props (Lightbox)', () => {
    renderViewer({});
    loaded();
    expect(host.querySelector('svg .shape.ai')).toBeNull();
    expect(host.querySelector('svg.det-look')).toBeNull();
    expect(host.querySelectorAll('svg .shape')).toHaveLength(1);
    const toolbar = host.querySelector('[role="toolbar"][aria-label="Photo annotation tools"]');
    expect(toolbar?.children).toHaveLength(BEFORE);
  });

  it('puts the extra controls at the end of the toolbar and passes the look on', () => {
    renderViewer({ toolbarExtra: <button type="button">Ask AI</button>, look: 'detections' });
    loaded();
    const toolbar = host.querySelector('[role="toolbar"]');
    expect(toolbar?.lastElementChild?.textContent).toBe('Ask AI');
    expect(host.querySelector('svg.det-look')).not.toBeNull();
  });

  it('places the overlay with the view transform', () => {
    renderViewer({
      overlay: (toStage) => {
        const p = toStage({ x: 200, y: 100 });
        return <div data-testid="pin" style={{ left: p.x, top: p.y }} />;
      },
    });
    expect(host.querySelector('[data-testid="pin"]')).toBeNull();
    loaded();
    const img = host.querySelector<HTMLImageElement>('img.ann-img');
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
      img?.style.transform ?? '',
    );
    if (!m) throw new Error('no view transform');
    const [x, y, scale] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(scale).not.toBe(1);
    const pin = host.querySelector<HTMLElement>('[data-testid="pin"]');
    expect(parseFloat(pin?.style.left ?? '')).toBeCloseTo(200 * scale + x);
    expect(parseFloat(pin?.style.top ?? '')).toBeCloseTo(100 * scale + y);
  });
});
