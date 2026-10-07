// M10's contracts are additive (plan "Global constraints", G0), pinned here against the 0.9.0
// schema (tools/compat/schema-0.9):
// - a project as 0.9 wrote it (corpus/0.9) round-trips unchanged through the 0.10 schemas;
// - every existing file 0.10 writes, including a manifest that holds the layers a processing run
//   adds (mesh GLB, COPC cloud, kit-pyramid ortho and DSM), still parses with the 0.9 schema;
// - new M10 data lives in new files 0.9 never reads, and a layer kind 0.9 does not know would make
//   it refuse the whole manifest, which is why M10 adds none (0.10 sets such layers aside).
// The one known exception: the job index (userData jobs.json) lists jobs of the new pipelines,
// which 0.9's index reader skips one by one (main/jobs/store.ts) instead of refusing the file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v09 from './schema-0.9/index.mjs';
import { familyOf } from './families.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const corpus = join(here, 'corpus');
const index = JSON.parse(readFileSync(join(corpus, 'index.json'), 'utf8'));
const load = (version, p) => JSON.parse(readFileSync(join(corpus, version, p), 'utf8'));
const rel = (p) => p.slice(p.indexOf('/') + 1);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('a project written by 0.9', () => {
  for (const p of index.builds['0.9'].files) {
    it(`${p} round-trips unchanged through the 0.10 schemas`, () => {
      const raw = load('0.9', p);
      const schema = familyOf(rel(p))?.pick(current);
      expect(schema, `no 0.10 schema for ${p}`).toBeTruthy();
      const r = schema.safeParse(raw);
      expect(r.success, r.success ? '' : r.error.message).toBe(true);
      expect(r.data).toEqual(raw);
      expect(JSON.stringify(r.data)).toBe(JSON.stringify(raw));
      if (rel(p) === 'manifest.json')
        expect(current.parseManifest(raw)).toEqual({ ok: true, value: raw });
    });
  }
});

describe('existing files 0.10 writes stay readable by 0.9', () => {
  const base = load('0.9', 'tank-farm/manifest.json');

  it('a manifest with the layers of a processing run parses with the 0.9 schema, nothing lost', () => {
    const capture = base.captures[0]?.id;
    const run = [
      {
        kind: 'mesh',
        id: 'run1-mesh',
        name: 'Processed mesh',
        visible: true,
        ...(capture ? { capture } : {}),
        src: { path: 'photogrammetry/run1/mesh.glb' },
        transform: IDENTITY,
      },
      {
        kind: 'pointcloud',
        id: 'run1-cloud',
        name: 'Processed cloud',
        visible: true,
        src: { path: 'photogrammetry/run1/cloud.copc.laz' },
        format: 'copc',
        pointCount: 1_250_000,
      },
      {
        kind: 'raster',
        id: 'run1-ortho',
        name: 'Processed ortho',
        visible: true,
        src: { path: 'rasters/run1-ortho' },
        role: 'ortho',
        format: 'kit-pyramid',
      },
      {
        kind: 'raster',
        id: 'run1-dsm',
        name: 'Processed DSM',
        visible: true,
        src: { path: 'rasters/run1-dsm' },
        role: 'dsm',
        format: 'kit-pyramid',
      },
    ];
    const next = { ...base, layers: [...base.layers, ...run] };
    const written = current.keepUnknownLayers(base, current.ProjectManifest.parse(next));
    expect(written.ok).toBe(true);
    const disk = JSON.parse(JSON.stringify(written.value));
    const r = v09.ProjectManifest.safeParse(disk);
    expect(r.success, r.success ? '' : r.error.message).toBe(true);
    expect(r.data).toEqual(disk);
  });

  it('settings written by 0.10 parse with the 0.9 schema (globe settings have their own file)', () => {
    const settings = current.Settings.parse(load('0.9', 'userData/settings.json'));
    expect(Object.keys(current.Settings.shape).sort()).toEqual(
      Object.keys(v09.Settings.shape).sort(),
    );
    expect(v09.Settings.safeParse(settings).success).toBe(true);
  });

  it('new M10 files are families 0.9 does not know, so it never reads them', () => {
    const known09 = new Set(v09.SCHEMA_REGISTRY.map((e) => e.family));
    const m10 = current.SCHEMA_REGISTRY.filter((e) => e.since === '0.10');
    expect(m10.length).toBeGreaterThan(0);
    for (const e of m10) expect(known09.has(e.family), e.family).toBe(false);
  });

  it('the job index lists M10 jobs that 0.9 skips one by one (the known exception)', () => {
    const job = {
      id: '20261007-090000-photo-align-a1b2',
      pipeline: 'photo.align',
      project: 'D:/data/projects/demo',
      params: { photos: { layer: 'photos' }, preset: 'standard' },
      status: 'failed',
      progress: 0,
      steps: [],
      artifacts: [],
      createdAt: '2026-10-07T09:00:00Z',
      updatedAt: '2026-10-07T09:00:00Z',
    };
    expect(current.JobRecord.safeParse(job).success).toBe(true);
    expect(v09.JobRecord.safeParse(job).success).toBe(false);
    expect(v09.JobRecord.safeParse({ ...job, pipeline: 'road.build' }).success).toBe(true);
  });
});

describe('a layer kind from a newer build', () => {
  it('makes 0.9 refuse the manifest, while 0.10 opens it and keeps the layer on save', () => {
    const base = load('0.9', 'tank-farm/manifest.json');
    const newer = { kind: 'gaussian-splat', id: 'splat-1', name: 'Splat', src: { path: 'x.spz' } };
    const raw = { ...base, layers: [...base.layers, newer] };
    expect(v09.parseManifest(raw).ok).toBe(false);
    const r = current.parseManifestTolerant(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unknownLayers).toEqual([newer]);
    const saved = current.keepUnknownLayers(raw, r.value.manifest);
    expect(saved.ok && saved.value.layers.at(-1)).toEqual(newer);
  });
});
