import { parseManifest, type ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  GENERAL_TEMPLATE,
  newProjectManifest,
  ROAD_TEMPLATE,
  severityTemplates,
} from './templates';

const sev = (id: string, name: string) => ({
  id,
  name,
  levels: [
    { value: 1, label: 'Low', color: '#95a0ab', criteria: 'a' },
    { value: 2, label: 'High', color: '#f05653', criteria: 'b' },
  ],
});

const project = (name: string, models: ReturnType<typeof sev>[]): ProjectManifest => ({
  schema: 'aio.project/1',
  id: name.toLowerCase(),
  name,
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: models,
  classCatalogues: models.map((m) => ({
    id: `${m.id}-classes`,
    name: `${m.name} classes`,
    assetType: 'asset',
    classes: [{ id: 'corrosion', label: 'Corrosion', color: '#f05653', severityModel: m.id }],
  })),
});

describe('severityTemplates', () => {
  it('offers each project severity model once, with its classes, plus the general template', () => {
    const t = severityTemplates([
      project('EBSM', [sev('aik-stack', 'Stack')]),
      project('HCl', [sev('hcl-lining', 'HCl lining')]),
      project('EBSM copy', [sev('aik-stack', 'Stack')]),
    ]);
    expect(t.map((x) => x.id)).toEqual([
      'aik-stack',
      'hcl-lining',
      GENERAL_TEMPLATE.id,
      ROAD_TEMPLATE.id,
    ]);
    expect(t[0]?.source).toBe('EBSM, EBSM copy');
    expect(t[0]?.catalogue?.classes.map((c) => c.id)).toEqual(['corrosion']);
  });

  it('offers the road template (a road catalogue) once', () => {
    expect(ROAD_TEMPLATE.catalogue?.assetType).toBe('road');
    expect(ROAD_TEMPLATE.catalogue?.classes).toHaveLength(10);
    const ring = project('Ring', []);
    ring.severityModels = [ROAD_TEMPLATE.model];
    const t = severityTemplates([ring]);
    expect(t.filter((x) => x.id === ROAD_TEMPLATE.id)).toHaveLength(1);
  });
});

describe('newProjectManifest', () => {
  it('builds a valid manifest with the chosen template, brand, type and capture date', () => {
    const [stack] = severityTemplates([project('EBSM', [sev('aik-stack', 'Stack')])]);
    const m = newProjectManifest(
      'ebsm-flare',
      {
        name: 'EBSM flare',
        customer: 'EQUATE',
        site: 'Kuwait',
        type: 'inspection',
        epsg: 32639,
        origin: [221029.443, 3214461.958, 31.7],
        severityTemplate: 'aik-stack',
        brand: 'eand',
        captureDate: '2019-01-24',
      },
      stack ?? null,
    );
    const parsed = parseManifest(m);
    expect(parsed.ok).toBe(true);
    expect(m).toMatchObject({
      id: 'ebsm-flare',
      name: 'EBSM flare',
      crs: { epsg: 32639 },
      type: 'inspection',
      brand: 'eand',
      layers: [],
      captures: [{ id: 'capture-2019-01-24', date: '2019-01-24' }],
    });
    expect(m.severityModels.map((s) => s.id)).toEqual(['aik-stack']);
    expect(m.classCatalogues).toHaveLength(1);
  });

  it('falls back to the general template and leaves out empty fields', () => {
    const m = newProjectManifest(
      'p',
      { name: 'P', type: 'fusion', epsg: 32640, origin: [1, 2, 3], severityTemplate: null },
      null,
    );
    expect(parseManifest(m).ok).toBe(true);
    expect(m.severityModels[0]?.id).toBe(GENERAL_TEMPLATE.id);
    expect('customer' in m).toBe(false);
    expect(m.captures).toEqual([]);
  });
});
