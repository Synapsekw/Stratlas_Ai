// @vitest-environment jsdom
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogue, makeIssue, photoSighting, tankModel } from '../testing';
import { IssueDetail } from './IssueDetail';
import { IssueRegister } from './IssueRegister';
import { PhotoViewer } from './PhotoViewer';
import { VideoAnnotator } from './VideoAnnotator';
import { AnnotationToolbar } from './AnnotationToolbar';

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
    expect(renderToString(<VideoAnnotator layerId="f108" />)).toContain('Annotate');
    expect(renderToString(<AnnotationToolbar />)).toContain('Cloud box');
  });
});
