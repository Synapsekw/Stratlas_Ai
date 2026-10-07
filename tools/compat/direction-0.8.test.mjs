// Camera direction keyframes (video layer `directionKeys`, added after 0.9) in a manifest stay
// readable by the builds that came before them: the field is optional, so this build reads a
// manifest without it unchanged, and an 0.8 build opens a manifest with it (its video layer
// schema is not strict) and only leaves the keyframes out. What an older build drops when it
// saves is listed by `downgrade` (the same rule as the corpus).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import { downgrade } from './downgrade.mjs';
import * as v08 from './schema-0.8/index.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const corpus = join(here, 'corpus');
const index = JSON.parse(readFileSync(join(corpus, 'index.json'), 'utf8'));

/** A 0.9 corpus manifest with a video layer, if there is one. */
function manifestWithVideo() {
  for (const p of index.builds['0.9'].files) {
    if (!p.endsWith('manifest.json')) continue;
    const m = JSON.parse(readFileSync(join(corpus, '0.9', p), 'utf8'));
    if (m.layers.some((l) => l.kind === 'video')) return m;
  }
  return null;
}

const keys = [
  { t: 0, yaw: 90, pitch: -30, roll: 0, fill: 'smooth' },
  { t: 4000, yaw: 120, pitch: -35, roll: 0, fill: 'lookAt', target: [10, 0, -20] },
];

describe('direction keyframes and older builds', () => {
  const base = manifestWithVideo();

  it('the corpus has a manifest with a video layer to try them on', () => {
    expect(base).not.toBeNull();
  });

  it('this build reads them back unchanged', () => {
    const m = structuredClone(base);
    const v = m.layers.find((l) => l.kind === 'video');
    v.directionKeys = keys;
    const r = current.parseManifest(m);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.layers.find((l) => l.id === v.id).directionKeys).toEqual(keys);
  });

  it('an 0.8 build opens the manifest and only leaves the keyframes out', () => {
    const m = structuredClone(base);
    const v = m.layers.find((l) => l.kind === 'video');
    v.directionKeys = keys;
    const r = v08.ProjectManifest.safeParse(m);
    expect(r.success, r.success ? '' : r.error.message).toBe(true);
    const { value, removed } = downgrade(v08.ProjectManifest, m);
    expect(removed).toEqual([]);
    const after = value.layers.find((l) => l.id === v.id);
    expect(after.directionKeys).toBeUndefined();
    expect(after.offsetMs).toBe(v.offsetMs);
  });
});
