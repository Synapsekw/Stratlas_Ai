// RF origins (spec 2026-10-18-rf-coverage-simplify, "Data") are additive, pinned against the 0.21
// `aio.rf-sectors/1` schema (tools/compat/rf-sectors-v1, extracted from 6a2ba0dc):
// - who set each planned value lives in the sidecar `rf/sectors.origins.json` (`aio.rf-origins/1`),
//   a file 0.21 never opens;
// - `rf/sectors.json` as this build writes it (`splitRfOrigins`) has no origin key, so 0.19 to
//   0.21 read it, and their strict schema keeps every value.
import { describe, expect, it } from 'vitest';
import * as current from '../../packages/schema/src/index.ts';
import * as v1 from './rf-sectors-v1/rf.mjs';

/** A plan in memory: one unit by the AI (equipment) and the rules (carrier), one by hand. */
function planned() {
  return {
    schema: 'aio.rf-sectors/1',
    sectors: [{ id: 'sec-a', name: 'Sector A', antennaIds: ['ant-a', 'ant-b'] }],
    antennas: [
      {
        antennaId: 'ant-a',
        equipment: { kind: 'aau', aau: 'generic-aau-64t' },
        etiltDeg: 4,
        active: true,
        origins: { equipment: { by: 'ai', confidence: 'medium' }, etiltDeg: { by: 'user' } },
        carriers: [
          {
            id: 'c1',
            tech: 'nr',
            band: 'n78',
            bandwidthMhz: 100,
            feederLossDb: 0,
            origin: { by: 'rules', confidence: 'low' },
          },
        ],
      },
      { antennaId: 'ant-b', active: true, carriers: [] },
    ],
    study: current.DEFAULT_RF_STUDY,
  };
}

describe('rf origins are additive', () => {
  it('0.21 refuses origin keys inside rf/sectors.json (why they live in a sidecar)', () => {
    expect(v1.parseRfSectors(planned()).ok).toBe(false);
  });

  it('0.21 reads the sectors file this build writes, keeping every value', () => {
    const { file } = current.splitRfOrigins(planned());
    const disk = JSON.parse(JSON.stringify(file));
    const old = v1.parseRfSectors(disk);
    expect(old.ok).toBe(true);
    expect(old.value).toEqual(current.RfSectorsFile.parse(disk));
  });

  it('the sidecar is a family 0.21 does not know, at its own path', () => {
    expect(v1.RF_SECTORS_PATH).toBe('rf/sectors.json');
    expect(current.RF_ORIGINS_PATH).toBe('rf/sectors.origins.json');
    expect(Object.values(v1)).not.toContain(current.RF_ORIGINS_PATH);
  });

  it('a plan with every field set (sectors, settings, carriers, study) reads both ways', () => {
    const { file } = current.splitRfOrigins(planned());
    const full = {
      ...file,
      sectors: [{ ...file.sectors[0], name: 'Sector A' }],
      study: { ...current.DEFAULT_RF_STUDY, radiusM: 1000, gridResolutionM: 20 },
    };
    const disk = JSON.parse(JSON.stringify(current.RfSectorsFile.parse(full)));
    const old = v1.parseRfSectors(disk);
    expect(old.ok).toBe(true);
    const back = current.parseRfSectors(JSON.parse(JSON.stringify(old.value)));
    expect(back.ok).toBe(true);
    expect(back.value).toEqual(current.RfSectorsFile.parse(disk));
  });

  it('a file 0.21 saved opens here with every value counted as the person’s', () => {
    const { file } = current.splitRfOrigins(planned());
    const old = v1.parseRfSectors(JSON.parse(JSON.stringify(file)));
    const read = current.parseRfSectors(JSON.parse(JSON.stringify(old.value)));
    expect(read.ok).toBe(true);
    const merged = current.mergeRfOrigins(read.value, undefined);
    expect(merged.antennas.every((a) => a.origins === undefined)).toBe(true);
    expect(merged.antennas.flatMap((a) => a.carriers).every((c) => c.origin === undefined)).toBe(
      true,
    );
  });
});

/**
 * A coverage run (`rf/runs/<id>/run.json`, `aio.rf-run/1`) as the `rf.coverage` job writes it
 * (`python/src/aio_pipelines/rf/pipeline.py`, the `doc` it saves): the plan it used, read from
 * `rf/sectors.json` (so it never carries an origin), the antennas, the catalogue entries with
 * their `verified` flag, the grid and the outputs.
 */
function runAsWritten() {
  const { file } = current.splitRfOrigins(planned());
  return {
    schema: 'aio.rf-run/1',
    runId: 'rf-20261122-0900-ab12',
    createdAt: '2026-11-22T09:00:00+00:00',
    status: 'done',
    inputs: {
      sectors: JSON.parse(JSON.stringify(file)),
      antennas: [
        {
          id: 'ant-a',
          centre: [500020.8, 3200020, 30],
          groundZ: 0,
          heightM: 30,
          azimuthGridDeg: 0,
          convergenceDeg: 0,
          downtiltDeg: 2,
          status: 'accepted',
        },
        { id: 'ant-b', centre: [500020, 3200019.2, 30], groundZ: null, status: 'draft' },
      ],
    },
    catalogue: [{ id: 'generic-aau-64t', kind: 'aau', verified: false }],
    model: { model: 'tr38901', environment: 'uma' },
    grid: {
      crs: 'project',
      resolutionM: 20,
      radiusM: 1000,
      origin: [499020, 3201020],
      width: 100,
      height: 100,
      nodata: -9999,
    },
    timings: { totalMs: 812.4, pathLossMs: 600.1, budgetMs: 100.2, writeMs: 50.3 },
    warnings: ['ant-b is a draft and takes part because drafts were included.'],
    usedUnreviewed: true,
    patterns: [
      { antennaId: 'ant-a', source: 'generic' },
      { antennaId: 'ant-b', source: 'generic' },
    ],
    outputs: {
      rsrp: 'rsrp.tif',
      bestServer: 'best-server.tif',
      overlap: 'overlap.tif',
      pathLossDir: 'pathloss',
    },
  };
}

describe('a coverage run reads both ways (rf-coverage-backend follow-up)', () => {
  it('0.21 reads a run this build writes, keeping every value', () => {
    const disk = runAsWritten();
    expect(current.parseRfRun(disk).ok).toBe(true);
    const old = v1.parseRfRun(JSON.parse(JSON.stringify(disk)));
    expect(old.ok).toBe(true);
    expect(old.value).toEqual(current.RfRun.parse(disk));
  });

  it('a run 0.21 saved opens here unchanged', () => {
    const old = v1.parseRfRun(runAsWritten());
    expect(old.ok).toBe(true);
    const read = current.parseRfRun(JSON.parse(JSON.stringify(old.value)));
    expect(read.ok).toBe(true);
    expect(read.value).toEqual(old.value);
  });

  it('the run family keeps its name, version and folder', () => {
    expect(v1.RF_RUN_SCHEMA).toBe(current.RF_RUN_SCHEMA);
    expect(v1.RF_RUNS_DIR).toBe(current.RF_RUNS_DIR);
  });

  it('a run with an origin inside its plan is refused by 0.21 (the job never writes one)', () => {
    const run = runAsWritten();
    run.inputs.sectors = planned();
    expect(v1.parseRfRun(run).ok).toBe(false);
  });
});
