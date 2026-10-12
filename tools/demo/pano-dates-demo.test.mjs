// The panorama dates project (pano-dates-demo.mjs) opens as an ordinary project: a valid
// manifest with three dated Panoramas layers whose images are on disk.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../packages/schema/src/index.ts';
import { PANO_DATES, writePanoDatesProject } from './pano-dates-demo.mjs';

describe('pano dates demo', () => {
  let data;
  let dir;
  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), 'pano-dates-demo-'));
    dir = await writePanoDatesProject(data);
  }, 60_000);
  afterAll(async () => {
    await rm(data, { recursive: true, force: true });
  });

  it('writes a valid manifest with one Panoramas layer per date, images on disk', async () => {
    expect(dir).toBe(join(data, 'projects', 'e2e-pano-dates'));
    const m = schema.ProjectManifest.parse(
      JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')),
    );
    expect(m.captures.map((c) => c.id)).toEqual(PANO_DATES.map((d) => d.id));
    const panos = m.layers.filter((l) => l.kind === 'panoramas');
    expect(panos.map((l) => l.capture)).toEqual(['sep', 'oct', 'nov']);
    for (const l of panos)
      for (const p of l.items) expect(existsSync(join(dir, p.src.path))).toBe(true);
    expect(existsSync(join(dir, 'models', 'quad.glb'))).toBe(true);
  });
});
