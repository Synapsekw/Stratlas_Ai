import {
  defaultSurveySettings,
  emptySurveyTemplates,
  type ProjectManifest,
  type SurveyMeasurement,
} from '@aio/schema';
import { measurementsGroup } from '@aio/ui';
import { captureIndex } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { buildMeasureItems, measureRowValue } from './measureRows';

vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));

const base = (id: string, label: string, over: Partial<SurveyMeasurement>): SurveyMeasurement => ({
  id,
  family: 'line',
  tool: 'distance',
  label,
  points: [
    [0, 0, 0],
    [25, 0, 0],
  ],
  items: [],
  results: [],
  scope: { kind: 'site' },
  createdAt: '2026-10-16T00:00:00Z',
  ...over,
});
const m = (id: string, label: string, folder?: string) => base(id, label, folder ? { folder } : {});

const defaults = defaultSurveySettings();
const settings = { ...defaults, precision: { ...defaults.precision, distance: 2 } };
const stateWith = (measurements: SurveyMeasurement[]) => ({
  file: { schema: 'aio.measurements/1' as const, measurements },
  settings,
  templates: { project: null, user: emptySurveyTemplates() },
});
const st = stateWith([]);

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [
    { id: 'sep', label: 'September', date: '2024-09-04' },
    { id: 'oct', label: 'October', date: '2024-10-02' },
  ],
  layers: [
    {
      kind: 'mesh',
      id: 'octMesh',
      name: 'Oct',
      visible: true,
      src: { path: 'models/o.glb' },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      capture: 'oct',
    },
  ],
  severityModels: [],
  classCatalogues: [],
};
const index = captureIndex(manifest);
const ws = { dates: index, hidden: {} };

describe('measureRowValue', () => {
  it('formats the primary value as the list did', () => {
    expect(measureRowValue(m('d', 'Distance'), st)).toBe('25.00 m');
    const bad = base('az', 'Az', {
      tool: 'azimuth',
      points: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    expect(measureRowValue(bad, st)).toBe('Invalid picks');
  });
});

describe('buildMeasureItems', () => {
  it('folders A to Z first, then loose rows, each sorted by label', () => {
    const items = buildMeasureItems(
      stateWith([
        m('b', 'Line 10'),
        m('a', 'Line 2'),
        m('c', 'Pad', 'Zone'),
        m('d', 'Kerb', 'Area'),
      ]),
      manifest,
      ws,
    );
    expect(items.map((i) => i.name)).toEqual(['Area', 'Zone', 'Line 2', 'Line 10']);
    expect(items[0]?.children?.map((c) => c.id)).toEqual(['measure:d']);
    expect(items[0]?.meta).toBe('1');
    expect(items[0]?.folder).toBe('Area');
    expect(items[0]?.id).toBe('measure-folder:Area');
  });

  it('dims a survey measurement whose date is hidden, eye untouched', () => {
    const s1 = base('s1', 'S', { scope: { kind: 'survey', capture: 'oct' } });
    const items = buildMeasureItems(stateWith([s1]), manifest, {
      dates: index,
      hidden: { octMesh: true },
    });
    expect(items[0]?.measure).toMatchObject({ id: 's1', dimmed: true });
    expect(items[0]?.measure?.dimmedWhy).toContain('2 Oct 2024');
    expect(items[0]?.meta).toBe('25.00 m · 2 Oct 2024');
    const shown = buildMeasureItems(stateWith([s1]), manifest, ws);
    expect(shown[0]?.measure).toMatchObject({ dimmed: false, color: '#ffd166' });
  });

  it('builds 500 rows sorted, one folder pass', () => {
    const items = buildMeasureItems(
      stateWith(
        Array.from({ length: 500 }, (_, i) => m(`m${i}`, `Line ${i}`, i % 2 ? 'Odd' : undefined)),
      ),
      manifest,
      ws,
    );
    expect(items[0]?.children).toHaveLength(250);
    expect(items.length).toBe(1 + 250);
    expect(items[1]?.name).toBe('Line 0');
    expect(items[2]?.name).toBe('Line 2');
  });
});

describe('buildMeasureItems under a filter', () => {
  const file = () =>
    stateWith([
      base('a', 'Pad 1', { fields: { crew: 'Crew A' }, folder: 'Pads' }),
      base('b', 'Pad 2', { fields: { crew: 'Crew B' }, folder: 'Pads' }),
      base('c', 'Fence', { folder: 'Edges' }),
      base('d', 'Spot', { fields: { crew: 'Crew A' } }),
      m('e', 'Kerb'),
    ]);

  it('keeps only the matching rows; a folder with none goes, one with some lists only those', () => {
    const items = buildMeasureItems(file(), manifest, ws, 'crew a');
    expect(items.map((i) => i.name)).toEqual(['Pads', 'Spot']);
    expect(items[0]?.children?.map((c) => c.name)).toEqual(['Pad 1']);
    // the folder's count is its matches; its eye still acts on all of it
    expect(items[0]?.meta).toBe('1');
    expect(items[0]?.folderIds).toEqual(['a', 'b']);
  });

  it('matches folder names: the whole folder shows', () => {
    const items = buildMeasureItems(file(), manifest, ws, 'EDGES');
    expect(items.map((i) => i.name)).toEqual(['Edges']);
    expect(items[0]?.children?.map((c) => c.name)).toEqual(['Fence']);
  });

  it('a blank query is no filter: folders carry no ids of their own', () => {
    const items = buildMeasureItems(file(), manifest, ws, '   ');
    expect(items.map((i) => i.name)).toEqual(['Edges', 'Pads', 'Kerb', 'Spot']);
    expect(items[0]?.folderIds).toBeUndefined();
  });

  it('nothing matching gives no rows, and the group stays, counting every measurement', () => {
    const items = buildMeasureItems(file(), manifest, ws, 'nothing like this');
    expect(items).toEqual([]);
    const g = measurementsGroup(items, ['a', 'b', 'c', 'd', 'e']);
    expect(g).toMatchObject({ count: 5, matched: 0, measureIds: ['a', 'b', 'c', 'd', 'e'] });
  });

  it('every match is a row, past the 500', () => {
    const items = buildMeasureItems(
      stateWith(Array.from({ length: 500 }, (_, i) => m(`m${String(i)}`, `Line ${String(i)}`))),
      manifest,
      ws,
      'line 1',
    );
    // Line 1, 10 to 19, 100 to 199
    expect(items).toHaveLength(1 + 10 + 100);
  });
});
