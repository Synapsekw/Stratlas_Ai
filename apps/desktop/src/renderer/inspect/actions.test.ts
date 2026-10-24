// @vitest-environment jsdom
/**
 * Inspect's accept and dismiss actions over the detection review: one key accepts a draft with
 * the project's last class and severity when they fit, Change accepts with a picked one, Dismiss
 * rejects with a reason, and Accept all above accepts one class over a bar as one undo step.
 * No accept ever writes a normalized shape: the photo's pixel size is found first.
 */
import { rememberImageSize, setAnnotateReadOnly } from '@aio/annotate';
import { initialReview, reviewReducer, type Detection } from '@aio/annotate/detections';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// the app's bridge binds to window.aio when its module loads: answer every write with ok
vi.hoisted(() => {
  (globalThis as { aio?: unknown }).aio = {
    invoke: () => Promise.resolve({ ok: true }),
    on: () => () => undefined,
  };
});

import { detections, undoReview } from '../detections/store';
import {
  acceptAllAbove,
  acceptSuggestion,
  acceptWith,
  dismissSuggestion,
  linkSuggestion,
  rejectAllOfClass,
  resolveImageSize,
  waitingOf,
} from './actions';
import { rememberChoice } from './lastChoice';

const NOW = '2026-10-15T10:00:00.000Z';

const photo = (id: string) => ({ id, src: { path: `photos/${id}.jpg` } });

const manifest: ProjectManifest = {
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
      items: [photo('p001'), photo('p002'), photo('p003'), photo('p004')],
    },
  ],
  severityModels: [
    {
      id: 'sev3',
      name: 'Three',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: '' },
        { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
        { value: 3, label: 'Major', color: '#ff2d2d', criteria: '' },
      ],
    },
    {
      id: 'sev5',
      name: 'Five',
      levels: [1, 2, 3, 4, 5].map((v) => ({
        value: v,
        label: `L${v}`,
        color: '#aa0000',
        criteria: '',
      })),
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Kit',
      assetType: 'site',
      classes: [
        { id: 'corrosion', label: 'Corrosion', color: '#aa5500', severityModel: 'sev3' },
        { id: 'crack', label: 'Crack', color: '#aa0000', severityModel: 'sev5' },
      ],
    },
  ],
};

const det = (id: string, over: Partial<Detection> = {}): Detection => ({
  id,
  pass: 'ai-r1.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p001' },
  size: [1000, 800],
  geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
  classId: 'corrosion',
  severity: 2,
  uncertain: false,
  note: '',
  confidence: 0.9,
  status: 'draft',
  origin: { kind: 'ai', provider: 'x', model: 'm', promptVersion: 'v1', runId: 'r1' },
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const FIXTURE: Detection[] = [
  det('d-complete'),
  det('d-no-class', { classId: '', severity: null, source: src('p002') }),
  det('d-corrosion-no-severity', { severity: null, source: src('p002') }),
  det('d-detector', { source: src('p003') }),
  det('d-low', { confidence: 0.5, source: src('p003') }),
  det('d-crack', { classId: 'crack', severity: 4, source: src('p003') }),
];

function src(p: string): Detection['source'] {
  return { kind: 'photo', layer: 'photos', photo: p };
}

function review(list: Detection[]) {
  detections.setState({
    projectId: 'p1',
    readOnly: false,
    review: reviewReducer(initialReview(), { type: 'load', detections: list }),
  });
}

const find = (id: string) => detections.getState().review.detections.find((d) => d.id === id);
const issues = () => workspace.getState().issues;

beforeEach(() => {
  setAnnotateReadOnly(false);
  localStorage.clear();
  workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest }, []);
  review(FIXTURE);
});
afterEach(() => {
  workspace.getState().closeProject();
  detections.setState({ projectId: null, review: initialReview(), readOnly: false });
  vi.unstubAllGlobals();
});

describe('acceptSuggestion', () => {
  it('accepts a complete draft as a new issue with one call', async () => {
    const r = await acceptSuggestion('p1', 'd-complete');
    expect(r).toMatchObject({ ok: true });
    expect(find('d-complete')?.status).toBe('accepted');
    expect(issues()).toHaveLength(1);
  });

  it('fills the last class and severity of the project into a draft without a class', async () => {
    rememberChoice('p1', { classId: 'corrosion', severity: 2 });
    expect(await acceptSuggestion('p1', 'd-no-class')).toMatchObject({ ok: true });
    expect(issues()[0]).toMatchObject({ classId: 'corrosion', severity: 2 });
  });

  it('takes only the last severity when the draft names a known class', async () => {
    rememberChoice('p1', { classId: 'crack', severity: 3 });
    expect(await acceptSuggestion('p1', 'd-corrosion-no-severity')).toMatchObject({ ok: true });
    expect(issues()[0]).toMatchObject({ classId: 'corrosion', severity: 3 });
  });

  it('opens the picker when the last choice does not fit the class', async () => {
    rememberChoice('p1', { classId: 'crack', severity: 5 }); // level 5 is not in the corrosion model
    expect(await acceptSuggestion('p1', 'd-corrosion-no-severity')).toEqual({
      ok: false,
      needs: 'picker',
    });
    expect(issues()).toHaveLength(0);
    expect(find('d-corrosion-no-severity')).toMatchObject({ status: 'draft', severity: null });
  });

  it('opens the picker when there is no last choice', async () => {
    expect(await acceptSuggestion('p1', 'd-no-class')).toEqual({ ok: false, needs: 'picker' });
    expect(issues()).toHaveLength(0);
  });

  it('refuses everything in a read-only package', async () => {
    setAnnotateReadOnly(true);
    expect(await acceptSuggestion('p1', 'd-complete')).toMatchObject({ ok: false });
    expect(await acceptWith('p1', 'd-complete', { classId: 'crack', severity: 1 })).toMatchObject({
      ok: false,
    });
    dismissSuggestion('d-detector', 'not-a-defect');
    expect(find('d-detector')?.status).toBe('draft');
    expect(issues()).toHaveLength(0);
  });

  it('accepts a normalized draft on a photo never opened in pixels, from the library size', async () => {
    rememberImageSize('photos', 'p004', [4000, 3000]);
    review([
      det('d-norm', {
        source: src('p004'),
        size: [1, 1],
        geom: { type: 'box', x: 0.25, y: 0.5, w: 0.1, h: 0.2 },
      }),
    ]);
    expect(await acceptSuggestion('p1', 'd-norm')).toMatchObject({ ok: true });
    const s = issues()[0]?.sightings[0];
    expect(s).toMatchObject({ on: 'image', photo: 'p004' });
    expect(s && 'geom' in s ? s.geom : null).toMatchObject({ x: 1000, y: 1500, w: 400, h: 600 });
  });

  it('decodes the photo for its size when nothing knows it', async () => {
    let asked = '';
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 2000;
        naturalHeight = 1000;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(v: string) {
          asked = v;
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    review([
      det('d-norm', {
        source: { kind: 'photo', layer: 'photos', photo: 'p003' },
        size: [1, 1],
        geom: { type: 'box', x: 0.5, y: 0.5, w: 0.25, h: 0.5 },
      }),
    ]);
    expect(await acceptSuggestion('p1', 'd-norm')).toMatchObject({ ok: true });
    expect(asked).toContain('p003.jpg');
    const s = issues()[0]?.sightings[0];
    expect(s && 'geom' in s ? s.geom : null).toMatchObject({ x: 1000, y: 500, w: 500, h: 500 });
  });

  it('refuses a normalized draft whose photo cannot be read', async () => {
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    review([det('d-norm', { source: src('p002'), size: [1, 1] })]);
    const r = await acceptSuggestion('p1', 'd-norm');
    expect('error' in r ? r.error : '').not.toBe('');
    expect(issues()).toHaveLength(0);
  });
});

describe('resolveImageSize', () => {
  it('answers the size the viewer or the library registered, else null for an unknown source', async () => {
    rememberImageSize('photos', 'p001', [640, 480]);
    expect(await resolveImageSize('photo:photos:p001')).toEqual([640, 480]);
    expect(await resolveImageSize('photo:nolayer:x')).toBeNull();
  });
});

describe('acceptWith', () => {
  it('patches the class and severity, accepts, and remembers the choice', async () => {
    expect(await acceptWith('p1', 'd-no-class', { classId: 'crack', severity: 5 })).toMatchObject({
      ok: true,
    });
    expect(issues()[0]).toMatchObject({ classId: 'crack', severity: 5 });
    expect(await acceptSuggestion('p1', 'd-corrosion-no-severity')).toEqual({
      ok: false,
      needs: 'picker',
    });
  });
});

describe('linkSuggestion', () => {
  it('adds the draft as a sighting of an existing finding', async () => {
    const first = await acceptSuggestion('p1', 'd-complete');
    if (!first.ok) throw new Error('not accepted');
    expect(await linkSuggestion('d-detector', first.issueId)).toEqual({
      ok: true,
      issueId: first.issueId,
    });
    expect(issues()).toHaveLength(1);
    expect(issues()[0]?.sightings).toHaveLength(2);
    expect(find('d-detector')).toMatchObject({ status: 'accepted', issueId: first.issueId });
  });
});

describe('dismissSuggestion', () => {
  it('dismisses with a reason', () => {
    dismissSuggestion('d-detector', 'not-a-defect');
    expect(find('d-detector')).toMatchObject({ status: 'rejected', rejectReason: 'not-a-defect' });
  });
});

describe('waitingOf, acceptAllAbove and rejectAllOfClass', () => {
  it('lists the waiting drafts of a class at or above the bar in review order', () => {
    expect(waitingOf('corrosion', 0.8).map((d) => d.id)).toEqual([
      'd-complete',
      'd-corrosion-no-severity',
      'd-detector',
    ]);
    expect(waitingOf(null, 0).map((d) => d.id)).toHaveLength(6);
  });

  it('accepts all of one class above the bar as one undo step', async () => {
    review([det('a1'), det('a2', { source: src('p002') }), det('a3', { confidence: 0.6 })]);
    expect(await acceptAllAbove('corrosion', 0.8)).toEqual({ accepted: 2, skipped: 0 });
    expect(issues()).toHaveLength(2);
    undoReview();
    expect(issues()).toHaveLength(0);
  });

  it('scales normalized drafts in Accept all and skips those with no known size', async () => {
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    rememberImageSize('photos', 'p004', [4000, 3000]);
    const norm = {
      size: [1, 1] as [number, number],
      geom: { type: 'box' as const, x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    };
    review([
      det('n1', { ...norm, source: src('p004') }),
      det('n2', { ...norm, source: src('p002') }),
    ]);
    expect(await acceptAllAbove('corrosion', 0.8)).toEqual({ accepted: 1, skipped: 1 });
    const s = issues()[0]?.sightings[0];
    expect(s && 'geom' in s ? s.geom : null).toMatchObject({ x: 2000, y: 1500, w: 400, h: 300 });
  });

  it('rejects every waiting draft of one class', () => {
    expect(rejectAllOfClass('corrosion')).toBe(4);
    expect(find('d-crack')?.status).toBe('draft');
    expect(find('d-low')?.status).toBe('rejected');
  });
});
