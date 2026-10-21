import {
  defaultSurveySettings,
  type ComparisonResult,
  type MeasurementTool,
  type SurveyMeasurement,
  type SurveySettings,
  type SurveyTemplate,
} from '@aio/schema';
import { TOOL_LABELS } from '@aio/survey';
import { ICONS } from '@aio/ui';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEASURE_COLOUR, MEASURE_COLOURS } from '../measureColours';
import { cardModel, colourName, primaryText, splitValue, TOOL_ICON } from './cardModel';

vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
}));

const measurement = (over: Partial<SurveyMeasurement>): SurveyMeasurement => ({
  id: 'm1',
  family: 'line',
  tool: 'distance',
  label: 'Haul ramp',
  points: [
    [0, 0, 0],
    [100, 0, 10],
  ],
  items: [],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-20T00:00:00Z',
  ...over,
});

const result = (over: Partial<ComparisonResult> = {}): ComparisonResult => ({
  item: 'i1',
  status: 'ok',
  cutM3: 2,
  fillM3: 12,
  netM3: 10,
  totalM3: 14,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 0,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Triangulated toe',
  toLabel: '02 Oct 2024',
  toCapture: 'oct',
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.1,
  engine: 'ts',
  fingerprint: 'f',
  computedAt: '2026-10-20T00:00:00.000Z',
  ...over,
});

const settings = defaultSurveySettings();
const ctx = (s: SurveySettings = settings) => ({
  settings: s,
  templates: [],
  captures: [
    { id: 'sep', label: 'September' },
    { id: 'oct', label: 'October' },
  ],
});

describe('cardModel', () => {
  it('every tool has an icon', () => {
    for (const tool of Object.keys(TOOL_LABELS) as MeasurementTool[]) {
      expect(TOOL_ICON[tool], tool).toBeDefined();
      expect(ICONS, tool).toHaveProperty(TOOL_ICON[tool]);
    }
  });

  it('distance model has primary slope and secondary horizontal, height, grade', () => {
    const c = cardModel(measurement({}), ctx());
    expect(c.icon).toBe('ruler');
    expect(c.name).toBe('Haul ramp');
    expect(c.tool).toBe('Distance');
    expect(c.primary?.label).toBe('Slope length');
    expect(c.primary?.text).toMatch(/^100\.(499|50?) m$/); // √(100² + 10²)
    const parts = c.secondary.split(' · ');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^Horizontal length 100(\.0+)? m$/);
    expect(parts[1]).toMatch(/^Height change 10(\.0+)? m$/);
    expect(parts[2]).toMatch(/^Grade 10(\.0+)? ?%$/);
    expect(c.more.map((r) => r.label)).toContain('Slope length');
  });

  it('volume primary is net in the site volume unit', () => {
    const vol = measurement({
      family: 'polygon',
      tool: 'volume',
      points: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 10, 0],
        [0, 10, 0],
      ],
      results: [result()],
    });
    const metric = cardModel(vol, ctx());
    expect(metric.primary?.label).toBe('Net');
    expect(metric.primary?.text).toMatch(/^10(\.0+)? m³$/);
    const yards = cardModel(vol, ctx({ ...settings, units: { ...settings.units, volume: 'yd3' } }));
    expect(yards.primary?.label).toBe('Net');
    // 10 m³ is 13.08 yd³
    expect(yards.primary?.text).toMatch(/^13\.\d+ yd³$/);
    expect(yards.secondary).toMatch(/^Cut .+ yd³ · Fill .+ yd³ · Horizontal area/);
  });

  it('telecom angles follow the angle setting', () => {
    const tilt = measurement({
      tool: 'antenna-tilt',
      points: [
        [0, 0, 0],
        [1, 0, 3],
      ],
    });
    const deg = cardModel(
      tilt,
      ctx({ ...settings, angles: { angle: 'deg', bearing: 'dms', precision: 2 } }),
    );
    expect(deg.primary?.text).toMatch(/^\d+\.\d{2}°$/);
    const dms = cardModel(
      tilt,
      ctx({ ...settings, angles: { angle: 'dms', bearing: 'dms', precision: 0 } }),
    );
    expect(dms.primary?.text).toMatch(/^\d+°\d{2}'\d{2}"$/);
  });

  it('scope chip shows the survey label for survey-scoped measurements', () => {
    const c = cardModel(measurement({ scope: { kind: 'survey', capture: 'oct' } }), ctx());
    expect(c.scope).toEqual({ label: 'October', capture: 'oct' });
    expect(cardModel(measurement({}), ctx()).scope).toBeNull();
    // a date the project no longer has: no chip (it needs a date), never the bare capture id
    const gone = cardModel(measurement({ scope: { kind: 'survey', capture: 'gone' } }), ctx());
    expect(gone.scope).toBeNull();
  });

  it('takes the colour from the style, else the measurement default', () => {
    expect(cardModel(measurement({ style: { color: '#ef476f' } }), ctx()).colour).toBe('#ef476f');
    expect(cardModel(measurement({}), ctx()).colour).toBe(DEFAULT_MEASURE_COLOUR);
  });
});

describe('cardModel secondary and colour', () => {
  it('the secondary line never repeats the primary row', () => {
    // the template leaves out the slope length, so the horizontal length is the primary
    const tpl: SurveyTemplate = {
      id: 't1',
      name: 'Plan length',
      family: 'line',
      tool: 'distance',
      items: ['horizontal', 'grade'],
      fields: [],
      comparisons: [],
    };
    const c = cardModel(measurement({ template: 't1' }), { ...ctx(), templates: [tpl] });
    expect(c.primary?.label).toBe('Horizontal length');
    expect(c.secondary).not.toContain('Horizontal length');
    expect(c.secondary.split(' · ')).toHaveLength(2);
  });

  it('names the swatch colour: a preset by name, any other by its hex', () => {
    expect(cardModel(measurement({}), ctx()).colourName).toBe('Yellow');
    expect(colourName('#EF476F')).toBe('Red');
    expect(colourName('#123456')).toBe('#123456');
  });

  it('names every preset of the one palette', () => {
    for (const c of MEASURE_COLOURS) expect(colourName(c.hex)).not.toBe(c.hex);
  });

  it('the card primary is the shared primary text', () => {
    const m = measurement({});
    expect(cardModel(m, ctx()).primary?.text).toBe(primaryText(m, ctx()));
  });
});

describe('splitValue', () => {
  it('splits the number from its unit, and keeps a spaceless angle whole', () => {
    expect(splitValue('142.6 m')).toEqual({ value: '142.6', unit: 'm' });
    expect(splitValue('1,234.5 m³')).toEqual({ value: '1,234.5', unit: 'm³' });
    expect(splitValue(`15°12'00"`)).toEqual({ value: `15°12'00"`, unit: '' });
  });

  it('keeps digit groups split by a space in the number ("2 714.7 m³")', () => {
    for (const gap of [' ', ' ', ' '])
      expect(splitValue(`2${gap}714.7 m³`)).toEqual({ value: `2${gap}714.7`, unit: 'm³' });
    expect(splitValue('-1 234 567.8 m³')).toEqual({ value: '-1 234 567.8', unit: 'm³' });
    expect(splitValue('12 m')).toEqual({ value: '12', unit: 'm' });
    expect(splitValue('1 076.39 ft²')).toEqual({ value: '1 076.39', unit: 'ft²' });
  });
});
