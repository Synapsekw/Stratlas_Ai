import { DetectionsFile, type ClassCatalogue, type Issue, type SeverityModel } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { acceptProblem, linkCandidates, newIssueInput, sightingOf } from './accept';
import {
  boundsIou,
  clampGeom,
  geomArea,
  insertVertex,
  nearestEdge,
  normBoxToPixels,
  normPolygonToPixels,
  removeVertex,
  toFrameGeom,
  type Polygon,
} from './geometry';
import { gridWindow, scrollToIndex } from './grid';
import { largestRegion, maskToPolygon, traceBoundary, type BinaryMask } from './mask';
import { aiPassName, boundsOf, readPasses, sourceKey, writePass, type Detection } from './model';

const NOW = '2026-10-05T10:00:00.000Z';

function det(over: Partial<Detection> = {}): Detection {
  return {
    id: 'd1',
    pass: 'ai-r1.json',
    source: { kind: 'photo', layer: 'photos', photo: 'p001' },
    size: [1000, 800],
    geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
    classId: 'moderate',
    severity: 2,
    uncertain: false,
    note: '',
    status: 'draft',
    origin: {
      kind: 'ai',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      promptVersion: 'detect-v1',
      runId: 'r1',
    },
    confidence: 0.82,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const model: SeverityModel = {
  id: 'aik-stack',
  name: 'Kit scale',
  levels: [
    { value: 1, label: 'Light', color: '#fad34b', criteria: '' },
    { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
    { value: 3, label: 'Heavy', color: '#ee3f4b', criteria: '' },
  ],
  uncertain: { label: 'Uncertain', color: '#b68ef8' },
};
const noUnc: SeverityModel = { id: 'plain', name: 'Plain', levels: model.levels };
const catalogue: ClassCatalogue = {
  id: 'cat',
  name: 'Classes',
  assetType: 'stack',
  classes: [
    {
      id: 'moderate',
      label: 'Moderate visible rust',
      color: '#ff7a2d',
      severityModel: 'aik-stack',
    },
    { id: 'crack', label: 'Crack', color: '#ee3f4b', severityModel: 'plain' },
  ],
};
const ctx = { models: [model, noUnc], catalogues: [catalogue] };

type Bbox = [number, number, number, number];

const passCtx = {
  photoLayer: (photo: string, fileLayer: string | undefined) =>
    fileLayer ?? (photo.startsWith('p') ? 'photos' : null),
  photoSize: (_layer: string, photo: string): [number, number] | null =>
    photo === 'p404' ? null : [2560, 1708],
  classId: (raw: string) =>
    raw === 'moderate' || raw === 'Moderate visible rust'
      ? 'moderate'
      : raw === 'crack'
        ? 'crack'
        : null,
  pipelineIssue: (id: string) => (id === 'piped' ? 'insp-1' : null),
};

const aiFile: DetectionsFile = {
  schema: 'aio.detections/1',
  source: 'ai',
  producer: 'anthropic claude-opus-5-5',
  run: { id: 'run-1', provider: 'anthropic', model: 'claude-opus-5-5', promptVersion: 'detect-v1' },
  detections: [
    {
      id: 'a1',
      photo: 'p001',
      class: 'moderate',
      severity: 2,
      status: 'draft',
      bbox: [10, 20, 60, 80] as Bbox,
      confidence: 0.8,
    },
    {
      photo: 'p002',
      class: 'Moderate visible rust',
      bbox: [0, 0, 0.5, 0.5] as Bbox,
      space: 'normalized',
      component: 'flange',
    },
    { id: 's1', class: 'moderate', space: 'sheet', sheet: 'sheet-00', bbox: [1, 1, 9, 9] as Bbox },
    {
      id: 'graffiti',
      photo: 'p003',
      class: 'graffiti',
      status: 'draft',
      bbox: [0, 0, 400, 300] as Bbox,
      space: 'source',
      width: 4000,
      height: 3000,
    },
    { id: 'gone', photo: 'p404', class: 'crack', bbox: [1, 1, 5, 5] as Bbox },
    { id: 'piped', photo: 'p005', class: 'crack', bbox: [1, 1, 5, 5] as Bbox },
  ],
};

describe('pass files (aio.detections/1) bridge', () => {
  it('reads passes into the review model: spaces, classes, origins, pipeline issues', () => {
    const r = readPasses([{ name: 'ai-run-1.json', file: aiFile }], passCtx);
    expect(r.hidden).toBe(2); // the contact sheet box and the photo of unknown size
    expect(r.runs).toEqual([{ ...aiFile.run, pass: 'ai-run-1.json' }]);
    const [a1, anon, graffiti, piped] = r.detections;
    expect(a1).toMatchObject({
      id: 'a1',
      pass: 'ai-run-1.json',
      size: [2560, 1708],
      geom: { type: 'box', x: 10, y: 20, w: 50, h: 60 },
      classId: 'moderate',
      status: 'draft',
      origin: {
        kind: 'ai',
        model: 'claude-opus-5-5',
        promptVersion: 'detect-v1',
        runId: 'run-1',
      },
    });
    expect(anon).toMatchObject({
      id: 'ai-run-1.json#1',
      size: [1, 1],
      status: 'accepted',
      classId: 'moderate',
      component: 'flange',
    });
    expect(graffiti).toMatchObject({ classId: '', label: 'graffiti', size: [4000, 3000] });
    expect(piped).toMatchObject({ status: 'accepted', issueId: 'insp-1', issuedBy: 'pipeline' });
  });

  it('writes back unchanged entries as they were and changed ones with geometry and issue', () => {
    const r = readPasses([{ name: 'ai-run-1.json', file: aiFile }], passCtx);
    const rec = r.passes[0];
    if (!rec) throw new Error('no pass');
    const loaded = new Map(r.detections.map((d) => [d.id, d]));
    const tri: [number, number][] = [
      [10, 20],
      [60, 20],
      [35, 80],
    ];
    const edited: Detection[] = r.detections.map((d) =>
      d.id === 'a1'
        ? { ...d, status: 'accepted', issueId: 'issue-9', geom: { type: 'polygon', points: tri } }
        : d.id === 'ai-run-1.json#1'
          ? { ...d, status: 'rejected' }
          : d,
    );
    const out = writePass(rec, edited, loaded, rec.header.run);
    expect(DetectionsFile.safeParse(out).success).toBe(true);
    expect(out.run).toEqual(aiFile.run);
    const [a1, anon, graffiti, piped, sheet, gone] = out.detections;
    expect(a1).toMatchObject({
      id: 'a1',
      status: 'accepted',
      issueId: 'issue-9',
      space: 'source',
      width: 2560,
      height: 1708,
      bbox: [10, 20, 60, 80],
      geom: { type: 'polygon' },
      origin: {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        promptVersion: 'detect-v1',
        runId: 'run-1',
      },
    });
    // an entry without an id stays without one; its normalized space and component stay
    expect(anon).toMatchObject({ status: 'rejected', space: 'normalized', component: 'flange' });
    expect(anon && 'id' in anon).toBe(false);
    // untouched entries (and the pipeline's) are the original objects
    expect(graffiti).toBe(aiFile.detections[3]);
    expect(piped).toBe(aiFile.detections[5]);
    expect(piped?.issueId).toBeUndefined();
    // entries the review cannot show are kept
    expect([sheet, gone]).toEqual([aiFile.detections[2], aiFile.detections[4]]);
  });

  it('writes a new drawing for the pipeline: bounds from the shape, human source override', () => {
    const rec = readPasses(
      [{ name: 'review.json', file: { schema: 'aio.detections/1', source: 'ai', detections: [] } }],
      passCtx,
    ).passes[0];
    if (!rec) throw new Error('no pass');
    const drawn = det({
      id: 'h1',
      pass: 'review.json',
      origin: { kind: 'human', author: 'D' },
      geom: { type: 'point', x: 100, y: 50 },
      size: [2560, 1708],
    });
    const out = writePass(rec, [drawn], new Map());
    expect(out.detections[0]).toMatchObject({
      id: 'h1',
      source: 'human',
      bbox: [96, 46, 104, 54],
      origin: { author: 'D' },
    });
    expect(DetectionsFile.safeParse(out).success).toBe(true);
    expect(boundsOf({ type: 'rotbox', x: 0, y: 0, w: 10, h: 10, angleDeg: 45 })[0]).toBeCloseTo(
      5 - Math.SQRT2 * 5,
    );
    expect(aiPassName('2026 10/05:x')).toBe('ai-2026-10-05-x.json');
    expect(sourceKey({ kind: 'frame', layer: 'v', t: 1.2345 })).toBe('frame:v:1235');
  });

  it('a normalized detection becomes image pixels when accepted', () => {
    const d = det({ size: [1, 1], geom: { type: 'box', x: 0.1, y: 0.2, w: 0.5, h: 0.25 } });
    const s = sightingOf(d, [1000, 800]);
    expect(s.ok && s.value).toMatchObject({
      geom: { type: 'box', x: 100, y: 160, w: 500, h: 200 },
    });
  });
});

describe('geometry editing', () => {
  const poly: Polygon = {
    type: 'polygon',
    points: [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
  };

  it('inserts a vertex on the nearest edge and removes down to three', () => {
    const e = nearestEdge(poly, { x: 50, y: 3 });
    expect(e.index).toBe(0);
    expect(e.distance).toBeCloseTo(3);
    const added = insertVertex(poly, e.index, { x: 50, y: 3 });
    expect(added.points[1]).toEqual([50, 3]);
    expect(added.points).toHaveLength(5);
    const fewer = removeVertex(poly, 0);
    expect(fewer?.points).toHaveLength(3);
    expect(fewer && removeVertex(fewer, 0)).toBeNull();
  });

  it('clamps shapes to the image', () => {
    expect(
      clampGeom({ type: 'box', x: -10, y: 790, w: 50, h: 50 }, { width: 1000, height: 800 }),
    ).toEqual({
      type: 'box',
      x: 0,
      y: 790,
      w: 40,
      h: 10,
    });
    expect(clampGeom({ type: 'point', x: 2000, y: -5 }, { width: 1000, height: 800 })).toEqual({
      type: 'point',
      x: 1000,
      y: 0,
    });
  });

  it('turns normalised model output into pixels and rejects slivers', () => {
    expect(normBoxToPixels([0.1, 0.2, 0.5, 0.25], { width: 1000, height: 800 })).toEqual({
      type: 'box',
      x: 100,
      y: 160,
      w: 500,
      h: 200,
    });
    expect(normBoxToPixels([0.1, 0.2, 0, 0.25], { width: 1000, height: 800 })).toBeNull();
    expect(normBoxToPixels([0.9, 0.9, 0.5, 0.5], { width: 100, height: 100 })).toEqual({
      type: 'box',
      x: 90,
      y: 90,
      w: 10,
      h: 10,
    });
    expect(normPolygonToPixels([[0, 0], [1, 0], 'x', [1, 1]], { width: 10, height: 20 })).toEqual({
      type: 'polygon',
      points: [
        [0, 0],
        [10, 0],
        [10, 20],
      ],
    });
    expect(
      normPolygonToPixels(
        [
          [0, 0],
          [1, 0],
        ],
        { width: 10, height: 20 },
      ),
    ).toBeNull();
  });

  it('converts shapes for video keyframes and measures them', () => {
    const rb = toFrameGeom({ type: 'rotbox', x: 0, y: 0, w: 10, h: 10, angleDeg: 45 });
    expect(rb?.type).toBe('polygon');
    expect(toFrameGeom({ type: 'point', x: 50, y: 50 })).toEqual({
      type: 'box',
      x: 42,
      y: 42,
      w: 16,
      h: 16,
    });
    expect(toFrameGeom({ type: 'mask', src: { path: 'm.png' } })).toBeNull();
    expect(geomArea(poly)).toBe(10000);
    expect(
      boundsIou(
        { type: 'box', x: 0, y: 0, w: 10, h: 10 },
        { type: 'box', x: 5, y: 0, w: 10, h: 10 },
      ),
    ).toBeCloseTo(50 / 150);
  });
});

describe('accepting', () => {
  it('builds a new draft issue with provenance and the agent source', () => {
    const r = newIssueInput(det({ note: 'Near the flange.' }), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sighting).toEqual({
      on: 'image',
      layer: 'photos',
      photo: 'p001',
      geom: det().geom,
    });
    expect(r.value.severity).toBe(2);
    expect(r.value.source).toBe('agent');
    expect(r.value.title).toBe('Moderate visible rust');
    expect(r.value.note).toBe(
      'Near the flange.\nDetected by claude-opus-5-5 (prompt detect-v1, confidence 82 %) on photo p001, accepted by a reviewer.',
    );
  });

  it('maps the uncertain flag to the uncertain level, or asks for a severity', () => {
    const u = newIssueInput(det({ uncertain: true, severity: null }), ctx);
    expect(u.ok && u.value.severity).toBe('uncertain');
    expect(acceptProblem(det({ classId: 'crack', uncertain: true, severity: null }), ctx)).toBe(
      'no-uncertain',
    );
    expect(newIssueInput(det({ classId: 'crack', uncertain: true, severity: 3 }), ctx).ok).toBe(
      true,
    );
  });

  it('names what is missing', () => {
    expect(acceptProblem(det({ classId: '' }), ctx)).toBe('no-class');
    expect(acceptProblem(det({ classId: 'nope' }), ctx)).toBe('unknown-class');
    expect(acceptProblem(det({ severity: null }), ctx)).toBe('no-severity');
    expect(acceptProblem(det({ severity: 7 }), ctx)).toBe('bad-severity');
    expect(acceptProblem(det(), ctx)).toBeNull();
    expect(
      newIssueInput(det({ origin: { kind: 'model', producer: 'yolo-v8.onnx' } }), ctx),
    ).toMatchObject({ ok: true, value: { source: 'agent' } });
    expect(newIssueInput(det({ origin: { kind: 'import', producer: 'coco' } }), ctx)).toMatchObject(
      { ok: true, value: { source: 'import' } },
    );
  });

  it('frame detections become one-keyframe video sightings; a person’s drawing stays human', () => {
    const s = sightingOf(det({ source: { kind: 'frame', layer: 'clip', t: 12.5 } }));
    expect(s.ok && s.value).toEqual({
      on: 'video',
      layer: 'clip',
      track: [{ t: 12.5, geom: det().geom }],
    });
    const base = det();
    delete base.confidence;
    const r = newIssueInput({ ...base, origin: { kind: 'human', author: 'D' } }, ctx);
    expect(r.ok && r.value.source).toBe('human');
    expect(r.ok && r.value.note).toBe('');
  });

  it('offers issues on the same photo first when linking', () => {
    const issue = (id: string, photo: string, classId: string): Issue => ({
      id,
      code: id.toUpperCase(),
      classId,
      severityModelId: 'aik-stack',
      severity: 1,
      status: 'draft',
      title: id,
      note: '',
      author: 'a',
      createdAt: NOW,
      updatedAt: NOW,
      source: 'human',
      sightings: [{ on: 'image', layer: 'photos', photo, geom: { type: 'point', x: 1, y: 1 } }],
    });
    const list = [
      issue('f01', 'p009', 'crack'),
      issue('f02', 'p009', 'moderate'),
      issue('f03', 'p001', 'crack'),
    ];
    expect(linkCandidates(det(), list).map((i) => i.id)).toEqual(['f03', 'f02', 'f01']);
  });
});

describe('contact sheet window', () => {
  it('renders only the rows near the view', () => {
    const w = gridWindow({
      count: 5000,
      width: 1000,
      height: 600,
      scrollTop: 20_000,
      minTile: 150,
      gap: 8,
      overscan: 1,
    });
    expect(w.cols).toBe(6);
    expect(w.tile).toBeCloseTo((1000 - 40) / 6);
    expect(w.rows).toBe(Math.ceil(5000 / 6));
    expect(w.end - w.start).toBeLessThanOrEqual(6 * 7);
    expect(w.start % w.cols).toBe(0);
    expect(w.offsetTop).toBeCloseTo((w.start / w.cols) * w.rowHeight);
  });

  it('handles a narrow view, an empty list and the end of the list', () => {
    expect(
      gridWindow({ count: 3, width: 50, height: 100, scrollTop: 0, minTile: 150, gap: 8 }).cols,
    ).toBe(1);
    const e = gridWindow({ count: 0, width: 800, height: 600, scrollTop: 0, minTile: 150, gap: 8 });
    expect([e.start, e.end, e.totalHeight]).toEqual([0, 0, 0]);
    const end = gridWindow({
      count: 10,
      width: 800,
      height: 600,
      scrollTop: 99_999,
      minTile: 150,
      gap: 8,
    });
    expect(end.end).toBe(10);
  });

  it('scrolls a tile into view only when it is outside', () => {
    const w = { cols: 5, rowHeight: 100 };
    expect(scrollToIndex(w, 0, 500, 300)).toBe(0);
    expect(scrollToIndex(w, 42, 0, 300)).toBe(900 - 300 + 0);
    expect(scrollToIndex(w, 31, 550, 300)).toBe(550);
  });
});

describe('mask assist post-processing', () => {
  function rectMask(
    W: number,
    H: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): BinaryMask {
    const data = new Uint8Array(W * H);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * W + x] = 1;
    return { width: W, height: H, data };
  }

  it('keeps the largest region', () => {
    const m = rectMask(20, 20, 2, 2, 10, 10);
    m.data[19 * 20 + 19] = 1;
    const r = largestRegion(m);
    expect(r.data[19 * 20 + 19]).toBe(0);
    expect(r.data[5 * 20 + 5]).toBe(1);
  });

  it('traces a rectangle and simplifies it to four corners scaled to the image', () => {
    const m = rectMask(16, 16, 4, 4, 12, 10);
    expect(traceBoundary(m).length).toBeGreaterThan(8);
    const p = maskToPolygon(m, { width: 160, height: 160 });
    expect(p?.points).toHaveLength(4);
    const xs = p?.points.map((q) => q[0]) ?? [];
    const ys = p?.points.map((q) => q[1]) ?? [];
    expect(Math.min(...xs)).toBe(45);
    expect(Math.max(...xs)).toBe(115);
    expect(Math.min(...ys)).toBe(45);
    expect(Math.max(...ys)).toBe(95);
  });

  it('returns null for an empty mask', () => {
    expect(
      maskToPolygon({ width: 4, height: 4, data: new Uint8Array(16) }, { width: 4, height: 4 }),
    ).toBeNull();
  });
});
