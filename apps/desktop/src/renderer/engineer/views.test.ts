import { stackModel } from '@aio/modelling';
import type { EvidencePack } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  draftTriangles,
  facing,
  imageMask,
  iou,
  MASK_PX,
  project,
  projectTriangles,
  renderDraftViews,
  silhouetteScores,
  triangleMask,
  type ViewCanvas,
} from './views';

/** A cloud render as `model.evidence` writes it: dark where the mask is on, white elsewhere. */
function renderOf(mask: Uint8Array, px: number) {
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  mask.forEach((on, i) => {
    if (on) data.set([40, 40, 40, 255], i * 4);
  });
  return { data, width: px, height: px };
}

const pack = (views: string[]): EvidencePack =>
  ({
    images: views.map((view) => ({
      id: `img-side-${view}`,
      file: `img/side-${view}.png`,
      kind: view === 'top' ? 'top' : 'side',
      view,
      w: 256,
      h: 256,
      bytes: 1,
      sha1: '0'.repeat(40),
    })),
  }) as unknown as EvidencePack;

describe('the draft seen as the evidence renders see the cloud', () => {
  it('names views by the side the camera stands on, as render.py does', () => {
    // north sees the north face: east is on the left, up is up (v down)
    expect(project(1, 2, 0, 'north').slice(0, 2)).toEqual([-1, -2]);
    expect(project(0, 0, -1, 'east')[0]).toBe(1); // north on the right
    expect(project(1, 9, 1, 'top')).toEqual([1, 1, 9]); // a plan, north up
  });

  it('meshes the draft in the local frame, the whole chimney', () => {
    const t = draftTriangles(stackModel());
    expect(t.length % 9).toBe(0);
    let top = -Infinity;
    for (let i = 1; i < t.length; i += 3) top = Math.max(top, t[i] ?? 0);
    expect(top).toBeGreaterThan(120);
  });

  it('scores a draft that matches the cloud near 1 and a wrong one low', async () => {
    const model = stackModel();
    const tris = draftTriangles(model);
    const truth = triangleMask(projectTriangles(tris, 'east', MASK_PX), MASK_PX);
    // the cloud render of a chimney twice as wide: the draft no longer fits it
    const wide = new Uint8Array(MASK_PX * MASK_PX);
    for (let y = 0; y < MASK_PX; y++)
      for (let x = 0; x < MASK_PX; x++) wide[y * MASK_PX + x] = x > 20 && x < 108 ? 1 : 0;
    const images: Record<string, Uint8Array> = { 'img-side-east': truth, 'img-side-top': wide };
    const scores = await silhouetteScores(
      model,
      pack(['east', 'top', 'crown']),
      (id) => Promise.resolve(id),
      (id) => Promise.resolve(renderOf(images[id] ?? new Uint8Array(MASK_PX * MASK_PX), MASK_PX)),
    );
    expect(Object.keys(scores).sort()).toEqual(['east', 'top']);
    expect(scores.east).toBeGreaterThan(0.95);
    expect(scores.top).toBeLessThan(0.5);
  });

  it('reads a render as a silhouette and compares masks', () => {
    const px = 4;
    const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
    rgba.set([10, 10, 10, 255], 0);
    const m = imageMask(rgba, px, px, 2);
    expect([...m]).toEqual([1, 0, 0, 0]);
    expect(iou(new Uint8Array([1, 1, 0, 0]), new Uint8Array([1, 0, 1, 0]))).toBeCloseTo(1 / 3);
    expect(iou(new Uint8Array(4), new Uint8Array(4))).toBe(0);
  });

  it('draws generated views far first, flat shaded, as PNG data URLs', () => {
    const drawn: number[] = [];
    const canvas = (): ViewCanvas => ({
      fillTriangle: (_a, _b, _c, grey) => drawn.push(grey),
      toDataUrl: () => 'data:image/png;base64,AAAA',
    });
    const out = renderDraftViews(
      stackModel(),
      [
        { id: 'gen-east', view: 'east' },
        { id: 'gen-odd', view: 'oblique' },
      ],
      canvas,
    );
    expect(out).toEqual([
      {
        id: 'gen-east',
        kind: 'generated',
        dataUrl: 'data:image/png;base64,AAAA',
        bytes: 3,
        view: 'east',
      },
    ]);
    expect(drawn.length).toBe(draftTriangles(stackModel()).length / 9);
    expect(Math.min(...drawn)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...drawn)).toBeLessThanOrEqual(210);
    // a face turned to the camera is light, one seen edge on is dark
    const square = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(facing(square, 0, 'south')).toBe(1);
    expect(facing(square, 0, 'east')).toBe(0);
  });
});
