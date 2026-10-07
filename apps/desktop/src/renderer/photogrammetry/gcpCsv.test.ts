import { describe, expect, it } from 'vitest';
import {
  epsgFromCrsLine,
  guessMapping,
  mappingProblem,
  readTable,
  toGcpFile,
  type GcpImportOptions,
} from './gcpCsv';

const OPTS: GcpImportOptions = {
  epsg: 32639,
  accuracy: { horizontalM: 0.02, verticalM: 0.03 },
  fileName: 'C:\\surveys\\site gcp.csv',
  now: new Date('2026-10-07T10:00:00Z'),
};

const imp = (text: string, o: Partial<GcpImportOptions> = {}) => {
  const t = readTable(text);
  return toGcpFile(t, guessMapping(t), { ...OPTS, ...o });
};

describe('GCP files', () => {
  it('reads a CSV with a header, roles and accuracies', () => {
    const r = imp(
      'Name,Easting,Northing,Height,Type,Acc H,Acc V\nGCP1,245900.12,3179600.5,12.30,control,0.01,0.02\nCP1,245950,3179650,12.8,check,,\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.file).toEqual({
      schema: 'aio.gcp/1',
      crs: { epsg: 32639 },
      importedFrom: 'site gcp.csv',
      points: [
        {
          id: 'GCP1',
          role: 'control',
          xyz: [245900.12, 3179600.5, 12.3],
          accuracy: { horizontalM: 0.01, verticalM: 0.02 },
          marks: [],
        },
        {
          id: 'CP1',
          role: 'check',
          xyz: [245950, 3179650, 12.8],
          accuracy: { horizontalM: 0.02, verticalM: 0.03 },
          marks: [],
        },
      ],
    });
  });

  it('detects semicolons, tabs and spaces', () => {
    expect(readTable('id;x;y;z\nA;1;2;3').separator).toBe(';');
    expect(readTable('id\tx\ty\tz\nA\t1\t2\t3').separator).toBe('\t');
    const space = readTable('A 245900 3179600 12\nB 245901 3179601 13');
    expect(space.separator).toBe(' ');
    expect(guessMapping(space)).toEqual(['id', 'x', 'y', 'z']);
  });

  it('reads a Pix4D list without a header in latitude, longitude order as WGS 84', () => {
    const r = imp('GCP1,29.0712345,48.1212345,12.5\nGCP2,29.0722345,48.1222345,13.1\n');
    expect(r.file?.crs).toEqual({ epsg: 4326 });
    // stored longitude first (x), latitude second (y)
    expect(r.file?.points[0]?.xyz).toEqual([48.1212345, 29.0712345, 12.5]);
    expect(r.warnings.join(' ')).toMatch(/read as WGS 84/);
  });

  it('swaps latitude and longitude back when the latitudes are over 90', () => {
    const t = readTable('id,lat,lon,h\nA,148.1212,29.0712,1\nB,148.1213,29.0713,1');
    const r = toGcpFile(t, guessMapping(t), { ...OPTS, epsg: 4326 });
    expect(r.file?.points[0]?.xyz).toEqual([148.1212, 29.0712, 1]);
    expect(r.warnings.join(' ')).toMatch(/looked swapped/);
  });

  it('reads an ODM gcp_list.txt with its image observations as imported marks', () => {
    const t = readTable(
      'WGS84 UTM 39N\n245900 3179600 12.3 812 604 IMG_0001.JPG GCP1\n245900 3179600 12.3 790 410 IMG_0002.JPG GCP1\n245950 3179650 12.8 100 200 IMG_0002.JPG GCP2\n',
    );
    expect(t.odm?.epsg).toBe(32639);
    const r = toGcpFile(t, guessMapping(t), { ...OPTS, epsg: t.odm?.epsg ?? 32639 });
    expect(r.errors).toEqual([]);
    expect(r.file?.points.map((p) => [p.id, p.marks.length])).toEqual([
      ['GCP1', 2],
      ['GCP2', 1],
    ]);
    expect(r.file?.points[0]?.marks[0]).toEqual({
      photo: 'IMG_0001.JPG',
      px: [812, 604],
      by: 'import',
      at: '2026-10-07T10:00:00.000Z',
      state: 'confirmed',
    });
  });

  it('names the EPSG code of ODM and proj CRS lines', () => {
    expect(epsgFromCrsLine('EPSG:32639')).toBe(32639);
    expect(epsgFromCrsLine('WGS84 UTM 33S')).toBe(32733);
    expect(epsgFromCrsLine('+proj=utm +zone=39 +datum=WGS84 +units=m +no_defs')).toBe(32639);
    expect(epsgFromCrsLine('+proj=longlat +datum=WGS84')).toBe(4326);
    expect(epsgFromCrsLine('+proj=tmerc +lat_0=0')).toBeNull();
  });

  it('refuses duplicates, text in coordinates and incomplete mappings with line numbers', () => {
    expect(imp('id,x,y,z\nA,1,2,3\nA,4,5,6').errors).toEqual([
      'Line 3: point "A" is listed twice.',
    ]);
    expect(imp('id,x,y,z\nA,1,two,3').errors).toEqual([
      'Line 2: the northing "two" is not a number.',
    ]);
    expect(mappingProblem(['id', 'x', 'skip', 'z'])).toBe(
      'Choose the easting and the northing column.',
    );
    expect(mappingProblem(['id', 'x', 'y', 'skip'])).toBe('Choose the height column.');
    expect(mappingProblem(['id', 'x', 'x', 'z'])).toBe('Easting (x) is chosen for two columns.');
    expect(mappingProblem(['lat', 'y', 'lon', 'z'])).toMatch(/either latitude and longitude/);
    expect(() => readTable('\n# comment\n')).toThrow('The file is empty.');
  });

  it('names points without an id by their line, and reads unknown roles as control', () => {
    const t = readTable('id,x,y,z,role\n,1,2,3,maybe');
    const r = toGcpFile(t, guessMapping(t), OPTS);
    expect(r.file?.points[0]).toMatchObject({ id: 'GCP1', role: 'control' });
    expect(r.warnings).toEqual([
      'Line 2: role "maybe" read as control.',
      '1 point has no id; named by line.',
    ]);
  });
});
