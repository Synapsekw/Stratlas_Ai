// The M11 survey demos (survey-demo.mjs, stream G13): built from survey_synth.py, they open as
// ordinary projects (valid manifest, DSM and ortho rasters per survey date), carry valid survey/
// side files, stay in their budget and pass the client-data check. Needs the pipeline Python
// (python/.venv after `uv sync`); skipped without it.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../packages/schema/src/index.ts';
import { checkFolder } from './check-no-client-data.mjs';
import { pipelinePython } from './photo-demo.mjs';
import { BUDGET_MB, buildSurveyDemo, SURVEY_DEMOS } from './survey-demo.mjs';

const hasPython = (() => {
  try {
    return existsSync(pipelinePython());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPython)('survey demos', () => {
  let out;
  const built = {};
  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'survey-demo-test-'));
    for (const site of ['earthworks', 'landfill'])
      built[site] = await buildSurveyDemo({ out, site, quick: true });
  }, 180_000);
  afterAll(async () => {
    if (out) await rm(out, { recursive: true, force: true });
  });

  it('are ordinary projects with a DSM and an ortho per survey date', async () => {
    for (const [site, b] of Object.entries(built)) {
      const m = schema.parseManifest(
        JSON.parse(await readFile(join(b.root, 'manifest.json'), 'utf8')),
      );
      expect(m.ok, site).toBe(true);
      if (!m.ok) continue;
      expect(m.value.id).toBe(SURVEY_DEMOS[site].id);
      expect(m.value.name).toBe(SURVEY_DEMOS[site].name);
      expect(m.value.crs).toEqual({ epsg: 32639 });
      expect(m.value.captures).toHaveLength(3);
      for (const c of m.value.captures) {
        const roles = m.value.layers
          .filter((l) => l.kind === 'raster' && l.capture === c.id)
          .map((l) => (l.kind === 'raster' ? l.role : ''));
        expect(roles.sort()).toEqual(['dsm', 'ortho']);
        const grid = JSON.parse(
          await readFile(join(b.root, 'sources', `dsm-${c.id}.json`), 'utf8'),
        );
        expect(grid).toMatchObject({
          schema: 'aio.grid/1',
          kind: 'dsm',
          layer: `dsm-${c.id}`,
          epsg: 32639,
        });
        expect(existsSync(join(b.root, 'sources', grid.file))).toBe(true);
      }
      expect(b.bytes).toBeLessThan(BUDGET_MB * 1e6);
    }
  });

  it('carry valid survey side files and their truth', async () => {
    const root = built.earthworks.root;
    const rd = async (f) => JSON.parse(await readFile(join(root, 'survey', f), 'utf8'));
    const settings = schema.SurveySettings.parse(await rd('settings.json'));
    expect(settings.templateSets).toEqual(['construction']);
    const designs = schema.DesignsFile.parse(await rd('designs.json'));
    expect(designs.designs[0]?.format).toBe('landxml');
    expect(designs.designs[0]?.layers.map((l) => l.kind)).toEqual([
      'surface',
      'surface',
      'alignment',
    ]);
    schema.MeasurementsFile.parse(await rd('measurements.json'));
    const cal = schema.SiteCalibration.parse(await rd('calibration.json'));
    expect(cal.appliedAt).toBeUndefined();
    expect(existsSync(join(root, 'survey', 'calibration', 'site-calibration.jxl'))).toBe(true);
    const truth = JSON.parse(await readFile(join(root, 'truth.json'), 'utf8'));
    expect(truth.verticalShift.shiftM).toBe(0.03);
    expect(truth.checkpoints.planted).toBe('CHK6');
    const lf = schema.SurveySettings.parse(
      JSON.parse(await readFile(join(built.landfill.root, 'survey', 'settings.json'), 'utf8')),
    );
    expect(lf.materials.map((m) => m.id)).toEqual(['msw']);
  });

  it('pass the client-data check', () => {
    for (const b of Object.values(built)) {
      const r = checkFolder(b.root, { maxMb: BUDGET_MB });
      expect(r.findings).toEqual([]);
      expect(r.points).toBeGreaterThan(10);
    }
  });
});
