import { describe, expect, it } from 'vitest';
import {
  fileStem,
  formProblem,
  importParams,
  initialForm,
  typedLayerNames,
  type DesignProbe,
} from './designImportForm';

const SRC = String.raw`C:\designs\Pad design.xml`;
const probe = (p: Partial<DesignProbe> = {}): DesignProbe => ({
  ok: true,
  format: 'landxml',
  units: null,
  layers: ['Pad', 'Road', 'CL1'],
  partial: false,
  ...p,
});

describe('import design options', () => {
  it('leaves every default out, so the import decides as without options', () => {
    const pr = probe();
    expect(fileStem(SRC)).toBe('Pad design');
    expect(fileStem('/x/noext')).toBe('noext');
    expect(importParams(SRC, initialForm(SRC, pr), pr)).toEqual({ src: SRC });
    expect(importParams(SRC, initialForm(SRC, null), null)).toEqual({ src: SRC });
  });

  it('sends what the person changed: format, name, CRS, units and a subset of layers', () => {
    const pr = probe();
    const form = {
      ...initialForm(SRC, pr),
      format: 'dxf' as const,
      name: ' Pad v2 ',
      crs: { epsg: 32640 },
      units: 'mm' as const,
      picked: ['CL1', 'Pad'],
    };
    expect(importParams(SRC, form, pr)).toEqual({
      src: SRC,
      format: 'dxf',
      name: 'Pad v2',
      crs: { epsg: 32640 },
      units: 'mm',
      // in the file's order
      layers: ['Pad', 'CL1'],
    });
  });

  it('uses the calibration instead of a CRS, and never overrides units the file states', () => {
    const pr = probe({ units: 'ft' });
    const form = {
      ...initialForm(SRC, pr),
      useCalibration: true,
      crs: { epsg: 2240 },
      units: 'm' as const,
    };
    expect(importParams(SRC, form, pr)).toEqual({ src: SRC, useCalibration: true });
  });

  it('takes typed layer names when the file could not be listed', () => {
    const pr = probe({ partial: true });
    const form = { ...initialForm(SRC, pr), typedLayers: 'Pad, Road\nPad,  ' };
    expect(typedLayerNames(form.typedLayers)).toEqual(['Pad', 'Road']);
    expect(importParams(SRC, form, pr)).toEqual({ src: SRC, layers: ['Pad', 'Road'] });
  });

  it('refuses an empty name and no ticked layer', () => {
    const pr = probe();
    expect(formProblem(initialForm(SRC, pr), pr)).toBeNull();
    expect(formProblem({ ...initialForm(SRC, pr), name: ' ' }, pr)).toMatch(/name/);
    expect(formProblem({ ...initialForm(SRC, pr), picked: [] }, pr)).toMatch(/layer/);
    expect(formProblem({ ...initialForm(SRC, null), picked: [] }, null)).toBeNull();
  });
});
