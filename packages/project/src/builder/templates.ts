import type {
  ClassCatalogue,
  NewProjectRequest,
  ProjectManifest,
  SeverityTemplate,
} from '@aio/schema';
import { ROAD_CATALOGUE, ROAD_SEVERITY_MODEL } from '../import/ringroad-model';

/** Used when no project offers a better model: three grades with neutral wording. */
export const GENERAL_TEMPLATE: SeverityTemplate = {
  id: 'general-inspection',
  label: 'General inspection (1 to 3)',
  source: 'Built in',
  model: {
    id: 'general-inspection',
    name: 'General inspection',
    levels: [
      { value: 1, label: 'Minor', color: '#78b3d6', criteria: 'Cosmetic or early stage. Monitor.' },
      {
        value: 2,
        label: 'Moderate',
        color: '#ebc751',
        criteria: 'Visible deterioration. Plan maintenance.',
      },
      {
        value: 3,
        label: 'Severe',
        color: '#f05653',
        criteria: 'Loss of function or safety risk. Act now.',
      },
    ],
    uncertain: { label: 'Uncertain', color: '#878d93' },
  },
  catalogue: {
    id: 'general-inspection-classes',
    name: 'General inspection classes',
    assetType: 'asset',
    classes: [
      {
        id: 'corrosion',
        label: 'Corrosion',
        color: '#f48d3c',
        severityModel: 'general-inspection',
      },
      { id: 'crack', label: 'Crack', color: '#f05653', severityModel: 'general-inspection' },
      { id: 'damage', label: 'Damage', color: '#ebc751', severityModel: 'general-inspection' },
      { id: 'other', label: 'Other', color: '#95a0ab', severityModel: 'general-inspection' },
    ],
  },
};

/**
 * Road surveys: ASTM D6433 grades and the asphalt distress classes, as the 1st Ring Road import
 * and the road builder (`road.build`) write them. Its catalogue (`assetType: 'road'`) makes a new
 * project open in the road workspace.
 */
export const ROAD_TEMPLATE: SeverityTemplate = {
  id: ROAD_SEVERITY_MODEL.id,
  label: ROAD_SEVERITY_MODEL.name,
  source: 'Built in',
  model: ROAD_SEVERITY_MODEL,
  catalogue: ROAD_CATALOGUE,
};

/**
 * Severity models of the projects in the library as wizard templates, each once (by model id),
 * with the classes that use it; then the general template, and the road template unless a
 * project already offers it.
 */
export function severityTemplates(manifests: readonly ProjectManifest[]): SeverityTemplate[] {
  const byId = new Map<string, SeverityTemplate>();
  for (const m of manifests) {
    for (const model of m.severityModels) {
      const known = byId.get(model.id);
      if (known) {
        if (!known.source.split(', ').includes(m.name)) known.source += `, ${m.name}`;
        continue;
      }
      let catalogue: ClassCatalogue | undefined;
      for (const c of m.classCatalogues) {
        const classes = c.classes.filter((k) => k.severityModel === model.id);
        if (classes.length) {
          catalogue = { ...c, classes };
          break;
        }
      }
      byId.set(model.id, {
        id: model.id,
        label: model.name,
        source: m.name,
        model,
        ...(catalogue ? { catalogue } : {}),
      });
    }
  }
  if (!byId.has(GENERAL_TEMPLATE.id)) byId.set(GENERAL_TEMPLATE.id, GENERAL_TEMPLATE);
  if (!byId.has(ROAD_TEMPLATE.id)) byId.set(ROAD_TEMPLATE.id, ROAD_TEMPLATE);
  return [...byId.values()];
}

/** The manifest of a new, empty project. */
export function newProjectManifest(
  id: string,
  req: NewProjectRequest,
  template: SeverityTemplate | null,
): ProjectManifest {
  const t = template ?? GENERAL_TEMPLATE;
  const customer = req.customer?.trim();
  const site = req.site?.trim();
  return {
    schema: 'aio.project/1',
    id,
    name: req.name.trim(),
    ...(customer ? { customer } : {}),
    ...(site ? { site } : {}),
    crs: { epsg: req.epsg },
    origin: req.origin,
    captures: req.captureDate
      ? [{ id: `capture-${req.captureDate}`, label: 'Survey', date: req.captureDate }]
      : [],
    layers: [],
    severityModels: [t.model],
    classCatalogues: t.catalogue ? [t.catalogue] : [],
    ...(req.brand ? { brand: req.brand } : {}),
    type: req.type,
    ...(req.verticalDatum ? { verticalDatum: req.verticalDatum } : {}),
  };
}
