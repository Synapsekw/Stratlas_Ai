/**
 * Reading a project folder's sources for the fact index. Every file is read tolerantly: a missing
 * file is empty, an unreadable file or record is left out (the app's own readers report those),
 * so the index never fails a project the app can open. Nothing here writes.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auditEntries, loadJournal } from '@aio/journal';
import {
  AccuracyReport,
  ChangeSet,
  Detection,
  DetectionsFile,
  Issue,
  MeasurementsFile,
  parseManifestTolerant,
  SurveyQa,
  ThermalCandidatesFile,
  ThermalFile,
  WalkFile,
  type AuditEntry,
  type ProjectManifest,
  type SurveyMeasurement,
} from '@aio/schema';

/** A pass file's header (everything but its detections) and its readable detections. */
export interface DetectionPass {
  /** Project-relative path, `detections/<name>.json`. */
  file: string;
  source: DetectionsFile['source'];
  layer?: string;
  producer?: string;
  createdAt?: string;
  detections: Detection[];
}

/** Everything the index is built from, parsed. Arrays are in a fixed (sorted) order. */
export interface ProjectSources {
  manifest: ProjectManifest | null;
  measurements: SurveyMeasurement[];
  qa: { file: string; qa: SurveyQa }[];
  accuracy: { file: string; report: AccuracyReport }[];
  detections: DetectionPass[];
  issues: Issue[];
  changeSets: { file: string; set: ChangeSet }[];
  thermal: ThermalFile | null;
  candidates: ThermalCandidatesFile | null;
  walks: { file: string; walk: WalkFile }[];
  /** The journal's ops as audit entries (newest first, as `auditEntries` gives them). */
  events: AuditEntry[];
}

export const emptySources = (): ProjectSources => ({
  manifest: null,
  measurements: [],
  qa: [],
  accuracy: [],
  detections: [],
  issues: [],
  changeSets: [],
  thermal: null,
  candidates: null,
  walks: [],
  events: [],
});

async function text(file: string): Promise<string | null> {
  try {
    const t = await readFile(file, 'utf8');
    return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  } catch {
    return null;
  }
}

async function json(file: string): Promise<unknown> {
  const t = await text(file);
  if (t === null) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

async function names(dir: string, re: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && re.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

async function dirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The readable items of an array field; the bad ones are left out. */
function items<T>(raw: unknown, key: string, parse: (v: unknown) => T | null): T[] {
  const list = isObj(raw) ? raw[key] : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const p = parse(v);
    return p === null ? [] : [p];
  });
}

/** Parse a detections pass file: its header strictly, each detection on its own. */
export function parsePass(file: string, raw: unknown): DetectionPass | null {
  if (!isObj(raw) || raw.schema !== 'aio.detections/1') return null;
  const header = DetectionsFile.safeParse({ ...raw, detections: [] });
  if (!header.success) return null;
  const h = header.data;
  return {
    file,
    source: h.source,
    ...(h.layer ? { layer: h.layer } : {}),
    ...(h.producer ? { producer: h.producer } : {}),
    ...(h.createdAt ? { createdAt: h.createdAt } : {}),
    detections: items(raw, 'detections', (v) => {
      const d = Detection.safeParse(v);
      return d.success ? d.data : null;
    }),
  };
}

/** Every journal file under `journal/`, by project-relative path. */
async function journalFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string): Promise<void> => {
    let list: { name: string; isDirectory(): boolean }[];
    try {
      list = await readdir(join(root, ...rel.split('/')), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) await walk(child);
      else if (/\.(jsonl|json)$/.test(d.name)) {
        const t = await text(join(root, ...child.split('/')));
        if (t !== null) out.set(child, t);
      }
    }
  };
  await walk('journal');
  return out;
}

/** Read every source of a project folder. */
export async function readProjectSources(root: string): Promise<ProjectSources> {
  const out = emptySources();
  const m = parseManifestTolerant(await json(join(root, 'manifest.json')));
  if (m.ok) out.manifest = m.value.manifest;

  const meas = MeasurementsFile.safeParse(await json(join(root, 'survey', 'measurements.json')));
  if (meas.success) out.measurements = meas.data.measurements;

  for (const n of await names(join(root, 'survey', 'qa'), /\.json$/)) {
    const q = SurveyQa.safeParse(await json(join(root, 'survey', 'qa', n)));
    if (q.success) out.qa.push({ file: `survey/qa/${n}`, qa: q.data });
  }

  for (const run of await dirs(join(root, 'photogrammetry'))) {
    const rel = `photogrammetry/${run}/report/accuracy.json`;
    const a = AccuracyReport.safeParse(await json(join(root, ...rel.split('/'))));
    if (a.success) out.accuracy.push({ file: rel, report: a.data });
  }

  for (const n of await names(join(root, 'detections'), /\.json$/)) {
    const p = parsePass(`detections/${n}`, await json(join(root, 'detections', n)));
    if (p) out.detections.push(p);
  }

  out.issues = items(await json(join(root, 'issues.json')), 'issues', (v) => {
    const i = Issue.safeParse(v);
    return i.success ? i.data : null;
  });

  for (const n of await names(join(root, 'change'), /\.json$/)) {
    const s = ChangeSet.safeParse(await json(join(root, 'change', n)));
    if (s.success) out.changeSets.push({ file: `change/${n}`, set: s.data });
  }

  const th = ThermalFile.safeParse(await json(join(root, 'thermal', 'thermal.json')));
  if (th.success) out.thermal = th.data;
  const cand = ThermalCandidatesFile.safeParse(
    await json(join(root, 'thermal', 'candidates.json')),
  );
  if (cand.success) out.candidates = cand.data;

  for (const id of await dirs(join(root, 'walks'))) {
    const w = WalkFile.safeParse(await json(join(root, 'walks', id, 'walk.json')));
    if (w.success) out.walks.push({ file: `walks/${id}/walk.json`, walk: w.data });
  }

  const files = await journalFiles(root);
  if (files.size) {
    try {
      out.events = auditEntries(loadJournal(files));
    } catch {
      out.events = [];
    }
  }
  return out;
}
