import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  detectFormat,
  probe12da,
  probeDesign,
  probeDxf,
  probeLandXml,
  probeText,
} from './designProbe';

const dxf = (insunits: number | null, layers: string[]) =>
  [
    '0',
    'SECTION',
    '2',
    'HEADER',
    ...(insunits === null ? [] : ['9', '$INSUNITS', '70', String(insunits)]),
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'TABLES',
    '0',
    'LAYER',
    '2',
    'Unused',
    '8',
    'NotAnEntity',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    ...layers.flatMap((l) => ['0', 'LINE', '8', l, '10', '0.0', '20', '0.0', '30', '0.0']),
    '0',
    'ENDSEC',
    '0',
    'EOF',
  ].join('\r\n');

const landXml = `<?xml version="1.0"?>
<LandXML version="1.2"><Units><Imperial linearUnit="USSurveyFoot"/></Units>
<CgPoints name="Control"><CgPoint>1 2 3</CgPoint></CgPoints>
<Surfaces><Surface name="Pad design" desc="x"><Definition/></Surface><Surface name="Subgrade"/></Surfaces>
<Alignments><Alignment name="CL1" staStart="0"/></Alignments></LandXML>`;

describe('design probe', () => {
  it('detects the format as design.import does', () => {
    expect(detectFormat('<?xml version="1.0"?>', '.txt')).toBe('landxml');
    expect(detectFormat('\uFEFF  <LandXML>', '.foo')).toBe('landxml');
    expect(detectFormat('0\nSECTION', '.DXF')).toBe('dxf');
    expect(detectFormat('AutoCAD Binary DXF', '.dxf')).toBe('dxf');
    expect(detectFormat('AC1032', '.dxf')).toBeNull();
    expect(detectFormat('id,e,n,z', '.csv')).toBe('csv');
    expect(detectFormat('model "a"', '.12da')).toBe('12da');
    expect(detectFormat('?', '.png')).toBeNull();
  });

  it('reads DXF units and the layers of its entities, each once', () => {
    expect(probeDxf(dxf(6, ['Kerb', 'Pad', 'Kerb']))).toEqual({
      units: 'm',
      layers: ['Kerb', 'Pad'],
    });
    expect(probeDxf(dxf(21, [])).units).toBe('us-ft');
    expect(probeDxf(dxf(null, ['A'])).units).toBeNull();
    expect(probeDxf(dxf(3, ['A'])).units).toBeNull();
  });

  it('reads LandXML units and its surfaces, point groups and alignments', () => {
    expect(probeLandXml(landXml)).toEqual({
      units: 'us-ft',
      layers: ['Control', 'Pad design', 'Subgrade', 'CL1'],
    });
  });

  it('reads 12da models and tin names, and CSV as one layer named after the file', () => {
    const t =
      'model "Roads"\nstring 3d {\n name "kerb"\n}\ntin {\n name "Final"\n}\nmodel Drains\n';
    expect(probe12da(t)).toEqual({ units: null, layers: ['Roads', 'Final', 'Drains'] });
    expect(probeText('id,e,n,z\n', 'C:/x/Control points.csv')).toEqual({
      format: 'csv',
      units: null,
      layers: ['Control points'],
    });
  });

  describe('files', () => {
    let dir = '';
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'probe-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('probes a file, refuses other kinds and a missing file', async () => {
      const p = join(dir, 'Pad design.xml');
      await writeFile(p, landXml);
      expect(await probeDesign(p)).toEqual({
        ok: true,
        format: 'landxml',
        units: 'us-ft',
        layers: ['Control', 'Pad design', 'Subgrade', 'CL1'],
        partial: false,
      });
      expect(await probeDesign(join(dir, 'photo.png'))).toMatchObject({ ok: false });
      expect(await probeDesign(join(dir, 'gone.dxf'))).toMatchObject({ ok: false });
    });
  });
});
