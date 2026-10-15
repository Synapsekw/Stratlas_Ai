import type { ClassCatalogue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { catalogue, strictModel, tankModel } from '../testing';
import {
  addClass,
  allClasses,
  classSlug,
  classUsage,
  defaultSeverityModel,
  hotkeyProblem,
  removeClass,
  updateClass,
} from './catalogueOps';
import { CLASS_PALETTE } from './palette';

const models = [tankModel, strictModel];
const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('classSlug', () => {
  it('makes a lowercase id from the label', () => {
    expect(classSlug('Hairline crack')).toBe('hairline-crack');
    expect(classSlug('  Rost / Korrosion  ')).toBe('rost-korrosion');
    expect(classSlug('Écaillage')).toBe('ecaillage');
  });
  it('falls back to "class" for a label of symbols', () => {
    expect(classSlug('+++')).toBe('class');
  });
});

describe('addClass', () => {
  it('adds to the first catalogue with an id from the label and the next free colour', () => {
    const r = value(addClass([catalogue], models, { label: '  Spalling  ' }));
    expect(r.created).toBe(true);
    expect(r.cls).toEqual({
      id: 'spalling',
      label: 'Spalling',
      color: CLASS_PALETTE[1], // #e5484d (crack) is taken; #e8c547 and #5b9bd5 are not first
      severityModel: 'tank-1-5',
    });
    expect(r.catalogues[0]?.classes.at(-1)).toEqual(r.cls);
  });

  it('keeps ids unique across catalogues with -2, -3', () => {
    const other: ClassCatalogue = {
      id: 'other',
      name: 'Other',
      assetType: 'pipe',
      classes: [{ id: 'dent', label: 'Old dent', color: '#000000', severityModel: 'road-3' }],
    };
    const r = value(addClass([catalogue, other], models, { label: 'Dent' }));
    expect(r.cls.id).toBe('dent-2');
    const r2 = value(
      addClass(
        [{ ...catalogue, classes: [...catalogue.classes, { ...r.cls, label: 'Dent B' }] }, other],
        models,
        { label: 'Dent' },
      ),
    );
    expect(r2.cls.id).toBe('dent-3');
  });

  it('returns the existing class for a label it has (any case), creating nothing', () => {
    const r = value(addClass([catalogue], models, { label: 'coating BLISTER' }));
    expect(r.created).toBe(false);
    expect(r.cls.id).toBe('blister');
    expect(r.catalogues).toEqual([catalogue]);
  });

  it('prefers a road catalogue, else the first, else a new Classes catalogue', () => {
    const road: ClassCatalogue = { id: 'road', name: 'Road', assetType: 'road', classes: [] };
    expect(
      value(addClass([catalogue, road], models, { label: 'Rut' })).catalogues[1]?.classes,
    ).toHaveLength(1);
    const fresh = value(addClass([], models, { label: 'Rut' }));
    expect(fresh.catalogues).toEqual([
      {
        id: 'classes',
        name: 'Classes',
        assetType: 'asset',
        classes: [{ id: 'rut', label: 'Rut', color: CLASS_PALETTE[0], severityModel: 'tank-1-5' }],
      },
    ]);
  });

  it('uses the model most classes use, else the first model', () => {
    expect(defaultSeverityModel([catalogue], models)).toBe('tank-1-5');
    expect(defaultSeverityModel([], models)).toBe('tank-1-5');
    expect(defaultSeverityModel([], [])).toBeNull();
  });

  it('refuses an empty name and a project without a severity model', () => {
    expect(addClass([catalogue], models, { label: '   ' })).toEqual({
      ok: false,
      error: 'A class needs a name.',
    });
    expect(addClass([], [], { label: 'Rut' }).ok).toBe(false);
  });

  it('keeps a library colour and hotkey, and drops a hotkey that is taken or reserved', () => {
    const kept = value(
      addClass([catalogue], models, { label: 'Rut', color: '#123456', hotkey: 'R' }),
    );
    expect(kept.cls).toMatchObject({ color: '#123456', hotkey: 'r' });
    expect(value(addClass([catalogue], models, { label: 'Rut', hotkey: 'c' })).cls.hotkey).toBe(
      undefined,
    );
    expect(value(addClass([catalogue], models, { label: 'Rut', hotkey: 'a' })).cls.hotkey).toBe(
      undefined,
    );
  });
});

describe('hotkeys', () => {
  it('allows one free letter, case-insensitive', () => {
    expect(hotkeyProblem([catalogue], 'x')).toBeNull();
    expect(hotkeyProblem([catalogue], '7')).toMatch(/one letter/);
    expect(hotkeyProblem([catalogue], '1')).toMatch(/one letter/);
    expect(hotkeyProblem([catalogue], 'C')).toMatch(/Crack/);
    expect(hotkeyProblem([catalogue], 'c', 'crack')).toBeNull();
    expect(hotkeyProblem([catalogue], 'a')).toMatch(/reserved/);
    expect(hotkeyProblem([catalogue], 'U')).toMatch(/reserved/);
    expect(hotkeyProblem([catalogue], ' ')).toMatch(/A hotkey is one letter\./);
    expect(hotkeyProblem([catalogue], 'xy')).toMatch(/A hotkey is one letter\./);
  });
});

describe('updateClass', () => {
  it('renames, recolours, sets and clears a hotkey, changes the model', () => {
    let cats = [catalogue];
    cats = value(updateClass(cats, models, 'crack', { label: ' Wide crack ' })).catalogues;
    cats = value(updateClass(cats, models, 'crack', { color: '#010203' })).catalogues;
    cats = value(updateClass(cats, models, 'crack', { hotkey: 'W' })).catalogues;
    const cls = value(updateClass(cats, models, 'crack', { severityModel: 'road-3' })).cls;
    expect(cls).toEqual({
      id: 'crack',
      label: 'Wide crack',
      color: '#010203',
      hotkey: 'w',
      severityModel: 'road-3',
    });
    expect(value(updateClass(cats, models, 'crack', { hotkey: null })).cls.hotkey).toBeUndefined();
  });

  it('refuses a taken label, a bad colour, a taken hotkey, an unknown model or class', () => {
    expect(updateClass([catalogue], models, 'crack', { label: 'pothole' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { label: '' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { color: 'red' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { hotkey: 'b' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'crack', { severityModel: 'nope' }).ok).toBe(false);
    expect(updateClass([catalogue], models, 'nope', { label: 'X' }).ok).toBe(false);
  });
});

describe('removeClass and classUsage', () => {
  it('removes a class and keeps its catalogue', () => {
    const cats = value(removeClass([catalogue], 'pothole'));
    expect(allClasses(cats).map((c) => c.id)).toEqual(['crack', 'blister']);
    expect(cats[0]?.id).toBe('tank');
    expect(removeClass([catalogue], 'nope').ok).toBe(false);
  });

  it('counts issues and the detections not accepted yet', () => {
    expect(
      classUsage(
        [{ classId: 'crack' }, { classId: 'crack' }, { classId: 'blister' }],
        [
          { classId: 'crack', status: 'draft' },
          { classId: 'crack', status: 'rejected' },
          { classId: 'crack', status: 'accepted' },
        ],
        'crack',
      ),
    ).toEqual({ issues: 2, detections: 2 });
  });
});
