// @vitest-environment jsdom
import type { Capture, HeightTiles, ProjectManifest, SurveyQa } from '@aio/schema';
import { SurveyCleanupParams, TerrainEdit } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { editFrom, extentRing } from './qaHelpers';
import {
  cloudLayers,
  DTM_PRESETS,
  dtmFilterBlock,
  isHeld,
  sourceOfCapture,
  surfaceOfCapture,
} from './qaStore';
import { groupByMonth } from './SurveyPicker';

const surface = (id: string, kind: 'dsm' | 'cloud' | 'dtm', capture?: string): HeightTiles => ({
  schema: 'aio.height-tiles/1',
  id,
  name: id,
  source: { kind, layer: `l-${id}` },
  ...(capture ? { capture } : {}),
  crs: { epsg: 32639 },
  cellM: 0.5,
  tileSize: 256,
  originE: 1000,
  originN: 2000,
  cols: 1,
  rows: 1,
  levels: 1,
  bounds: [1000, 2000, 10, 1100, 2050, 20],
  tiles: ['0_0'],
  fingerprint: 'sha256:x',
  preparedAt: '2026-10-09T00:00:00Z',
});

describe('survey QA helpers', () => {
  it('groups surveys by year and month, newest first', () => {
    const caps: Capture[] = [
      { id: 'a', label: 'A', date: '2026-01-31' },
      { id: 'b', label: 'B', date: '2026-03-02' },
      { id: 'c', label: 'C', date: '2026-03-28' },
      { id: 'd', label: 'D', date: '2025-12-01' },
    ];
    const g = groupByMonth(caps);
    expect(g.map((y) => y.year)).toEqual(['2026', '2025']);
    expect(g[0]?.months.map((m) => [m.month, m.captures.map((c) => c.id)])).toEqual([
      ['March', ['c', 'b']],
      ['January', ['a']],
    ]);
    expect(g[1]?.months[0]?.month).toBe('December');
  });

  it("picks a survey's own surface: a DSM before a cloud before a DTM, never a cleaned one", () => {
    const s = [surface('t', 'dtm', 'd2'), surface('c', 'cloud', 'd2'), surface('x', 'dsm')];
    expect(surfaceOfCapture(s, 'd2')?.id).toBe('c');
    expect(surfaceOfCapture([...s, surface('d', 'dsm', 'd2')], 'd2')?.id).toBe('d');
    expect(surfaceOfCapture(s, 'd9')).toBeNull();
  });

  it('prepares a survey from its DSM layer, else its point cloud', () => {
    const m = {
      captures: [{ id: 'd1', label: 'One', date: '2026-01-01' }],
      layers: [
        { kind: 'pointcloud', id: 'pc', capture: 'd1' },
        { kind: 'raster', id: 'ortho', role: 'ortho', capture: 'd1' },
        { kind: 'raster', id: 'dsm', role: 'dsm', capture: 'd1' },
      ],
    } as unknown as ProjectManifest;
    expect(sourceOfCapture(m, 'd1')).toEqual({ kind: 'dsm', layer: 'dsm' });
    const noDsm = { ...m, layers: m.layers.filter((l) => l.id !== 'dsm') } as ProjectManifest;
    expect(sourceOfCapture(noDsm, 'd1')).toEqual({ kind: 'cloud', layer: 'pc' });
    expect(sourceOfCapture(m, 'd2')).toBeNull();
  });

  it('makes valid cleanups and crops; a crop to another survey keeps its extent', () => {
    const ring = extentRing(surface('a', 'dsm', 'd1'));
    expect(ring).toEqual([
      [1000, 2000],
      [1100, 2000],
      [1100, 2050],
      [1000, 2050],
    ]);
    const crop = editFrom('crop', 'dsm-d2', ring, 'Extent of A');
    const clean = editFrom('cleanup', 'dsm-d2', ring, 'Excavator', 'thin-plate');
    expect(TerrainEdit.safeParse(crop).success).toBe(true);
    expect(TerrainEdit.safeParse(clean).success).toBe(true);
    expect(crop.method).toBeUndefined();
    expect(clean).toMatchObject({ kind: 'cleanup', method: 'thin-plate', enabled: true });
    expect(crop.id).not.toBe(clean.id);
  });

  it('holds a survey that failed until a person releases it', () => {
    const qa = (status: SurveyQa['status']): SurveyQa => ({
      schema: 'aio.survey-qa/1',
      capture: 'd3',
      level: 'strict',
      status,
      checkedAt: '2026-10-09T00:00:00Z',
    });
    expect(isHeld(qa('hold'))).toBe(true);
    expect(isHeld(qa('fail'))).toBe(true);
    expect(isHeld(qa('released'))).toBe(false);
    expect(isHeld(qa('pass'))).toBe(false);
    expect(isHeld(undefined)).toBe(false);
  });

  it('says why the DTM filter cannot run: no cloud layer, no pipeline pack, no PDAL', () => {
    const none = { layers: [] } as unknown as Pick<ProjectManifest, 'layers'>;
    const cloud = {
      layers: [
        { id: 'pc-d1', kind: 'pointcloud', name: 'Survey 1 cloud', capture: 'd1' },
        { id: 'dsm-d1', kind: 'raster', name: 'Survey 1 DSM', role: 'dsm' },
      ],
    } as unknown as Pick<ProjectManifest, 'layers'>;
    expect(cloudLayers(cloud)).toEqual([{ id: 'pc-d1', name: 'Survey 1 cloud', capture: 'd1' }]);
    expect(dtmFilterBlock(none, { found: true, pdal: true })).toMatch(/has none/);
    expect(dtmFilterBlock(cloud, null)).toMatch(/Checking/);
    expect(dtmFilterBlock(cloud, { found: false })).toMatch(/not installed/);
    expect(dtmFilterBlock(cloud, { found: true, pdal: false })).toMatch(/PDAL/);
    expect(dtmFilterBlock(cloud, { found: true, pdal: true })).toBeNull();
    // the four presets of survey.cleanup's schema, in order
    expect(DTM_PRESETS.map((p) => p.id)).toEqual(
      SurveyCleanupParams.shape.dtmFilter.unwrap().shape.preset.options,
    );
  });
});
