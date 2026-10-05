import { ProjectManifest, SCHEMA_VERSION, type Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  evidenceKind,
  issueEvidence,
  issueFacts,
  issueOrder,
  lightboxReducer,
  overlayPath,
  photoEvidence,
  previewCrop,
  splitWithEvidence,
  stepIssue,
  type LightboxState,
} from './model';

const T0 = Date.UTC(2026, 0, 1);

const manifest = ProjectManifest.parse({
  schema: SCHEMA_VERSION,
  id: 'p',
  name: 'Test',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      items: [
        { id: 'p1', src: { path: 'photos/p1.jpg' } },
        { id: 'p2', src: { path: 'photos/p2.jpg' } },
        { id: 'p3', src: { path: 'photos/p3.jpg' } },
      ],
    },
    {
      kind: 'video',
      id: 'clip',
      name: 'Flight 1 clip',
      src: { path: 'video/c.mp4' },
      flight: { src: { path: 'flights/f.json' }, startUtcMs: T0 },
      lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.5 },
      offsetMs: 2000,
    },
  ],
  severityModels: [
    {
      id: 'sev',
      name: 'Kit',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: 'Minor, monitor' },
        {
          value: 3,
          label: 'Severe',
          color: '#ee3f4b',
          criteria: 'Severe',
          action: 'Repair within a week',
        },
      ],
      uncertain: { label: 'Uncertain', color: '#b68ef8' },
    },
  ],
  classCatalogues: [
    {
      id: 'c',
      name: 'Classes',
      assetType: 'tank',
      classes: [{ id: 'crack', label: 'Crack', color: '#ff0000', severityModel: 'sev' }],
    },
  ],
});

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'i1',
    code: 'F01',
    classId: 'crack',
    severityModelId: 'sev',
    severity: 3,
    status: 'reviewed',
    title: 'Crack in the shell',
    note: 'Wide crack.\nLocation: 12.0 m above datum, North side, Shell course 2.',
    author: 'Kit',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    sightings: [{ on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [1, 2, 3], n: [0, 1, 0] } }],
    source: 'import',
    ...over,
  };
}

describe('issue evidence', () => {
  it('groups the sightings per photo, largest marked region first, then video frames', () => {
    const list = issueEvidence(
      manifest,
      issue({
        sightings: [
          { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'point', x: 5, y: 5 } },
          {
            on: 'video',
            layer: 'clip',
            track: [{ t: 3.5, geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 } }],
          },
          {
            on: 'image',
            layer: 'photos',
            photo: 'p2',
            geom: { type: 'mask', src: { path: 'photos/masks/p2_mask.png' } },
          },
          {
            on: 'image',
            layer: 'photos',
            photo: 'p2',
            geom: { type: 'box', x: 10, y: 20, w: 100, h: 50 },
          },
          { on: 'image', layer: 'photos', photo: 'gone', geom: { type: 'point', x: 1, y: 1 } },
        ],
      }),
    );
    expect(list.map((e) => e.key)).toEqual(['photos/p2', 'photos/p1', 'photos/gone', 'clip@3.5']);
    const [best, point, gone, video] = list;
    expect(best).toMatchObject({
      kind: 'photo',
      src: { path: 'photos/p2.jpg' },
      masks: ['photos/masks/p2_overlay.png'],
      box: [10, 20, 100, 50],
    });
    expect(point).toMatchObject({ box: [5, 5, 0, 0], shapes: [{ type: 'point' }] });
    expect(gone).toMatchObject({ src: null });
    expect(video).toMatchObject({ kind: 'video', tS: 3.5, atMs: T0 + 2000 + 3500 });
    expect(photoEvidence(list)).toHaveLength(3);
  });

  it('turns a kit mask into its overlay and leaves other files alone', () => {
    expect(overlayPath('photos/masks/p0167_mask.png')).toBe('photos/masks/p0167_overlay.png');
    expect(overlayPath('photos/masks/x.png')).toBe('photos/masks/x.png');
  });

  it('knows what the evidence pane can show', () => {
    expect(evidenceKind(manifest, issue())).toBeNull();
    expect(
      evidenceKind(
        manifest,
        issue({
          sightings: [
            {
              on: 'video',
              layer: 'clip',
              track: [{ t: 1, geom: { type: 'box', x: 1, y: 1, w: 2, h: 2 } }],
            },
          ],
        }),
      ),
    ).toBe('video');
    expect(
      evidenceKind(
        manifest,
        issue({
          sightings: [
            { on: 'image', layer: 'photos', photo: 'p1', geom: { type: 'point', x: 1, y: 1 } },
          ],
        }),
      ),
    ).toBe('photo');
  });
});

describe('issue facts', () => {
  it('reads class, severity, zone, action and the other places it is marked', () => {
    const f = issueFacts(manifest, issue());
    expect(f).toMatchObject({
      classLabel: 'Crack',
      severityLabel: 'Severe',
      severityColor: '#ee3f4b',
      zone: 'Shell course 2',
      action: 'Repair within a week',
      elsewhere: [{ kind: 'mesh', count: 1 }],
    });
  });

  it('has no zone when the note names none, and the criteria when a level has no action', () => {
    const f = issueFacts(manifest, issue({ note: '', severity: 1 }));
    expect(f.zone).toBeNull();
    expect(f.action).toBe('Minor, monitor');
  });
});

describe('previous and next issue', () => {
  const order = issueOrder([
    { id: 'c', code: 'D10' },
    { id: 'a', code: 'D2' },
    { id: 'b', code: 'D3' },
  ]);
  it('walks the codes in natural order and wraps', () => {
    expect(order).toEqual(['a', 'b', 'c']);
    expect(stepIssue(order, 'a', 1)).toBe('b');
    expect(stepIssue(order, 'c', 1)).toBe('a');
    expect(stepIssue(order, 'a', -1)).toBe('c');
  });
  it('starts at an end for an issue not in the order, and has nothing to step in an empty one', () => {
    expect(stepIssue(order, 'zz', 1)).toBe('a');
    expect(stepIssue(order, 'zz', -1)).toBe('c');
    expect(stepIssue([], 'a', 1)).toBeNull();
  });
});

describe('preview crop', () => {
  it('frames a box with context at 4:3 inside the photo', () => {
    const [x, y, w, h] = previewCrop([1000, 600, 100, 60], 2000, 1500);
    expect(w / h).toBeCloseTo(4 / 3);
    expect(w).toBeCloseTo(600); // at least 30 % of the width
    expect(x).toBeLessThanOrEqual(1000);
    expect(x + w).toBeGreaterThanOrEqual(1100);
    expect(y).toBeGreaterThanOrEqual(0);
  });
  it('keeps a corner box inside and shows the whole photo without a box', () => {
    const [x, y] = previewCrop([0, 0, 10, 10], 2000, 1500);
    expect([x, y]).toEqual([0, 0]);
    expect(previewCrop(null, 640, 480)).toEqual([0, 0, 640, 480]);
  });
});

describe('lightbox state', () => {
  it('opens at a photo with the markings on, steps with wrap-around, toggles markings, closes', () => {
    let s: LightboxState | null = lightboxReducer(null, { type: 'open', issueId: 'i1', index: 1 });
    expect(s).toEqual({ issueId: 'i1', index: 1, marks: true });
    s = lightboxReducer(s, { type: 'step', dir: 1, count: 2 });
    expect(s?.index).toBe(0);
    s = lightboxReducer(s, { type: 'step', dir: -1, count: 2 });
    expect(s?.index).toBe(1);
    s = lightboxReducer(s, { type: 'marks' });
    expect(s?.marks).toBe(false);
    // stepping a single photo changes nothing
    expect(lightboxReducer(s, { type: 'step', dir: 1, count: 1 })).toBe(s);
    expect(lightboxReducer(s, { type: 'close' })).toBeNull();
    expect(lightboxReducer(null, { type: 'marks' })).toBeNull();
  });
});

describe('evidence beside the 3D view', () => {
  it('takes the side that is not the 3D view', () => {
    expect(splitWithEvidence({ left: '3d', right: 'map' }, 'photo')).toEqual({
      left: '3d',
      right: 'photo',
    });
    expect(splitWithEvidence({ left: 'raster', right: '3d', raster: 'o' }, 'video')).toEqual({
      left: 'video',
      right: '3d',
      raster: 'o',
    });
  });
  it('replaces a comparison of two dates with the 3D view on the latest date', () => {
    const resolved = { left: '3d', right: 'map', leftCapture: 'a', rightCapture: 'b' } as const;
    expect(splitWithEvidence(resolved, 'photo', true)).toEqual({ left: '3d', right: 'photo' });
    expect(
      splitWithEvidence({ left: 'raster', right: '3d', raster: 'o', rightCapture: 'b' }, 'video'),
    ).toEqual({ left: 'video', right: '3d', raster: 'o', rightCapture: 'b' });
  });
  it('brings the 3D view back to the left when the split had none', () => {
    expect(splitWithEvidence({ left: 'map', right: 'report' }, 'photo')).toEqual({
      left: '3d',
      right: 'photo',
    });
  });
});
