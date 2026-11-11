import { emptyCleanup, GROUND_REQUEST, type PointClassifier } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { fakeAddonArchive } from './addon.fakes';
import {
  depthBandRefusal,
  GROUND_ADDON_MISSING,
  groundGate,
  LIFT_ADDON_MISSING,
  liftRefusal,
  type GroundAddon,
} from './gates';

const classifier: PointClassifier = {
  schema: 'aio.point-classifier/1',
  method: 'smrf',
  smrf: { cell: 2, slope: 0.2, window: 16, threshold: 0.45, scalar: 1.2 },
};
const manifest = (minPipelinePack?: string) =>
  fakeAddonArchive({
    id: 'ground-classifier',
    kind: 'point-classifier',
    name: 'Ground classifier',
    ...(minPipelinePack ? { minPipelinePack } : {}),
  }).manifest;
const noise = (extra: Record<string, unknown> = {}) => ({
  mode: 'noise',
  layerId: 'cloud',
  src: 'layers/cloud.copc.laz',
  outlier: { meanK: 8, multiplier: 2 },
  ...extra,
});
const has = (min?: string) => (): Promise<GroundAddon> =>
  Promise.resolve({ classifier, manifest: manifest(min) });
const none = () => Promise.resolve(null);

describe('groundGate', () => {
  it('replaces the ground the window sent with the add-on settings', async () => {
    const r = await groundGate('pointcloud.clean', noise({ ground: GROUND_REQUEST }), {
      packVersion: '0.35.0',
      addon: has(),
    });
    expect(r).toEqual({ ok: true, params: noise({ ground: classifier.smrf }) });
    // a development checkout counts as new enough
    expect(
      await groundGate('pointcloud.clean', noise({ ground: { cell: 99 } }), {
        packVersion: 'dev',
        addon: has('9.0.0'),
      }),
    ).toMatchObject({ ok: true, params: { ground: classifier.smrf } });
  });

  it('leaves a run without ground, a save and other pipelines alone', async () => {
    for (const [pipeline, params] of [
      ['pointcloud.clean', noise()],
      ['pointcloud.clean', { mode: 'save', ground: GROUND_REQUEST }],
      ['walk.process', { ground: GROUND_REQUEST }],
    ] as const) {
      expect(
        await groundGate(pipeline, { ...params }, { packVersion: '0.20.0', addon: none }),
      ).toEqual({ ok: true, params });
    }
  });

  it('refuses ground on an old pack, without the add-on, and below its minPipelinePack', async () => {
    expect(
      await groundGate('pointcloud.clean', noise({ ground: GROUND_REQUEST }), {
        packVersion: '0.34.0',
        addon: has(),
      }),
    ).toEqual({
      ok: false,
      error:
        'Marking ground points (Ground classifier add-on) needs processing tools 0.35.0 or later (these are 0.34.0). Update them in Settings, Processing tools.',
    });
    expect(
      await groundGate('pointcloud.clean', noise({ ground: GROUND_REQUEST }), {
        packVersion: '0.35.0',
        addon: none,
      }),
    ).toEqual({ ok: false, error: GROUND_ADDON_MISSING });
    expect(
      await groundGate('pointcloud.clean', noise({ ground: GROUND_REQUEST }), {
        packVersion: '0.35.0',
        addon: has('0.36.0'),
      }),
    ).toEqual({
      ok: false,
      error:
        'Ground classifier needs processing tools 0.36.0 or later (these are 0.35.0). Update them in Settings, Processing tools.',
    });
  });
});

describe('liftRefusal', () => {
  it('needs a new enough pack and the Segmentation add-on', async () => {
    const seg = (min?: string) => () =>
      Promise.resolve(
        fakeAddonArchive({
          id: 'segmentation',
          kind: 'segmenter',
          name: 'Segmentation',
          ...(min ? { minPipelinePack: min } : {}),
        }).manifest,
      );
    const no = () => Promise.resolve(null);
    expect(await liftRefusal('walk.process', { packVersion: '0.1.0', segmenter: no })).toBeNull();
    expect(await liftRefusal('segment.lift', { packVersion: '0.34.0', segmenter: seg() })).toMatch(
      /needs processing tools 0.35.0 or later \(these are 0.34.0\)/,
    );
    expect(await liftRefusal('segment.lift', { packVersion: '0.35.0', segmenter: no })).toBe(
      LIFT_ADDON_MISSING,
    );
    expect(
      await liftRefusal('segment.lift', { packVersion: '0.35.0', segmenter: seg('0.36.0') }),
    ).toMatch(/^Segmentation needs processing tools 0.36.0 or later/);
    expect(
      await liftRefusal('segment.lift', { packVersion: '0.35.0', segmenter: seg() }),
    ).toBeNull();
  });
});

describe('depthBandRefusal', () => {
  const region = (depth?: { near: number; far: number }) => ({
    id: 'r1',
    viewProj: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
    polygon: [
      [0, 0],
      [0.5, 0],
      [0, 0.5],
    ],
    action: { kind: 'delete' },
    ...(depth ? { depth } : {}),
  });
  const recipe = (depth?: { near: number; far: number }) => ({
    ...emptyCleanup('cloud'),
    regions: [region(depth)],
  });

  it('refuses a save or an export of a depth band on a pack that cannot read it', () => {
    const banded = recipe({ near: 1, far: 9 });
    const msg =
      'This cleanup has regions from Classify on point cloud, which need processing tools 0.35.0 or later (these are 0.34.0). Update them in Settings, Processing tools.';
    expect(depthBandRefusal('pointcloud.clean', { mode: 'save', recipe: banded }, '0.34.0')).toBe(
      msg,
    );
    expect(depthBandRefusal('survey.export', { what: 'cloud', cleanup: banded }, '0.34.0')).toBe(
      msg,
    );
  });

  it('lets a band through on a new pack, and a recipe without bands anywhere', () => {
    const banded = recipe({ near: 1, far: 9 });
    expect(
      depthBandRefusal('pointcloud.clean', { mode: 'save', recipe: banded }, '0.35.0'),
    ).toBeNull();
    expect(depthBandRefusal('survey.export', { cleanup: banded }, 'dev')).toBeNull();
    expect(
      depthBandRefusal('pointcloud.clean', { mode: 'save', recipe: recipe() }, '0.20.0'),
    ).toBeNull();
    expect(depthBandRefusal('survey.export', { what: 'surface' }, '0.20.0')).toBeNull();
    expect(depthBandRefusal('walk.process', { recipe: banded }, '0.20.0')).toBeNull();
  });
});
