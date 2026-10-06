import { describe, expect, it } from 'vitest';
import { DetectorModelCard, InferenceItem, InferenceSettings } from './index';

const card = {
  schema: 'aio.detector/1',
  name: 'Marker test detector',
  version: '1.0.0',
  layout: 'yolo-v8',
  input: { width: 640, height: 640, tensor: 'nchw', color: 'rgb', scale: 255 },
  classes: ['marker'],
  licence: 'MIT',
  source: 'Stratlas test fixture',
  sha256: 'a'.repeat(64),
};

describe('detector model cards (aio.detector/1)', () => {
  it('accepts a card with an SPDX licence', () => {
    expect(DetectorModelCard.safeParse(card).success).toBe(true);
    expect(DetectorModelCard.safeParse({ ...card, licence: 'Apache-2.0 OR MIT' }).success).toBe(
      true,
    );
  });

  it('refuses a card without classes, licence or a real hash, or with an unknown layout', () => {
    expect(DetectorModelCard.safeParse({ ...card, classes: [] }).success).toBe(false);
    const noLicence: Partial<typeof card> = { ...card };
    delete noLicence.licence;
    expect(DetectorModelCard.safeParse(noLicence).success).toBe(false);
    expect(DetectorModelCard.safeParse({ ...card, sha256: 'abc' }).success).toBe(false);
    expect(DetectorModelCard.safeParse({ ...card, layout: 'yolo-v11' }).success).toBe(false);
    expect(DetectorModelCard.safeParse({ ...card, extra: 1 }).success).toBe(false);
  });

  it('runs on a photo or a video frame', () => {
    expect(InferenceItem.safeParse({ layer: 'photos', photo: 'p1' }).success).toBe(true);
    expect(InferenceItem.safeParse({ layer: 'clip', t: 12.5 }).success).toBe(true);
    expect(InferenceItem.safeParse({ layer: 'clip' }).success).toBe(false);
  });

  it('keeps the model folder, provider and memory cap in settings', () => {
    expect(InferenceSettings.parse({})).toEqual({});
    expect(
      InferenceSettings.safeParse({ modelsDir: 'D:/models', provider: 'cpu', memoryCapMb: 2048 })
        .success,
    ).toBe(true);
    expect(InferenceSettings.safeParse({ provider: 'cuda' }).success).toBe(false);
  });
});
