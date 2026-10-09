/**
 * The options step of **Import design** (M11 G6): what the person chose (format, CRS or the site
 * calibration, units, layers, name) as `DesignImportParams`. Defaults leave a key out, so
 * `design.import` decides as it does without options (the format from the file, the file's own
 * CRS else the project's, the units the file states, every layer, the name from the file).
 */
import type {
  DesignFormat,
  DesignImportParams,
  DesignSourceUnits,
  IpcResponse,
  ProjectManifest,
} from '@aio/schema';

type Crs = ProjectManifest['crs'];

export type DesignProbe = Extract<IpcResponse<'survey:probeDesign'>, { ok: true }>;

export interface ImportForm {
  /** `auto`: as detected. */
  format: DesignFormat | 'auto';
  /** null: the file's own CRS, else the project's. */
  crs: Crs | null;
  useCalibration: boolean;
  /** `file`: as the file states (metres when it states none). */
  units: DesignSourceUnits | 'file';
  /** Ticked layers when the probe listed them (all ticked: every layer). */
  picked: string[];
  /** Typed layer names, comma separated, when the probe could not list them. */
  typedLayers: string;
  name: string;
}

export const FORMAT_LABELS: Record<DesignFormat, string> = {
  landxml: 'LandXML',
  dxf: 'DXF',
  '12da': '12da',
  csv: 'CSV points',
  ttm: 'Trimble TIN (TTM)',
};

export const UNIT_LABELS: Record<DesignSourceUnits, string> = {
  m: 'metres',
  mm: 'millimetres',
  cm: 'centimetres',
  ft: 'international feet',
  'us-ft': 'US survey feet',
  in: 'inches',
};

/** The file's name without its folder and extension. */
export function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Whether the layers are ticked from the probe's list (else typed). */
export const listsLayers = (probe: DesignProbe | null): boolean =>
  probe !== null && !probe.partial && probe.layers.length > 0;

export function initialForm(path: string, probe: DesignProbe | null): ImportForm {
  return {
    format: 'auto',
    crs: null,
    useCalibration: false,
    units: 'file',
    picked: listsLayers(probe) && probe ? [...probe.layers] : [],
    typedLayers: '',
    name: fileStem(path).slice(0, 200),
  };
}

/** Typed layer names: comma or new line separated, trimmed, each once. */
export function typedLayerNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((s) => s.trim().slice(0, 200))
        .filter(Boolean),
    ),
  ].slice(0, 1000);
}

/** What stops the import, or null. */
export function formProblem(form: ImportForm, probe: DesignProbe | null): string | null {
  if (!form.name.trim()) return 'Give the design a name.';
  if (listsLayers(probe) && form.picked.length === 0) return 'Tick at least one layer to import.';
  return null;
}

/** The job parameters for `design.import`. */
export function importParams(
  src: string,
  form: ImportForm,
  probe: DesignProbe | null,
): DesignImportParams {
  const p: DesignImportParams = { src };
  if (form.format !== 'auto') p.format = form.format;
  const name = form.name.trim().slice(0, 200);
  if (name && name !== fileStem(src)) p.name = name;
  if (form.useCalibration) p.useCalibration = true;
  else if (form.crs) p.crs = form.crs;
  // the import ignores units the file contradicts: only sent when the file states none
  if (form.units !== 'file' && !probe?.units) p.units = form.units;
  if (listsLayers(probe) && probe) {
    if (form.picked.length < probe.layers.length)
      p.layers = probe.layers.filter((l) => form.picked.includes(l));
  } else {
    const typed = typedLayerNames(form.typedLayers);
    if (typed.length) p.layers = typed;
  }
  return p;
}
