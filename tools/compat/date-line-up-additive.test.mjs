// Line up dates (plan 2026-10-16-date-line-up), pinned against the 0.11 schema
// (tools/compat/schema-0.11): a capture may carry `lineUp`. The capture object is not strict, so
// 0.11 and every build before this one still open the project, show the date at its file position
// and drop the field on their next manifest save (the known drop). Contract row of 16 Oct 2026.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v011 from './schema-0.11/index.mjs';

const lineUp = { eastM: 2, northM: -0.2, with: 'c1', spreadM: 0.01, at: '2026-10-16T08:00:00Z' };
const manifest = () => ({
  schema: 'aio.project/1',
  id: 'demo',
  name: 'Demo',
  customer: 'Demo',
  site: 'Synthetic',
  crs: { epsg: 32639 },
  origin: [500000, 3200000, 0],
  captures: [
    { id: 'c1', label: 'First', date: '2026-01-10' },
    { id: 'c2', label: 'Second', date: '2026-02-10', lineUp },
  ],
  layers: [],
  severityModels: [],
  classCatalogues: [],
});

describe('a capture line-up is additive, and older builds drop it', () => {
  it('opens in 0.11, which drops the field', () => {
    const r = v011.ProjectManifest.safeParse(manifest());
    expect(r.success).toBe(true);
    expect(r.data.captures[1]).toEqual({ id: 'c2', label: 'Second', date: '2026-02-10' });
    expect('lineUp' in r.data.captures[1]).toBe(false);
  });

  it('is kept by the current schema', () => {
    const r = current.ProjectManifest.safeParse(manifest());
    expect(r.success).toBe(true);
    expect(r.data.captures[1].lineUp).toEqual(lineUp);
  });
});
