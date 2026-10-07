import { canonicalJson } from '@aio/journal';
import {
  BoundaryEditsFile,
  CHANGE_DIR,
  ChangeSet,
  DetectionsFile,
  Issue,
  NARRATIVE_MAX_VERSIONS,
  NarrativeFile,
  PROCMODEL_DIR,
  ProcModel,
  type ChangeSetInput,
} from '@aio/schema';
import type { Projection } from './project';

/**
 * Merged state back into today's files, byte for byte as today's writers make them: the same zod
 * schema shapes the keys (as the IPC request parse does before `writeJsonAtomic`), and
 * `stateFileText` is `writeJsonAtomic`'s text. Records the journal does not know are kept as they
 * are; no field is added to any record (0.8 builds read every file). Main writes the results
 * through the journal service (atomic, `.bak`).
 */

export const ISSUES_SCHEMA = 'aio.issues/1';
export const DETECTIONS_DIR = 'detections';
export const BOUNDARIES_PATH = 'edits/boundaries.json';
export const NARRATIVE_PATH = 'report/narrative.json';

/** The text `writeJsonAtomic` writes for a value. */
export function stateFileText(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export interface Applied<T> {
  value: T;
  /** Merged records that did not validate and were left as they were. */
  problems: string[];
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function overlay(
  base: Record<string, unknown>,
  set: Record<string, unknown>,
  unset: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...base, ...set }).filter(([k]) => !unset.includes(k)),
  );
}

/** `issues.json`: issues made before the journal keep their place first, then made ones by clock. */
export function applyIssues(
  file: unknown,
  p: Pick<Projection, 'issues'>,
): Applied<{ schema: string; issues: Issue[] }> {
  const problems: string[] = [];
  const raw = Array.isArray(obj(file).issues) ? (obj(file).issues as unknown[]) : [];
  const projected = new Map(p.issues.map((i) => [i.id, i]));
  const fromFile = new Map<string, Record<string, unknown>>();
  const out: Issue[] = [];
  const push = (value: Record<string, unknown>, fallback?: Record<string, unknown>) => {
    const r = Issue.safeParse(value);
    if (r.success) {
      out.push(r.data);
      return;
    }
    problems.push(
      `Issue ${String(value.code ?? value.id)}: ${r.error.issues[0]?.message ?? 'not valid'}`,
    );
    if (fallback) {
      const f = Issue.safeParse(fallback);
      if (f.success) out.push(f.data);
    }
  };
  for (const item of raw) {
    const issue = obj(item);
    const id = typeof issue.id === 'string' ? issue.id : undefined;
    if (id !== undefined) fromFile.set(id, issue);
    const pi = id !== undefined ? projected.get(id) : undefined;
    if (!pi) {
      push(issue);
      continue;
    }
    if (pi.state === 'partial') push(overlay(issue, pi.record, pi.unset), issue);
  }
  for (const pi of p.issues) {
    if (pi.state === 'live') push(pi.record, fromFile.get(pi.id));
  }
  return { value: { schema: ISSUES_SCHEMA, issues: out }, problems };
}

function overlaysFor(p: Pick<Projection, 'subRecords'>, rec: string, inFile: string) {
  return p.subRecords.filter((r) => r.ref.rec === rec && r.ref.in === inFile);
}

/** `change/<id>.json`: reviews of its items. Items come from producers and are never added. */
export function applyChangeSet(
  input: ChangeSetInput,
  p: Pick<Projection, 'subRecords'>,
): Applied<ChangeSet> {
  const set = ChangeSet.parse(input);
  const byId = new Map(overlaysFor(p, 'change-item', set.id).map((r) => [r.ref.id, r]));
  if (byId.size === 0) return { value: set, problems: [] };
  const items = set.items.map((item) => {
    const o = byId.get(item.id);
    if (!o) return item;
    const review = overlay(obj(item.review), o.set, o.unset);
    if (typeof review.status !== 'string') return item;
    return { ...item, review };
  });
  const r = ChangeSet.safeParse({ ...set, items });
  return r.success
    ? { value: r.data, problems: [] }
    : { value: set, problems: [`Change set ${set.id}: ${r.error.issues[0]?.message ?? ''}`] };
}

/** `detections/<name>`: per detection by id; a pass written whole takes its last writer. */
export function applyDetections(
  name: string,
  file: DetectionsFile,
  p: Pick<Projection, 'subRecords'>,
): Applied<DetectionsFile> {
  const pass = p.subRecords.find((r) => r.ref.rec === 'detection-pass' && r.ref.id === name);
  const base = pass ? overlay(obj(file), pass.set, pass.unset) : obj(file);
  const list = Array.isArray(base.detections) ? (base.detections as unknown[]) : [];
  const byId = new Map(overlaysFor(p, 'detection', name).map((r) => [r.ref.id, r]));
  const seen = new Set<string>();
  const detections: unknown[] = list.map((d) => {
    const det = obj(d);
    const id = typeof det.id === 'string' ? det.id : undefined;
    const o = id !== undefined ? byId.get(id) : undefined;
    if (id !== undefined) seen.add(id);
    return o ? overlay(det, o.set, o.unset) : d;
  });
  // detections drawn on another copy: added in the order they were made
  for (const o of byId.values()) {
    if (seen.has(o.ref.id) || o.set.bbox === undefined) continue;
    detections.push({ id: o.ref.id, ...o.set });
  }
  const r = DetectionsFile.safeParse({ ...base, detections });
  return r.success
    ? { value: r.data, problems: [] }
    : { value: file, problems: [`Detections ${name}: ${r.error.issues[0]?.message ?? ''}`] };
}

/** `models/<id>.procmodel.json`: per part field. Parts made on another copy are added. */
export function applyProcModel(
  model: ProcModel,
  p: Pick<Projection, 'subRecords'>,
): Applied<ProcModel> {
  const byId = new Map(overlaysFor(p, 'part', model.id).map((r) => [r.ref.id, r]));
  if (byId.size === 0) return { value: model, problems: [] };
  const seen = new Set<string>();
  const parts: unknown[] = model.parts.map((part) => {
    seen.add(part.id);
    const o = byId.get(part.id);
    return o ? overlay(obj(part), o.set, o.unset) : part;
  });
  for (const o of byId.values()) {
    if (!seen.has(o.ref.id) && typeof o.set.kind === 'string')
      parts.push({ id: o.ref.id, ...o.set });
  }
  const r = ProcModel.safeParse({ ...model, parts });
  return r.success
    ? { value: r.data, problems: [] }
    : { value: model, problems: [`Model ${model.id}: ${r.error.issues[0]?.message ?? ''}`] };
}

/** `edits/boundaries.json`: the last writer per pile and survey date. */
export function applyBoundaries(
  file: BoundaryEditsFile | null,
  p: Pick<Projection, 'boundaries'>,
): Applied<BoundaryEditsFile> {
  const base: BoundaryEditsFile = file ?? { schema: 'aio.boundaries/1', edits: [] };
  const merged = new Map(p.boundaries.map((b) => [b.key, b.record]));
  const seen = new Set<string>();
  const edits: unknown[] = base.edits.map((e) => {
    const key = `${e.pile}/${e.epoch}`;
    seen.add(key);
    return merged.get(key) ?? e;
  });
  for (const b of p.boundaries) if (!seen.has(b.key)) edits.push(b.record);
  const r = BoundaryEditsFile.safeParse({ ...base, edits });
  return r.success
    ? { value: r.data, problems: [] }
    : { value: base, problems: [`Boundaries: ${r.error.issues[0]?.message ?? ''}`] };
}

/** `report/narrative.json`: versions only grow (oldest first, the newest 50 kept per part). */
export function applyNarrative(
  file: NarrativeFile | null,
  p: Pick<Projection, 'narrative'>,
): Applied<NarrativeFile> {
  const base: NarrativeFile = file ?? { schema: 'aio.narrative/1', parts: {} };
  const parts: Record<string, { versions: unknown[] }> = {};
  for (const [part, value] of Object.entries(base.parts)) {
    parts[part] = { versions: [...value.versions] };
  }
  for (const n of p.narrative) {
    const list = (parts[n.part] ??= { versions: [] }).versions;
    const key = canonicalJson(n.version);
    if (!list.some((v) => canonicalJson(v) === key)) list.push(n.version);
  }
  for (const part of Object.values(parts)) {
    const at = (v: unknown) => {
      const c = obj(v).createdAt;
      return typeof c === 'string' ? c : '';
    };
    part.versions = part.versions
      .map((v, i) => ({ v, i }))
      .sort((a, b) => (at(a.v) < at(b.v) ? -1 : at(a.v) > at(b.v) ? 1 : a.i - b.i))
      .map((x) => x.v)
      .slice(-NARRATIVE_MAX_VERSIONS);
  }
  const r = NarrativeFile.safeParse({ ...base, parts });
  return r.success
    ? { value: r.data, problems: [] }
    : { value: base, problems: [`Report text: ${r.error.issues[0]?.message ?? ''}`] };
}

/** Project-relative files (forward slashes) whose content the projection decides. */
export function stateFiles(
  p: Pick<Projection, 'issues' | 'subRecords' | 'boundaries' | 'narrative'>,
): string[] {
  const files = new Set<string>();
  if (p.issues.length > 0) files.add('issues.json');
  for (const r of p.subRecords) {
    if (r.ref.rec === 'change-item' && r.ref.in) files.add(`${CHANGE_DIR}/${r.ref.in}.json`);
    if (r.ref.rec === 'detection' && r.ref.in) files.add(`${DETECTIONS_DIR}/${r.ref.in}`);
    if (r.ref.rec === 'detection-pass') files.add(`${DETECTIONS_DIR}/${r.ref.id}`);
    if (r.ref.rec === 'part' && r.ref.in) {
      files.add(`${PROCMODEL_DIR}/${r.ref.in}.procmodel.json`);
    }
  }
  if (p.boundaries.length > 0) files.add(BOUNDARIES_PATH);
  if (p.narrative.length > 0) files.add(NARRATIVE_PATH);
  return [...files].sort();
}

/** A state file the merge changed: write `text` through the journal service (atomic, `.bak`). */
export interface MergedFile {
  path: string;
  text: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function applyOne(
  path: string,
  json: unknown,
  p: Pick<Projection, 'issues' | 'subRecords' | 'boundaries' | 'narrative'>,
): Applied<unknown> | null {
  if (path === 'issues.json') return applyIssues(json, p);
  if (path === BOUNDARIES_PATH) {
    const r = json === null ? null : BoundaryEditsFile.safeParse(json);
    return r === null || r.success ? applyBoundaries(r?.data ?? null, p) : null;
  }
  if (path === NARRATIVE_PATH) {
    const r = json === null ? null : NarrativeFile.safeParse(json);
    return r === null || r.success ? applyNarrative(r?.data ?? null, p) : null;
  }
  if (json === null) return null;
  if (path.startsWith(`${CHANGE_DIR}/`)) {
    const r = ChangeSet.safeParse(json);
    return r.success ? applyChangeSet(r.data, p) : null;
  }
  if (path.startsWith(`${DETECTIONS_DIR}/`)) {
    const r = DetectionsFile.safeParse(json);
    return r.success ? applyDetections(path.slice(DETECTIONS_DIR.length + 1), r.data, p) : null;
  }
  if (path.startsWith(`${PROCMODEL_DIR}/`)) {
    const r = ProcModel.safeParse(json);
    return r.success ? applyProcModel(r.data, p) : null;
  }
  return null;
}

/**
 * Every state file the projection decides, merged: reads each through `read` (project-relative,
 * null when absent) and returns those whose text changes. Files that are missing or no longer
 * parse are reported in `problems` and left alone (a change set, pass or model is never made from
 * ops alone).
 */
export async function mergeStateFiles(
  p: Pick<Projection, 'issues' | 'subRecords' | 'boundaries' | 'narrative'>,
  read: (path: string) => Promise<string | null>,
): Promise<{ files: MergedFile[]; problems: string[] }> {
  const files: MergedFile[] = [];
  const problems: string[] = [];
  for (const path of stateFiles(p)) {
    const before = await read(path);
    const json = before === null ? null : parseJson(before);
    const out = json === undefined ? null : applyOne(path, json, p);
    if (!out) {
      problems.push(
        json === null
          ? `${path} is not in this project, so the merged changes to it wait until it is.`
          : `${path} is not valid, so the merged changes were not written to it.`,
      );
      continue;
    }
    problems.push(...out.problems);
    const text = stateFileText(out.value);
    if (text !== before) files.push({ path, text });
  }
  return { files, problems };
}
