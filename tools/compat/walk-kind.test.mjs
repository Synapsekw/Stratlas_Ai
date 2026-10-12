// The 360 walk layer kind (Walks 360, "Migration on open" and "Contract (major)"). From 0.12 a walk
// is a layer of the manifest. Builds that know nothing of the kind behave as the upgrade note says:
// - 0.10 and 0.11 keep the layer as an opaque entry, show nothing and save it back unchanged;
// - 0.9 and older refuse the manifest (a layer kind they do not know);
// - this build reads it as a walk layer.
// The project is corpus/0.11/walk-layer (built by build-corpus.mjs from this build's schema).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v08 from './schema-0.8/index.mjs';
import * as v09 from './schema-0.9/index.mjs';
import * as v010 from './schema-0.10/index.mjs';
import * as v011 from './schema-0.11/index.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const walkProject = JSON.parse(
  readFileSync(join(here, 'corpus', '0.11', 'walk-layer', 'manifest.json'), 'utf8'),
);
const walkLayer = walkProject.layers.at(-1);

describe('a project that holds a walk layer', () => {
  it('has the walk as its last layer', () => {
    expect(walkLayer.kind).toBe('walk');
    expect(walkProject.layers).toHaveLength(2);
  });

  for (const [version, schemas] of [
    ['0.10', v010],
    ['0.11', v011],
  ]) {
    it(`${version} keeps the walk layer opaque and saves it back unchanged`, () => {
      const r = schemas.parseManifestTolerant(walkProject);
      expect(r.ok).toBe(true);
      expect(r.value.unknownLayers).toHaveLength(1);
      expect(r.value.unknownLayers[0].kind).toBe('walk');
      expect(r.value.manifest.layers.map((l) => l.id)).toEqual(['closeups']);
      const saved = schemas.keepUnknownLayers(walkProject, r.value.manifest);
      expect(saved.ok).toBe(true);
      expect(saved.value.layers.at(-1)).toEqual(walkLayer);
      expect(JSON.stringify(saved.value.layers.at(-1))).toBe(JSON.stringify(walkLayer));
    });
  }

  for (const [version, schemas] of [
    ['0.9', v09],
    ['0.8', v08],
  ]) {
    it(`${version} refuses the project (expected; the upgrade note says so)`, () => {
      const r = schemas.parseManifest(walkProject);
      expect(r.ok).toBe(false);
    });
  }

  it('this build reads it as a walk layer', () => {
    const r = current.parseManifest(walkProject);
    expect(r.ok).toBe(true);
    const layer = r.value.layers.at(-1);
    expect(layer.kind).toBe('walk');
    expect(layer.id).toBe('walk-w1');
    expect(layer.place.quality).toBe('good');
    expect(layer.place.pins).toHaveLength(2);
    expect(layer).toEqual(walkLayer);
  });

  it('this build saves it back unchanged', () => {
    const r = current.parseManifest(walkProject);
    expect(JSON.stringify(r.value)).toBe(JSON.stringify(walkProject));
  });
});
