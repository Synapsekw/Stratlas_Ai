import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_LABEL_KIND,
  AntennaUnit,
  AntennaValue,
  AntennasFile,
  ANTENNAS_FILE,
  ANTENNAS_SCHEMA,
  TELECOM_ANTENNAS_MIN_PACK,
  TOWER_HINT_NEEDED,
} from './antennas';
import { ipc } from './ipc';
import { pipelineParams } from './jobs';
import { SCHEMA_REGISTRY } from './versions';

const contract = JSON.parse(
  readFileSync(new URL('./__fixtures__/antennas-contract.json', import.meta.url), 'utf8'),
) as {
  towerHintMessage: string;
  matchRadiusM: number;
  example: { units: Record<string, unknown>[] };
};

const [panel, dish] = contract.example.units as [Record<string, unknown>, Record<string, unknown>];

describe('antennas contract', () => {
  it('parses the contract example and round-trips it', () => {
    const f = AntennasFile.parse(contract.example);
    expect(f.units.map((u) => u.kind)).toEqual(['panel', 'dish', 'other']);
    expect(f.units[0]?.status).toBe('accepted');
    expect(f.units[0]?.user.model).toBeDefined();
    expect(AntennasFile.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it('pins the tower hint message to the shared fixture', () => {
    expect(TOWER_HINT_NEEDED).toBe(contract.towerHintMessage);
    expect(contract.matchRadiusM).toBe(0.3);
  });

  it('pins the names other tasks read', () => {
    expect(ANTENNAS_SCHEMA).toBe('aio.antennas/1');
    expect(ANTENNAS_FILE).toBe('telecom/antennas.json');
    expect(TELECOM_ANTENNAS_MIN_PACK).toBe('0.14.0');
  });

  it('refuses a geometry panel without azimuth or downtilt', () => {
    expect(AntennaUnit.safeParse(panel).success).toBe(true);
    expect(AntennaUnit.safeParse({ ...panel, azimuthGridDeg: undefined }).success).toBe(false);
    expect(AntennaUnit.safeParse({ ...panel, downtiltDeg: undefined }).success).toBe(false);
  });

  it('refuses a geometry dish without elevation or diameter', () => {
    expect(AntennaUnit.safeParse(dish).success).toBe(true);
    expect(AntennaUnit.safeParse({ ...dish, diameterM: undefined }).success).toBe(false);
    expect(AntennaUnit.safeParse({ ...dish, elevationDeg: undefined }).success).toBe(false);
  });

  it('refuses angles on a geometry "other" unit, allows them once AI relabelled', () => {
    expect(AntennaUnit.safeParse({ ...panel, kind: 'other' }).success).toBe(false);
    expect(AntennaUnit.safeParse({ ...panel, kind: 'other', kindBasis: 'ai' }).success).toBe(true);
    expect(AntennaUnit.safeParse({ ...panel, kind: 'other', kindBasis: 'user' }).success).toBe(
      true,
    );
  });

  it('refuses residualM on an inferred value', () => {
    expect(
      AntennaValue.safeParse({
        value: 0.15,
        basis: 'inferred',
        quality: { basis: 'inferred', residualM: 0.003 },
      }).success,
    ).toBe(false);
  });

  it('refuses a quality basis that differs from the value basis', () => {
    expect(
      AntennaValue.safeParse({
        value: 0.15,
        basis: 'measured',
        quality: { basis: 'observed' },
      }).success,
    ).toBe(false);
  });

  it('refuses more than 3 photos and unknown fields', () => {
    const photo = { layer: 'photos-1', id: 'p1', score: 0.5 };
    expect(AntennaUnit.safeParse({ ...panel, photos: [photo, photo, photo] }).success).toBe(true);
    expect(AntennaUnit.safeParse({ ...panel, photos: [photo, photo, photo, photo] }).success).toBe(
      false,
    );
    expect(AntennaUnit.safeParse({ ...panel, extra: 1 }).success).toBe(false);
  });

  it('maps AI labels one to one onto kinds', () => {
    expect(AI_LABEL_KIND).toEqual({
      panel: 'panel',
      'short-antenna': 'short',
      'radio-unit': 'other',
      dish: 'dish',
      other: 'other',
    });
  });

  it('validates params strictly', () => {
    expect(pipelineParams('telecom.antennas').safeParse({ run: 'run-a1' }).success).toBe(true);
    expect(pipelineParams('telecom.antennas').safeParse({ run: 'run-a1', radius: 3 }).success).toBe(
      false,
    );
    expect(pipelineParams('telecom.antennas').safeParse({ run: 'x' }).success).toBe(false);
  });

  it('bounds the floor fraction and takes a tower hint and a cloud', () => {
    const p = pipelineParams('telecom.antennas');
    const ok = {
      run: 'run-a1',
      cloud: { layer: 'cloud-1' },
      towerHint: [1.5, -2],
      floorFraction: 0.6,
    };
    expect(p.safeParse(ok).success).toBe(true);
    expect(p.safeParse({ ...ok, floorFraction: 0.2 }).success).toBe(false);
    expect(p.safeParse({ ...ok, floorFraction: 0.99 }).success).toBe(false);
  });

  it('takes an optional ground height in the run and nothing but a number', () => {
    const file = AntennasFile.parse(contract.example);
    expect(file.run.groundZ).toBeUndefined();
    const withGround = AntennasFile.parse({ ...file, run: { ...file.run, groundZ: 12.25 } });
    expect(withGround.run.groundZ).toBe(12.25);
    expect(AntennasFile.parse(JSON.parse(JSON.stringify(withGround))).run.groundZ).toBe(12.25);
    const bad = AntennasFile.safeParse({ ...file, run: { ...file.run, groundZ: '12' } });
    expect(bad.success).toBe(false);
  });
});

describe('antennas channels and versions', () => {
  it('declares the four IPC channels with strict requests', () => {
    expect(ipc['telecom:readAntennas'].request.safeParse({ projectId: 'p1', x: 1 }).success).toBe(
      false,
    );
    expect(ipc['telecom:readAntennas'].request.safeParse({ projectId: 'p1' }).success).toBe(true);
    expect(
      ipc['telecom:writeAntennas'].request.safeParse({
        projectId: 'p1',
        file: contract.example,
      }).success,
    ).toBe(true);
    const preview = ipc['ai:antennaLabelPreview'].request;
    expect(preview.safeParse({ projectId: 'p1', unitIds: [] }).success).toBe(false);
    expect(
      preview.safeParse({
        projectId: 'p1',
        unitIds: Array.from({ length: 201 }, (_, i) => `ant-${String(i)}`),
      }).success,
    ).toBe(false);
    expect(preview.safeParse({ projectId: 'p1', unitIds: ['ant-a1'] }).success).toBe(true);
    const label = ipc['ai:labelAntennas'].request;
    expect(label.safeParse({ runId: 'r', projectId: 'p1', unitIds: ['ant-a1'] }).success).toBe(
      true,
    );
    expect(
      label.safeParse({ runId: 'r', projectId: 'p1', unitIds: ['ant-a1'], other: 1 }).success,
    ).toBe(false);
  });

  it('parses a read response with and without a file', () => {
    const res = ipc['telecom:readAntennas'].response;
    expect(res.safeParse({ ok: true, file: null, readOnly: false }).success).toBe(true);
    expect(res.safeParse({ ok: true, file: contract.example, readOnly: true }).success).toBe(true);
  });

  it('registers the file family', () => {
    expect(SCHEMA_REGISTRY).toContainEqual({
      family: 'aio.antennas',
      version: 1,
      home: 'project',
      where: 'telecom/antennas.json',
      since: '0.20',
    });
  });
});
