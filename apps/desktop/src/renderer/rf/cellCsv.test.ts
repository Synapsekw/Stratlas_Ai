import { describe, expect, it } from 'vitest';
import { columnsOf, parseCellCsv, rowText, unusedColumns } from './cellCsv';

const UNITS = [
  { id: 'ant-a1', name: 'A1' },
  { id: 'ant-a2', name: 'A2' },
];

describe('parseCellCsv', () => {
  it('an unknown column is reported by name', () => {
    const r = parseCellCsv(
      ['antenna,band,Vendor note,  ,azimuth,band', 'A1,B3,check,,120,B1'].join('\n'),
      UNITS,
      [],
    );
    if (!r.ok) throw new Error('not parsed');
    // a name no field knows, the azimuth the import does not read, and a second band column
    expect(r.ignoredColumns).toEqual(['Vendor note', 'azimuth', 'band']);
    expect(r.rows[0]?.band).toBe('B3');
  });

  it('names no column when every column is read', () => {
    const r = parseCellCsv('antenna,band\nA1,B3', UNITS, []);
    expect(r.ok && r.ignoredColumns).toEqual([]);
  });

  it('a row that matches nothing keeps its own text', () => {
    const r = parseCellCsv('antenna,sector,band\nA1,S1,B3\nX-9,S2,B1,\n,S3,B20', UNITS, []);
    if (!r.ok) throw new Error('not parsed');
    expect(r.rows[1]).toMatchObject({ line: 3, unitId: null, text: 'X-9, S2, B1' });
    // an empty antenna cell still shows the rest of the row
    expect(r.rows[2]).toMatchObject({ line: 4, ref: '', text: ', S3, B20' });
  });
});

describe('unusedColumns', () => {
  it('leaves out the columns of the fields given', () => {
    const header = ['Antenna', 'Az', 'Height', 'Other'];
    const cols = columnsOf(header);
    expect(unusedColumns(header, cols, ['antenna', 'azimuth', 'height'])).toEqual(['Other']);
    expect(unusedColumns(header, cols, ['antenna'])).toEqual(['Az', 'Height', 'Other']);
  });

  it('rowText trims cells and drops trailing empty ones', () => {
    expect(rowText([' a ', 'b', '', ''])).toBe('a, b');
  });
});
