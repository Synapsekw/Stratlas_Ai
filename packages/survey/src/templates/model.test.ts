import { emptySurveyTemplates, SurveyMeasurement, SurveyTemplate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  addComparison,
  addField,
  addItem,
  availableItems,
  bookmarks,
  changeTemplate,
  copyTemplate,
  measurementFrom,
  moveItem,
  newTemplate,
  removeField,
  removeItem,
  setDescription,
  setStyle,
  templateLibrary,
  templateProblems,
  toggleBookmark,
  uniqueId,
  updateField,
  upsertTemplate,
} from './model';

const NOW = '2026-10-09T06:00:00.000Z';
const ring = (): [number, number, number][] => [
  [512_340, 2_710_250, 10],
  [512_350, 2_710_250, 10],
  [512_350, 2_710_260, 10],
];

/** "Pad check": a volume template with a Crew dropdown and a cut and fill item. */
function padCheck() {
  let t = newTemplate('Pad check', 'volume', []);
  t = addField(t, 'Crew', 'dropdown', ['North', ' South ', 'North', '']);
  t = addField(t, 'Lot', 'number');
  t = addComparison(t, {
    label: 'Cut and fill to design',
    from: { kind: 'current' },
    to: { kind: 'design', design: 'pad', layer: 'finished' },
    useDeadband: false,
  });
  t = toggleBookmark(setDescription(t, '  Pad levels against the design  '));
  return setStyle(t, { color: '#2266aa', fillOpacity: 0.3 });
}

describe('templates', () => {
  it('makes file-name-safe unique ids', () => {
    expect(uniqueId('Pad check', [])).toBe('pad-check');
    expect(uniqueId('Pad check', ['pad-check', 'pad-check-2'])).toBe('pad-check-3');
    expect(uniqueId('  ***  ', [], 'field')).toBe('field');
  });

  it('builds a custom template with a dropdown field, a comparison and a bookmark', () => {
    const t = padCheck();
    expect(t).toMatchObject({
      id: 'pad-check',
      family: 'polygon',
      tool: 'volume',
      items: ['cut', 'fill', 'net', 'total', 'area'],
      bookmarked: true,
      description: 'Pad levels against the design',
    });
    expect(t.fields).toEqual([
      { id: 'crew', name: 'Crew', type: 'dropdown', options: ['North', 'South'] },
      { id: 'lot', name: 'Lot', type: 'number' },
    ]);
    expect(SurveyTemplate.parse(t)).toEqual(t);
    expect(templateProblems(t)).toEqual([]);
  });

  it('orders, adds and removes result rows', () => {
    const t = padCheck();
    expect(moveItem(t.items, 2, 0)).toEqual(['net', 'cut', 'fill', 'total', 'area']);
    expect(moveItem(t.items, 0, 99)).toEqual(['fill', 'net', 'total', 'area', 'cut']);
    expect(removeItem(t, 'total').items).not.toContain('total');
    expect(addItem(t, 'cut').items).toHaveLength(5);
    expect(addItem(t, 'perimeter').items.at(-1)).toBe('perimeter');
    expect(availableItems('distance')).toEqual(
      expect.arrayContaining(['horizontal', 'terrain-length', 'grade']),
    );
  });

  it('edits and removes fields, and catches a dropdown without choices and duplicate names', () => {
    let t = padCheck();
    t = updateField(t, 'lot', { type: 'dropdown' });
    expect(t.fields[1]).toEqual({ id: 'lot', name: 'Lot', type: 'dropdown', options: [] });
    expect(templateProblems(t)).toEqual(['The dropdown "Lot" needs at least one choice.']);
    t = updateField(t, 'lot', { type: 'text' });
    expect(t.fields[1]).toEqual({ id: 'lot', name: 'Lot', type: 'text' });
    t = updateField(t, 'lot', { name: 'crew' });
    expect(templateProblems(t)).toEqual(['Two fields are called "crew".']);
    expect(removeField(t, 'lot').fields).toHaveLength(1);
    expect(templateProblems({ ...t, name: ' ' })).toContain('Give the template a name.');
  });

  it('is used twice: each measurement gets its own comparison item ids and the style', () => {
    const t = padCheck();
    const a = measurementFrom(t, {
      id: 'm1',
      label: 'Pad A',
      points: ring(),
      scope: { kind: 'site' },
      createdAt: NOW,
      createdBy: 'Rana Example',
    });
    const b = measurementFrom(t, {
      id: 'm2',
      label: 'Pad B',
      points: ring(),
      scope: { kind: 'survey', capture: 'c-2026-10-01' },
      createdAt: NOW,
    });
    for (const m of [a, b]) {
      expect(SurveyMeasurement.parse(m)).toEqual(m);
      expect(m).toMatchObject({ template: 'pad-check', tool: 'volume', family: 'polygon' });
      expect(m.style?.color).toBe('#2266aa');
      expect(m.items).toHaveLength(1);
      expect(m.items[0]?.id).toBe('cut-and-fill-to-design');
      expect(m.results).toEqual([]);
    }
    expect(a.createdBy).toBe('Rana Example');
  });

  it('changes a measurement template after it was made, within the family', () => {
    const plain = measurementFrom('area', {
      id: 'm1',
      label: 'Lot 4',
      points: ring(),
      scope: { kind: 'site' },
      createdAt: NOW,
    });
    plain.fields = { crew: 'North', note: 'kept' };
    const changed = changeTemplate(plain, padCheck(), NOW);
    expect(changed).toMatchObject({ template: 'pad-check', tool: 'volume', updatedAt: NOW });
    expect(changed?.items).toHaveLength(1);
    expect(changed?.fields).toEqual({ crew: 'North', note: 'kept' });
    // again: the preset is already there
    expect(changed && changeTemplate(changed, padCheck(), NOW)?.items).toHaveLength(1);
    const line = newTemplate('Kerb', 'distance', []);
    expect(changeTemplate(plain, line, NOW)).toBeNull();
    expect(changed && changeTemplate(changed, null, NOW)?.template).toBeUndefined();
  });

  it('merges the project, the library and the sets for the toolbar, bookmarks first class', () => {
    const project = upsertTemplate(emptySurveyTemplates(), padCheck());
    const mine = newTemplate('Kerb', 'distance', []);
    let user = upsertTemplate(emptySurveyTemplates(), mine);
    user = copyTemplate(padCheck(), user);
    expect(user.templates.map((t) => t.id)).toEqual(['kerb', 'pad-check']);
    const lib = templateLibrary(project, user, [{ ...mine, id: 'set-kerb', set: 'construction' }]);
    expect(lib.map((l) => [l.template.id, l.source])).toEqual([
      ['pad-check', 'project'],
      ['kerb', 'user'],
      ['set-kerb', 'set'],
    ]);
    expect(bookmarks(lib).map((l) => l.template.id)).toEqual(['pad-check']);
    expect(copyTemplate(padCheck(), project).templates.map((t) => t.id)).toEqual([
      'pad-check',
      'pad-check-2',
    ]);
  });
});
