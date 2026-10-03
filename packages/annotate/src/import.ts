import type {
  ClassCatalogue,
  ImageGeom,
  Issue,
  IssueClass,
  SeverityModel,
  Sighting,
  Vec3,
} from '@aio/schema';
import { nextIssueCode } from './model/ops';

/**
 * Import helpers for Asset Inspection Kit findings (used by the importer stream S10):
 * HCl `findings.json` (3D findings with photos) and EBSM / DAMAC `annotations.json`
 * (photos with masks, overlays and boxes).
 */

/** Kit frame (Y up, X north, Z east) to the project local frame (Y up, X east, Z south). */
export function kitFrameToLocal(v: Vec3): Vec3 {
  return [v[2], v[1], -v[0]];
}

export function classIdFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unclassified';
}

/** The client report scale 1 to 5 used by the HCl tank report (5 = most severe). */
export function clientScaleModel(id: string, name = 'Client scale 1 to 5'): SeverityModel {
  return {
    id,
    name,
    levels: [
      { value: 1, label: 'Observation', color: '#8a94a6', criteria: 'Recorded, no action' },
      { value: 2, label: 'Low', color: '#5b9bd5', criteria: 'Minor, review at next inspection' },
      { value: 3, label: 'Medium', color: '#e8c547', criteria: 'Monitor, plan maintenance' },
      { value: 4, label: 'High', color: '#f08a3e', criteria: 'Repair at next opportunity' },
      { value: 5, label: 'Critical', color: '#e5484d', criteria: 'Integrity at risk, act now' },
    ],
    uncertain: { label: 'Uncertain, not graded', color: '#b68ef8' },
  };
}

/** The kit photo scale (1 minor, 2 moderate, 3 severe) with an uncertain level. */
export function kitSeverityModel(id: string, name = 'Kit visual scale'): SeverityModel {
  return {
    id,
    name,
    levels: [
      { value: 1, label: 'Minor', color: '#e8c547', criteria: 'Light staining or surface marks' },
      { value: 2, label: 'Moderate', color: '#f08a3e', criteria: 'Visible deterioration' },
      { value: 3, label: 'Severe', color: '#e5484d', criteria: 'Heavy deterioration' },
    ],
    uncertain: { label: 'Uncertain, not graded', color: '#b68ef8' },
  };
}

export interface ImportResult {
  issues: Issue[];
  /** The classes the findings use, ready to merge into the project's catalogues. */
  catalogue: ClassCatalogue;
}

interface CommonOptions {
  now: string;
  severityModelId: string;
  author?: string;
  photoLayer?: string;
  /** Project-relative path for a kit file name (default `photos/<basename>`). */
  pathFor?: (file: string) => string;
  newId?: () => string;
  catalogueId?: string;
}

// ---- tiny guards (untrusted JSON) ----
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const vec3 = (v: unknown): Vec3 | null => {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [a, b, c] = v as unknown[];
  return typeof a === 'number' && typeof b === 'number' && typeof c === 'number' ? [a, b, c] : null;
};
const basename = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;
const stem = (p: string) => basename(p).replace(/\.[^.]+$/, '');

function codeFor(raw: string, used: Set<string>): string {
  const code = /^[A-Z]{1,3}\d{2,4}$/.test(raw) ? raw : '';
  const final = code && !used.has(code) ? code : nextIssueCode([...used], 'F');
  used.add(final);
  return final;
}

function severityOf(v: unknown): Issue['severity'] {
  const n = num(v);
  return n === null ? 'uncertain' : Math.round(n);
}

const makeId = (opts: CommonOptions) => opts.newId ?? (() => globalThis.crypto.randomUUID());

function catalogueOf(
  classes: Map<string, IssueClass>,
  opts: CommonOptions,
  name: string,
): ClassCatalogue {
  return {
    id: opts.catalogueId ?? 'kit',
    name,
    assetType: 'inspection',
    classes: [...classes.values()],
  };
}

/** HCl tank `findings.json`: one issue per finding with a mesh pin and its photo. */
export function importHclFindings(
  json: unknown,
  opts: CommonOptions & { meshLayer: string; toLocal?: (v: Vec3) => Vec3 },
): ImportResult {
  if (!isObj(json) || !Array.isArray(json.photos)) {
    throw new Error('This is not a kit findings file (expected a "photos" list of findings)');
  }
  const toLocal = opts.toLocal ?? kitFrameToLocal;
  const id = makeId(opts);
  const used = new Set<string>();
  const classes = new Map<string, IssueClass>();
  const palette = ['#e5484d', '#f08a3e', '#e8c547', '#5b9bd5', '#b68ef8', '#7cc46b', '#34a6d9'];
  const issues: Issue[] = [];
  for (const f of json.photos) {
    if (!isObj(f)) continue;
    const label = str(f.class) || 'Unclassified';
    const classId = classIdFromLabel(label);
    if (!classes.has(classId)) {
      classes.set(classId, {
        id: classId,
        label,
        color: palette[classes.size % palette.length] ?? '#8a94a6',
        severityModel: opts.severityModelId,
      });
    }
    const sightings: Sighting[] = [];
    const loc = isObj(f.location) ? vec3(f.location.pos_m) : null;
    const photo = isObj(f.photo) ? f.photo : {};
    if (loc) {
      const view = vec3(photo.view_dir);
      const n: Vec3 = view ? toLocal([-view[0], -view[1], -view[2]]) : [0, 1, 0];
      sightings.push({
        on: 'mesh',
        layer: opts.meshLayer,
        geom: { type: 'spoint', p: toLocal(loc), n },
      });
    }
    const file = str(f.file);
    if (file && opts.photoLayer) {
      const size = Array.isArray(photo.size_px) ? photo.size_px.map(num) : [];
      const w = size[0] ?? null;
      const h = size[1] ?? null;
      // The camera was aimed at the finding: mark the photo centre.
      const geom: ImageGeom =
        w !== null && h !== null
          ? { type: 'point', x: w / 2, y: h / 2 }
          : { type: 'point', x: 0, y: 0 };
      sightings.push({ on: 'image', layer: opts.photoLayer, photo: stem(file), geom });
    }
    if (!sightings.length) continue;
    const extra = [
      str(f.area) && `Area: ${str(f.area)}.`,
      num(f.report_page) !== null && `Report page ${str(f.report_page)}.`,
    ].filter(Boolean);
    issues.push({
      id: id(),
      code: codeFor(str(f.finding_id), used),
      classId,
      severityModelId: opts.severityModelId,
      severity: severityOf(f.severity),
      status: 'approved',
      title: str(f.title) || label,
      note: [str(f.description), ...extra].filter(Boolean).join('\n'),
      author: opts.author ?? 'Asset Inspection Kit',
      createdAt: opts.now,
      updatedAt: opts.now,
      sightings,
      source: 'import',
    });
  }
  return { issues, catalogue: catalogueOf(classes, opts, 'HCl findings') };
}

/** EBSM / DAMAC `annotations.json`: one issue per finding id, with mask and box sightings. */
export function importKitAnnotations(json: unknown, opts: CommonOptions): ImportResult {
  if (!isObj(json) || !Array.isArray(json.photos) || !isObj(json.legend_mask_values)) {
    throw new Error(
      'This is not a kit annotations file (expected "photos" and "legend_mask_values")',
    );
  }
  const layer = opts.photoLayer ?? 'photos';
  const pathFor = opts.pathFor ?? ((f: string) => `photos/${basename(f)}`);
  const id = makeId(opts);
  const classes = new Map<string, IssueClass>();
  const legend = new Map<number, string>();
  for (const [key, v] of Object.entries(json.legend_mask_values)) {
    if (!isObj(v)) continue;
    const label = str(v.class);
    const cid = classIdFromLabel(label);
    legend.set(Number(key), cid);
    const color = /^#[0-9a-fA-F]{6}$/.test(str(v.colour)) ? str(v.colour) : '#8a94a6';
    const cls: IssueClass = { id: cid, label, color, severityModel: opts.severityModelId };
    if (key.length === 1) cls.hotkey = key;
    classes.set(cid, cls);
  }
  const isUncertain = (cid: string) => cid.startsWith('uncertain');
  const used = new Set<string>();
  const byFinding = new Map<string, Issue>();
  for (const p of json.photos) {
    if (!isObj(p)) continue;
    const photo = str(p.photo_id);
    const files = isObj(p.files) ? p.files : {};
    const boxes = (Array.isArray(p.boxes) ? p.boxes : []).filter(isObj).map((b) => {
      const bb = Array.isArray(b.bbox) ? b.bbox.map(num) : [];
      const [x0, y0, x1, y1] = [bb[0] ?? 0, bb[1] ?? 0, bb[2] ?? 0, bb[3] ?? 0];
      const cid = legend.get(num(b.class_value) ?? -1) ?? classIdFromLabel(str(b.class));
      return { cid, pixels: num(b.pixels) ?? 0, geom: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
    });
    for (const f of Array.isArray(p.findings) ? p.findings : []) {
      if (!isObj(f)) continue;
      const fid = str(f.finding_id);
      let classId = str(f.class) ? classIdFromLabel(str(f.class)) : '';
      if (!classId) {
        const dominant = boxes
          .filter((b) => !isUncertain(b.cid))
          .sort((a, b) => b.pixels - a.pixels)[0];
        classId = dominant?.cid ?? 'unclassified';
      }
      if (!classes.has(classId)) {
        classes.set(classId, {
          id: classId,
          label: str(f.class) || classId,
          color: '#8a94a6',
          severityModel: opts.severityModelId,
        });
      }
      const sightings: Sighting[] = [];
      const mask = str(files.mask_labels);
      if (mask) {
        sightings.push({
          on: 'image',
          layer,
          photo,
          geom: { type: 'mask', src: { path: pathFor(mask) } },
        });
      }
      const matching = str(f.class)
        ? boxes.filter((b) => b.cid === classId)
        : boxes.filter((b) => !isUncertain(b.cid));
      for (const b of matching) {
        if (b.geom.w > 0 && b.geom.h > 0) {
          sightings.push({ on: 'image', layer, photo, geom: { type: 'box', ...b.geom } });
        }
      }
      if (!sightings.length) continue;
      const existing = byFinding.get(fid);
      if (existing && fid) {
        existing.sightings.push(...sightings);
        continue;
      }
      const label = classes.get(classId)?.label ?? classId;
      const component = str(f.component);
      const where = [str(f.zone), str(f.side_approx)].filter(Boolean).join(', ');
      const issue: Issue = {
        id: id(),
        code: codeFor(fid, used),
        classId,
        severityModelId: opts.severityModelId,
        severity: severityOf(f.severity),
        status: 'approved',
        title: component ? `${label}, ${component}` : label,
        note: [
          str(f.note),
          where && `Location: ${where}.`,
          str(f.defect_id) && `Defect ${str(f.defect_id)}.`,
        ]
          .filter(Boolean)
          .join('\n'),
        author: opts.author ?? 'Asset Inspection Kit',
        createdAt: opts.now,
        updatedAt: opts.now,
        sightings,
        source: 'import',
      };
      byFinding.set(fid || issue.id, issue);
    }
  }
  return { issues: [...byFinding.values()], catalogue: catalogueOf(classes, opts, 'Kit classes') };
}
