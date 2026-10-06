import { changeProducers, type ChangePairContext } from '@aio/change';
import type { Layer, ProjectManifest, Quat } from '@aio/schema';
import { ChangeFramesParams } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  ensureFramesProducer,
  framePairs,
  framesProducer,
  type FramesProducerDeps,
} from './frames';

/** Heading east, 60 degrees down (Euler YXZ yaw -90, pitch -60). */
const Q: Quat = (() => {
  const h = (d: number) => (d * Math.PI) / 360;
  const [yx, yy, yz, yw] = [0, Math.sin(h(-90)), 0, Math.cos(h(-90))];
  const [px, py, pz, pw] = [Math.sin(h(-60)), 0, 0, Math.cos(h(-60))];
  return [
    yw * px + yx * pw + yy * pz - yz * py,
    yw * py - yx * pz + yy * pw + yz * px,
    yw * pz + yx * py - yy * px + yz * pw,
    yw * pw - yx * px - yy * py - yz * pz,
  ];
})();

const photos = (id: string, xs: (number | null)[]): Layer =>
  ({
    kind: 'photos',
    id,
    name: id,
    visible: true,
    opacity: 1,
    items: xs.map((x, i) => ({
      id: `${id}-${String(i)}`,
      src: { path: `photos/${id}-${String(i)}.jpg` },
      ...(x === null ? {} : { pos: [x, 30, 0], q: Q }),
    })),
  }) as Layer;

function ctx(from: Layer[], to: Layer[]): ChangePairContext {
  return {
    projectId: 'p',
    manifest: { layers: [...from, ...to] } as unknown as ProjectManifest,
    from: 'c1',
    to: 'c2',
    layersFrom: from,
    layersTo: to,
  };
}

function deps(root: string | null = 'E:/p') {
  const started: Parameters<FramesProducerDeps['start']>[0][] = [];
  const d: FramesProducerDeps = {
    root: () => root ?? undefined,
    start: (req) => {
      started.push(req);
      return Promise.resolve({ ok: true, jobId: 'job-1' });
    },
  };
  return { d, started };
}

describe('the frames change producer', () => {
  const a = photos('pa', [0, 40, null]);
  const b = photos('pb', [0.6, 41, 500]);

  it('needs photos with camera positions on both dates', () => {
    const p = framesProducer(deps().d);
    expect(p.id).toBe('frames');
    expect(p.kinds).toEqual(['frame']);
    expect(p.available(ctx([a], [b]))).toBe(true);
    expect(p.available(ctx([photos('none', [null])], [b]))).toMatch(/camera positions/);
    expect(p.available(ctx([a], []))).toMatch(/camera positions/);
  });

  it('pairs the photos of the two dates by pose', () => {
    const pairs = framePairs(ctx([a], [b]));
    expect(pairs.map((x) => [x.a.photo, x.b.photo])).toEqual([
      ['pa-0', 'pb-0'],
      ['pa-1', 'pb-1'],
    ]);
  });

  it('starts change.frames with the dates and the pairs', async () => {
    const { d, started } = deps();
    const r = await framesProducer(d).run(ctx([a], [b]));
    expect(r).toEqual({ ok: true, jobId: 'job-1' });
    expect(started).toHaveLength(1);
    const req = started[0];
    expect(req?.pipeline).toBe('change.frames');
    expect(req?.project).toBe('E:/p');
    const params = ChangeFramesParams.parse(req?.params);
    expect(params.from).toBe('c1');
    expect(params.to).toBe('c2');
    expect(params.pairs).toEqual([
      { a: { layer: 'pa', photo: 'pa-0' }, b: { layer: 'pb', photo: 'pb-0' } },
      { a: { layer: 'pa', photo: 'pa-1' }, b: { layer: 'pb', photo: 'pb-1' } },
    ]);
  });

  it('says why it cannot run', async () => {
    const none = await framesProducer(deps(null).d).run(ctx([a], [b]));
    expect(none).toEqual({ ok: false, error: expect.stringMatching(/Open the project/) as string });
    const apart = await framesProducer(deps().d).run(ctx([a], [photos('far', [900])]));
    expect(apart).toEqual({ ok: false, error: expect.stringMatching(/same view/) as string });
  });

  it('registers once', () => {
    const before = changeProducers().filter((p) => p.id === 'frames').length;
    ensureFramesProducer(deps().d);
    ensureFramesProducer(deps().d);
    expect(before).toBe(0);
    expect(changeProducers().filter((p) => p.id === 'frames')).toHaveLength(1);
  });
});
