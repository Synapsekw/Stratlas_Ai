import { fromWgs84 } from '@aio/geo';
import type { Layer, SeverityTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  clipVideoTime,
  defaultTemplateFor,
  invertMat4,
  modelPoint,
  parseCoordinate,
  wizardProblems,
  type WizardForm,
} from './model';

describe('defaultTemplateFor', () => {
  const tpl = (id: string, assetType?: string): SeverityTemplate => ({
    id,
    label: id,
    source: 'test',
    model: { id, name: id, levels: [{ value: 1, label: 'L', color: '#000000', criteria: '' }] },
    ...(assetType ? { catalogue: { id: `${id}-c`, name: 'c', assetType, classes: [] } } : {}),
  });
  const list = [tpl('aik-stack', 'asset'), tpl('general'), tpl('road-astm-d6433', 'road')];
  it('gives a road survey the road catalogue and other types the first other one', () => {
    expect(defaultTemplateFor('road', list)).toBe('road-astm-d6433');
    expect(defaultTemplateFor('inspection', list)).toBe('aik-stack');
    expect(defaultTemplateFor('road', [tpl('general')])).toBe('general');
    expect(defaultTemplateFor('road', [])).toBeNull();
  });
});

describe('parseCoordinate', () => {
  it('reads latitude, longitude (and height) in degrees', () => {
    const r = parseCoordinate('29.0276, 48.1352, 31.7', 32639);
    const want = fromWgs84([48.1352, 29.0276, 31.7], 32639);
    expect(r?.[0]).toBeCloseTo(want[0], 6);
    expect(r?.[1]).toBeCloseTo(want[1], 6);
    expect(r?.[2]).toBe(31.7);
  });

  it('reads easting, northing in the project CRS', () => {
    expect(parseCoordinate('221029.4 3214462 12', 32639)).toEqual([221029.4, 3214462, 12]);
    expect(parseCoordinate('221029.4;3214462', 32639)).toEqual([221029.4, 3214462, 0]);
  });

  it('rejects text that is not a coordinate', () => {
    expect(parseCoordinate('', 32639)).toBeNull();
    expect(parseCoordinate('north gate', 32639)).toBeNull();
    expect(parseCoordinate('29.1', 32639)).toBeNull();
  });
});

describe('wizardProblems', () => {
  const ok: WizardForm = {
    name: 'EBSM flare',
    customer: '',
    site: '',
    type: 'inspection',
    epsg: 32639,
    origin: [221029, 3214462, 31.7],
    severityTemplate: 'aik-stack',
  };

  it('accepts a complete form', () => {
    expect(wizardProblems(ok)).toEqual({});
  });

  it('names each missing piece by step', () => {
    expect(wizardProblems({ ...ok, name: ' ', origin: null, epsg: 4326 })).toEqual({
      name: 'Give the project a name.',
      epsg: 'Pick a projected CRS in metres (a UTM zone), not longitude and latitude.',
      origin: 'Set the project origin.',
    });
    expect(wizardProblems({ ...ok, epsg: 1 }).epsg).toMatch(/not available offline/);
  });
});

describe('modelPoint', () => {
  it('turns a picked scene point back into model coordinates', () => {
    const t = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 10, 20, 30, 1]; // turn, scale 2, shift
    const p = modelPoint(t, [10 + 2 * 3, 20 + 2 * 4, 30 - 2 * 1]);
    expect(p[0]).toBeCloseTo(1, 9);
    expect(p[1]).toBeCloseTo(4, 9);
    expect(p[2]).toBeCloseTo(3, 9);
    const inv = invertMat4(t);
    expect(inv).not.toBeNull();
  });
});

describe('clipVideoTime', () => {
  const clip = {
    kind: 'video',
    id: 'c',
    name: 'c',
    visible: true,
    src: { path: 'v.mp4' },
    flight: { src: { path: 'f.json' }, startUtcMs: 1_000_000 },
    lens: { model: 'pinhole', hfovDeg: 70, aspect: 1.5 },
    offsetMs: 2000,
  } as Extract<Layer, { kind: 'video' }>;

  it('maps the project clock to the video time with a trial offset', () => {
    expect(clipVideoTime(clip, 1_005_000)).toBe(3);
    expect(clipVideoTime(clip, 1_005_000, 1500)).toBe(3.5);
    expect(clipVideoTime(clip, 1_000_000)).toBe(0);
  });
});
