import { fromWgs84 } from '@aio/geo';
import { PURPOSE_TYPE, type Layer, type SeverityTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  clipVideoTime,
  DEFAULT_COVER,
  defaultTemplateFor,
  invertMat4,
  kindLabel,
  modelPoint,
  parseCoordinate,
  PROJECT_TYPES,
  projectKind,
  starterFor,
  wizardProblems,
  type ProjectKind,
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

  it('follows the type a card writes: only the Road card takes the road catalogue', () => {
    for (const card of PROJECT_TYPES)
      expect(defaultTemplateFor(PURPOSE_TYPE[card.id], list), card.label).toBe(
        card.id === 'road' ? 'road-astm-d6433' : 'aik-stack',
      );
  });
});

describe('the project type cards', () => {
  it('are the seven the wizard offers, in order, each with one plain line', () => {
    expect(PROJECT_TYPES.map((c) => [c.id, c.label])).toEqual([
      ['survey', 'Survey'],
      ['construction', 'Construction'],
      ['vertical-asset', 'Vertical asset inspection'],
      ['confined-space', 'Confined space inspection'],
      ['data-fusion', 'Data fusion'],
      ['road', 'Road'],
      ['telecom', 'Telecom towers'],
    ]);
    for (const card of PROJECT_TYPES) {
      expect(card.hint.length, card.label).toBeGreaterThan(20);
      expect(card.hint.length, card.label).toBeLessThan(80);
      expect(card.hint, card.label).not.toMatch(/[\u2013\u2014\n]/);
    }
  });

  it('can each be picked by the start of their name (the end to end specs do)', () => {
    const names = PROJECT_TYPES.map((c) => `${c.label} ${c.hint}`);
    const starts = [
      /^Survey/,
      /^Construction/,
      /^Vertical asset/,
      /^Confined space/,
      /^Data/,
      /^Telecom/,
    ];
    for (const start of [...starts, /^Road/])
      expect(
        names.filter((n) => start.test(n)),
        String(start),
      ).toHaveLength(1);
  });
});

describe('projectKind', () => {
  it('is the purpose the wizard wrote', () => {
    for (const card of PROJECT_TYPES)
      expect(projectKind({ type: PURPOSE_TYPE[card.id], purpose: card.id })).toBe(card.id);
    expect(kindLabel('confined-space')).toBe('Confined space inspection');
    expect(projectKind({ type: 'inspection', purpose: 'telecom' })).toBe('telecom');
    expect(kindLabel('telecom')).toBe('Telecom towers');
  });

  it('comes from the older type for a project without a purpose', () => {
    expect(projectKind({ type: 'volumetric' })).toBe('survey');
    expect(projectKind({ type: 'road' })).toBe('road');
    expect(projectKind({ type: 'fusion' })).toBe('data-fusion');
    // either kind of inspection: the older type cannot tell
    expect(projectKind({ type: 'inspection' })).toBe('inspection');
    expect(projectKind({ type: 'twin' })).toBe('twin');
    expect(kindLabel('inspection')).toBe('Inspection');
    expect(kindLabel('twin')).toBe('Digital twin');
  });

  it('is nothing for a project with neither (an imported kit project)', () => {
    expect(projectKind({})).toBeNull();
  });

  it('falls back to the type for a purpose this build does not know', () => {
    expect(projectKind({ type: 'inspection', purpose: 'tunnel' })).toBe('inspection');
    expect(projectKind({ purpose: 'tunnel' })).toBeNull();
  });
});

describe('starterFor', () => {
  const kinds: ProjectKind[] = [...PROJECT_TYPES.map((c) => c.id), 'inspection', 'twin'];
  /** What Import files takes (`@aio/project` builder/raw.ts), by the names the lines use. */
  const importable = new Set([
    ...['JPG', 'MP4', 'MOV', 'SRT', 'GLB', 'OBJ', 'GeoTIFF', 'LAS', 'LAZ', 'E57', 'PLY', 'DXF'],
    ...['LandXML', '12da'],
  ]);
  /** Abbreviations that are not file kinds. */
  const words = new Set(['GPS', 'DSM', 'DJI', '3D']);

  it('gives every kind three or four short lines', () => {
    for (const kind of kinds) {
      const lines = starterFor(kind);
      expect(lines.length, kind).toBeGreaterThanOrEqual(3);
      expect(lines.length, kind).toBeLessThanOrEqual(4);
      for (const line of lines) {
        expect(line.length, line).toBeLessThanOrEqual(84);
        expect(line, line).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it('names only file kinds the import takes today', () => {
    for (const kind of kinds) {
      const named = starterFor(kind)
        .join(' ')
        .match(/\b(?:[A-Z][A-Z0-9]+|[0-9]+[A-Za-z]+|[A-Z][a-z]+[A-Z]{2,})\b/g);
      expect(named?.length, kind).toBeGreaterThan(0);
      for (const name of named ?? [])
        expect(importable.has(name) || words.has(name), `${kind}: ${name}`).toBe(true);
    }
  });

  it('gives the older kinds the list of their nearest card', () => {
    expect(starterFor('inspection')).toEqual(starterFor('vertical-asset'));
    expect(starterFor('twin')).toEqual(starterFor('data-fusion'));
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
    purpose: 'vertical-asset',
    epsg: 32639,
    origin: [221029, 3214462, 31.7],
    severityTemplate: 'aik-stack',
    cover: DEFAULT_COVER,
  };

  it('starts on a built-in cover, so a new project never shows the blank placeholder', () => {
    expect(DEFAULT_COVER).toEqual({ kind: 'builtin', id: 'contours' });
  });

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
