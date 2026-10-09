/**
 * Survey exports in the renderer (M11 G7, SRV-9, DSN-5): what each export can be written as, the
 * sources it reads, the file name it is offered under and the `survey.export` parameters. The
 * pipeline (`python/src/aio_pipelines/survey/export.py`) holds the same matrix and refuses
 * anything else; the file name suffix is the rule of `export/frame.py` `name_suffix`, both checked
 * against `__fixtures__/export-names.json`.
 */
import {
  SurveyExportParams,
  type DesignsFile,
  type HeightTiles,
  type MeasurementsFile,
  type ProjectManifest,
  type SurveyOverlaysFile,
  type SurveySettings,
} from '@aio/schema';

export type ExportWhat = SurveyExportParams['what'];
export type ExportFormat = SurveyExportParams['format'];
export type ExportCrs = SurveyExportParams['crs'];
/** The units survey files are written in. */
export type ExportUnits = 'm' | 'ft' | 'us-ft';

export const WHAT_LABELS: Record<ExportWhat, string> = {
  surface: 'Surface',
  ortho: 'Orthomosaic',
  cloud: 'Point cloud',
  contours: 'Contours',
  measurements: 'Measurements',
  section: 'Sections',
};

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  geotiff: 'GeoTIFF',
  laz: 'LAZ',
  dxf: 'DXF',
  landxml: 'LandXML',
  '12da': '12d Archive (12da)',
  csv: 'CSV',
  kml: 'KMZ (Google Earth)',
  shp: 'Shapefile',
  geojson: 'GeoJSON',
};

/** What each export is written as (the pipeline's `MATRIX`), the first being the default. */
export const MATRIX: Record<ExportWhat, readonly ExportFormat[]> = {
  surface: ['landxml', 'dxf', '12da', 'geotiff', 'csv', 'geojson', 'kml', 'shp'],
  ortho: ['geotiff'],
  cloud: ['laz'],
  contours: ['dxf', 'shp', 'geojson', 'kml'],
  measurements: ['dxf', 'csv', 'kml', 'landxml', '12da', 'geojson', 'shp'],
  section: ['csv', 'dxf'],
};

export const EXTENSION: Record<ExportFormat, string> = {
  geotiff: 'tif',
  laz: 'laz',
  dxf: 'dxf',
  landxml: 'xml',
  '12da': '12da',
  csv: 'csv',
  kml: 'kmz',
  shp: 'shp',
  geojson: 'geojson',
};

/** Formats whose files carry their own CRS (horizontal coordinates in its unit). */
export const CARRIES_CRS: readonly ExportFormat[] = ['geotiff', 'laz', 'shp', 'geojson', 'kml'];
/** Formats that need grid coordinates (no longitude and latitude). */
export const GRID_ONLY: readonly ExportFormat[] = ['dxf', 'landxml', '12da'];

/** Level of detail for surfaces and clouds: the share of faces or points kept. */
export const DETAIL: readonly { id: 'full' | 'medium' | 'low'; label: string; share: number }[] = [
  { id: 'full', label: 'High (every post)', share: 1 },
  { id: 'medium', label: 'Medium (one post in 2 each way)', share: 0.25 },
  { id: 'low', label: 'Low (one post in 4 each way)', share: 0.0625 },
];

/** Whether the level of detail applies. */
export function hasDetail(what: ExportWhat, format: ExportFormat): boolean {
  if (what === 'cloud') return true;
  return what === 'surface' && ['dxf', 'landxml', '12da', 'csv', 'geotiff'].includes(format);
}

const UNIT_WORD: Record<ExportUnits, string> = { m: 'm', ft: 'ft', 'us-ft': 'usft' };

/** The geoid id as a file name word (letters, digits and dashes, lower case). */
function slugGeoid(id: string | null | undefined): string {
  const s = (id ?? 'geoid').toLowerCase().replace(/[^a-z0-9-]+/g, '');
  return s || 'geoid';
}

/**
 * The file name suffix every export carries (data-conventions section 25):
 * `_<crs>[_<heights>]_<units>`, for example `_site-grid_usft` or `_wgs84_ellh_m`.
 */
export function exportSuffix(
  crs: ExportCrs,
  calibrated: boolean,
  vertical: string,
  geoid: string | null | undefined,
  units: ExportUnits,
): string {
  const word =
    crs === 'site'
      ? calibrated
        ? 'site-grid-cal'
        : 'site-grid'
      : crs === 'wgs84'
        ? 'wgs84'
        : `epsg${String(crs.epsg)}`;
  const v = vertical === 'calibration' && crs !== 'site' ? 'ellipsoidal' : vertical;
  const heights =
    v === 'project'
      ? ''
      : v === 'ellipsoidal'
        ? 'ellh'
        : v === 'calibration'
          ? 'cal'
          : slugGeoid(geoid);
  return `_${[word, heights, UNIT_WORD[units]].filter(Boolean).join('_')}`;
}

/** The suffix for this site's settings. */
export function siteSuffix(settings: SurveySettings, crs: ExportCrs, units: ExportUnits): string {
  const vd = settings.verticalDatum;
  const geoid = vd.kind === 'geoid' ? vd.geoid : null;
  return exportSuffix(crs, Boolean(settings.calibration), vd.kind, geoid, units);
}

/** A file-name-safe base. */
export function fileBase(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._()-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 120) || 'export'
  );
}

export function exportFileName(base: string, suffix: string, format: ExportFormat): string {
  return `${fileBase(base)}${suffix}.${EXTENSION[format]}`;
}

/** The units a site exports in by default: its distance unit when it is a length survey files hold. */
export function defaultUnits(settings: SurveySettings): ExportUnits {
  const d = settings.units.distance;
  return d === 'ft' || d === 'us-ft' ? d : 'm';
}

/** One source a person can pick: the parameter it sets and its label. */
export interface ExportSource {
  key: string;
  label: string;
  param: { surface: string } | { layer: string } | { overlay: string };
}

export interface SourceInputs {
  surfaces: readonly HeightTiles[];
  designs: DesignsFile | null;
  overlays: SurveyOverlaysFile | null;
  manifest: Pick<ProjectManifest, 'layers'> | null;
}

/** The sources an export of `what` can read. */
export function sourcesFor(what: ExportWhat, inp: SourceInputs): ExportSource[] {
  const out: ExportSource[] = [];
  const layers = inp.manifest?.layers ?? [];
  if (what === 'surface' || what === 'contours') {
    for (const s of inp.surfaces)
      out.push({ key: `surface:${s.id}`, label: s.name, param: { surface: s.id } });
  }
  if (what === 'surface') {
    for (const d of inp.designs?.designs ?? []) {
      const live = d.layers.filter((l) => !l.archived);
      if (live.length > 1)
        out.push({
          key: `layer:${d.id}`,
          label: `${d.name} (whole design)`,
          param: { layer: d.id },
        });
      for (const l of live)
        out.push({
          key: `layer:${d.id}/${l.id}`,
          label: `${d.name}, ${l.name}`,
          param: { layer: `${d.id}/${l.id}` },
        });
    }
  }
  if (what === 'surface' || what === 'contours') {
    for (const o of inp.overlays?.overlays ?? []) {
      const diff = 'comparison' in o.source;
      if ((what === 'surface' && diff) || (what === 'contours' && (o.kind === 'contours' || diff)))
        out.push({
          key: `overlay:${o.id}`,
          label: diff ? `${o.name} (difference)` : o.name,
          param: { overlay: o.id },
        });
    }
  }
  if (what === 'ortho' || what === 'cloud') {
    for (const l of layers) {
      const ok =
        what === 'cloud'
          ? l.kind === 'pointcloud'
          : l.kind === 'raster' && 'role' in l && l.role !== 'dsm';
      if (ok) out.push({ key: `layer:${l.id}`, label: l.name, param: { layer: l.id } });
    }
  }
  return out;
}

/** The measurement ids of a choice: the selection, a folder, or every one of a family. */
export function measurementIds(
  file: MeasurementsFile,
  choice:
    | { kind: 'selected'; ids: readonly string[] }
    | { kind: 'folder'; folder: string }
    | { kind: 'all' },
  linesOnly: boolean,
): string[] {
  const ok = (m: MeasurementsFile['measurements'][number]) =>
    !linesOnly || (m.family === 'line' && m.points.length >= 2);
  const ms = file.measurements.filter(ok);
  if (choice.kind === 'selected') {
    const want = new Set(choice.ids);
    return ms.filter((m) => want.has(m.id)).map((m) => m.id);
  }
  if (choice.kind === 'folder')
    return ms.filter((m) => m.folder === choice.folder).map((m) => m.id);
  return ms.map((m) => m.id);
}

export interface ExportChoice {
  what: ExportWhat;
  format: ExportFormat;
  crs: ExportCrs;
  units: ExportUnits;
  detail: number;
  source: ExportSource | null;
  measurements: readonly string[];
  /** For measurements and sections: the prepared surface to sample or clip. */
  surface: string | null;
}

/** Why an export cannot be made as chosen (a sentence), or null. */
export function exportProblem(c: ExportChoice): string | null {
  if (!MATRIX[c.what].includes(c.format))
    return `${WHAT_LABELS[c.what]} exports as ${MATRIX[c.what].map((f) => FORMAT_LABELS[f]).join(', ')}.`;
  if (c.format === 'kml' && c.crs !== 'wgs84')
    return 'KMZ holds WGS 84 longitude and latitude; choose WGS 84.';
  if (c.format === 'kml' && c.units !== 'm') return 'KMZ heights are metres; choose metres.';
  if (GRID_ONLY.includes(c.format) && c.crs === 'wgs84')
    return `${FORMAT_LABELS[c.format]} needs grid coordinates; choose the site grid or an EPSG code.`;
  if (c.crs !== 'site' && c.crs !== 'wgs84' && !(Number.isInteger(c.crs.epsg) && c.crs.epsg > 0))
    return 'Type an EPSG code, such as 32639.';
  if (['surface', 'ortho', 'cloud', 'contours'].includes(c.what) && !c.source)
    return 'Pick what to export.';
  if (c.what === 'section' && !c.measurements.length) return 'Pick one or more line measurements.';
  if (c.what === 'measurements' && !c.measurements.length) return 'Pick one or more measurements.';
  return null;
}

/** The `survey.export` parameters for a choice and the destination main's dialog answered. */
export function exportParams(c: ExportChoice, out: string): SurveyExportParams {
  const p: Record<string, unknown> = {
    what: c.what,
    format: c.format,
    crs: c.crs,
    units: c.units,
    out,
  };
  if (hasDetail(c.what, c.format) && c.detail < 1) p.decimate = c.detail;
  if (c.source) Object.assign(p, c.source.param);
  if (c.what === 'measurements' || c.what === 'section') {
    p.measurements = [...c.measurements];
    if (c.surface) p.surface = c.surface;
  }
  return SurveyExportParams.parse(p);
}
