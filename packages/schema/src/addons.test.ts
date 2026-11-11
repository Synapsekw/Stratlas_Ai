import { describe, expect, it } from 'vitest';
import {
  ADDON_CATALOGUE_SCHEMA,
  ADDON_SCHEMA,
  AddonCatalogue,
  AddonManifest,
  GROUND_REQUEST,
  PointClassifier,
  POINT_CLASSIFIER_SCHEMA,
  SmrfParams,
} from './addons';
import { CleanupRegion } from './pointcloudCleanup';

const sha = 'a'.repeat(64);
const manifest = {
  schema: ADDON_SCHEMA,
  id: 'road-defects',
  name: 'Road defects',
  version: '1.0.0',
  kind: 'detector',
  licence: 'AGPL-3.0-only',
  source: 'https://example.invalid/card',
  sizeBytes: 30,
  files: [
    { path: 'model.onnx', sizeBytes: 20, sha256: sha },
    { path: 'model.json', sizeBytes: 10, sha256: sha },
  ],
};

describe('aio.addon/1', () => {
  it('takes a valid manifest', () => {
    expect(AddonManifest.safeParse(manifest).success).toBe(true);
  });

  it('refuses a size that is not the sum of the files', () => {
    expect(AddonManifest.safeParse({ ...manifest, sizeBytes: 31 }).success).toBe(false);
  });

  it('refuses a file listed twice, in any case', () => {
    const files = [manifest.files[0], { ...manifest.files[0], path: 'MODEL.onnx' }];
    expect(AddonManifest.safeParse({ ...manifest, files, sizeBytes: 40 }).success).toBe(false);
  });

  it.each(['../model.onnx', '/model.onnx', 'a\\b.onnx', 'a//b', 'addon.json', 'x/../y'])(
    'refuses the path %s',
    (path) => {
      const files = [{ path, sizeBytes: 30, sha256: sha }];
      expect(AddonManifest.safeParse({ ...manifest, files }).success).toBe(false);
    },
  );

  it('refuses an id with capitals and a version that is not three numbers', () => {
    expect(AddonManifest.safeParse({ ...manifest, id: 'Road' }).success).toBe(false);
    expect(AddonManifest.safeParse({ ...manifest, version: '1.0' }).success).toBe(false);
  });

  it('reads a catalogue entry with its archive', () => {
    const doc = {
      schema: ADDON_CATALOGUE_SCHEMA,
      addons: [
        { manifest, archive: { url: 'road-defects-1.0.0.aioaddon', sizeBytes: 40, sha256: sha } },
      ],
    };
    expect(AddonCatalogue.safeParse(doc).success).toBe(true);
    const bad = {
      ...doc,
      addons: [{ manifest, archive: { url: 'x', sizeBytes: 0, sha256: sha } }],
    };
    expect(AddonCatalogue.safeParse(bad).success).toBe(false);
  });
});

describe('aio.point-classifier/1', () => {
  it('takes SMRF settings and the request default fits them', () => {
    expect(SmrfParams.safeParse(GROUND_REQUEST).success).toBe(true);
    const doc = { schema: POINT_CLASSIFIER_SCHEMA, method: 'smrf', smrf: GROUND_REQUEST };
    expect(PointClassifier.safeParse(doc).success).toBe(true);
    expect(
      PointClassifier.safeParse({ ...doc, smrf: { ...GROUND_REQUEST, cell: 0 } }).success,
    ).toBe(false);
  });
});

describe('CleanupRegion depth band', () => {
  const region = {
    id: 'r1',
    shape: 'lasso',
    viewProj: Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0)),
    polygon: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    action: { kind: 'class', value: 6 },
  };
  it('is optional and must not be inverted', () => {
    expect(CleanupRegion.safeParse(region).success).toBe(true);
    expect(CleanupRegion.safeParse({ ...region, depth: { near: 2, far: 5 } }).success).toBe(true);
    expect(CleanupRegion.safeParse({ ...region, depth: { near: 5, far: 2 } }).success).toBe(false);
  });
});
