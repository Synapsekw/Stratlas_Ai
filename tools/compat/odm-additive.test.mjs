// The ODM engine (plan 2026-10-14-odm-engine) is additive for files 0.11 reads (tools/compat/schema-0.11):
// - run.json gains an optional `engine`; 0.11's PhotoRun is loose and keeps reading the run;
// - settings.json gains an optional `processing`; 0.11 drops what it does not know.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const run = {
  schema: 'aio.photo-run/1',
  id: 'r1',
  createdAt: '2026-10-14T10:00:00Z',
  status: 'aligned',
  preset: 'standard',
  photos: { source: { folders: ['photos'] }, count: 3 },
  cameras: [],
  crs: { epsg: 32639 },
  stages: [{ name: 'sfm', state: 'done' }],
  outputs: { layers: [], tilesets: [], files: [] },
  versions: { pack: '0.8.0', odm: '3.6.2' },
  engine: { name: 'odm', version: '3.6.2', gpu: { features: true, dense: false } },
};

describe('the ODM engine is additive', () => {
  it('0.11 reads a run made by ODM', () => {
    expect(current.PhotoRun.safeParse(run).success).toBe(true);
    expect(v011.PhotoRun.safeParse(run).success).toBe(true);
  });

  it('0.11 reads settings with the processing block', () => {
    const s = {
      cloudAi: false,
      theme: 'dark',
      sidebarCollapsed: false,
      dataRoot: 'E:\\Data',
      routes: [],
      processing: { odm: { gpu: 'off' } },
    };
    expect(current.Settings.safeParse(s).success).toBe(true);
    expect(v011.Settings.safeParse(s).success).toBe(true);
  });

  it('registers the install record', () => {
    expect(current.SCHEMA_REGISTRY.find((e) => e.family === 'aio.odm-install')).toMatchObject({
      version: 1,
    });
  });
});
