import { GROUND_REQUEST, type PointClassifier } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { GROUND_ADDON_MISSING, groundGate, LIFT_ADDON_MISSING, liftRefusal } from './gates';

const classifier: PointClassifier = {
  schema: 'aio.point-classifier/1',
  method: 'smrf',
  smrf: { cell: 2, slope: 0.2, window: 16, threshold: 0.45, scalar: 1.2 },
};
const noise = (extra: Record<string, unknown> = {}) => ({
  mode: 'noise',
  layerId: 'cloud',
  src: 'layers/cloud.copc.laz',
  outlier: { meanK: 8, multiplier: 2 },
  ...extra,
});
const has = () => Promise.resolve(classifier);
const none = () => Promise.resolve(null);

describe('groundGate', () => {
  it('replaces the ground the window sent with the add-on settings', async () => {
    const r = await groundGate('pointcloud.clean', noise({ ground: GROUND_REQUEST }), {
      packVersion: '0.35.0',
      classifier: has,
    });
    expect(r).toEqual({ ok: true, params: noise({ ground: classifier.smrf }) });
    // a development checkout counts as new enough
    expect(
      await groundGate('pointcloud.clean', noise({ ground: { cell: 99 } }), {
        packVersion: 'dev',
        classifier: has,
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
        await groundGate(pipeline, { ...params }, { packVersion: '0.20.0', classifier: none }),
      ).toEqual({ ok: true, params });
    }
  });

  it('refuses ground on an old pack and without the add-on', async () => {
    expect(
      await groundGate('pointcloud.clean', noise({ ground: GROUND_REQUEST }), {
        packVersion: '0.34.0',
        classifier: has,
      }),
    ).toEqual({
      ok: false,
      error:
        'Marking ground points (Ground classifier add-on) needs processing tools 0.35.0 or later (these are 0.34.0). Update them in Settings, Processing tools.',
    });
    expect(
      await groundGate('pointcloud.clean', noise({ ground: GROUND_REQUEST }), {
        packVersion: '0.35.0',
        classifier: none,
      }),
    ).toEqual({ ok: false, error: GROUND_ADDON_MISSING });
  });
});

describe('liftRefusal', () => {
  it('needs a new enough pack and the Segmentation add-on', async () => {
    const yes = () => Promise.resolve(true);
    const no = () => Promise.resolve(false);
    expect(
      await liftRefusal('walk.process', { packVersion: '0.1.0', segmenterInstalled: no }),
    ).toBeNull();
    expect(
      await liftRefusal('segment.lift', { packVersion: '0.34.0', segmenterInstalled: yes }),
    ).toMatch(/needs processing tools 0.35.0 or later \(these are 0.34.0\)/);
    expect(
      await liftRefusal('segment.lift', { packVersion: '0.35.0', segmenterInstalled: no }),
    ).toBe(LIFT_ADDON_MISSING);
    expect(
      await liftRefusal('segment.lift', { packVersion: '0.35.0', segmenterInstalled: yes }),
    ).toBeNull();
  });
});
