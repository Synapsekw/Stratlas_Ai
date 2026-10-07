import type { EditCommand, OpKind, RecordRef } from '@aio/schema';
import { canonicalJson } from './canonical';
import { contentHash } from './hash';

/**
 * Turning a write into ops (M9 T1). Main knows the record files before and after each write (the
 * last snapshot and the request, or what a pipeline or another program left on disk) and diffs
 * them into field-level ops that the merge engine (T4) can project and History can show.
 *
 * Patch payloads carry `was` (the values before) next to `set` and `unset`, so History shows
 * before and after without replaying, and Restore knows what to put back.
 */

/** An op before it is sealed into a chain. */
export interface DraftOp {
  kind: OpKind;
  target: RecordRef;
  payload: Record<string, unknown>;
  /** Content hash of the target record before the op. */
  base?: string;
  label?: string;
}

export interface FieldPatch {
  set?: Record<string, unknown>;
  unset?: string[];
  was?: Record<string, unknown>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Top-level field differences of two records (`was` holds every changed field's old value). */
export function diffFields(before: Obj | null, after: Obj | null, skip: string[] = []): FieldPatch {
  const set: Obj = {};
  const unset: string[] = [];
  const was: Obj = {};
  const b = before ?? {};
  const a = after ?? {};
  for (const k of Object.keys(a)) {
    if (skip.includes(k) || a[k] === undefined) continue;
    if (b[k] === undefined || !same(a[k], b[k])) {
      set[k] = a[k];
      if (b[k] !== undefined) was[k] = b[k];
    }
  }
  for (const k of Object.keys(b)) {
    if (skip.includes(k) || b[k] === undefined) continue;
    if (a[k] === undefined) {
      unset.push(k);
      was[k] = b[k];
    }
  }
  const out: FieldPatch = {};
  if (Object.keys(set).length) out.set = set;
  if (unset.length) out.unset = unset.sort();
  if (Object.keys(was).length) out.was = was;
  return out;
}

const empty = (p: FieldPatch) => !p.set && !p.unset;

/** Label of the last editor command that names `id`. */
function labelFor(id: string, commands: readonly EditCommand[] | undefined): string | undefined {
  if (!commands) return undefined;
  for (let i = commands.length - 1; i >= 0; i--) {
    const c = commands[i];
    if (c?.ids.includes(id)) return c.label;
  }
  return undefined;
}

// ---------------------------------------------------------------- issues

/** The content hash of a sighting (sightings have no id). */
export const sightingHash = (s: unknown) => contentHash(s);

/** Ops for one issues.json write: create, delete, status, sightings and field patches. */
export function diffIssues(
  before: readonly Obj[],
  after: readonly Obj[],
  commands?: readonly EditCommand[],
): DraftOp[] {
  const ops: DraftOp[] = [];
  const old = new Map(before.map((i) => [String(i.id), i]));
  const now = new Set(after.map((i) => String(i.id)));
  for (const issue of after) {
    const id = String(issue.id);
    const target = { rec: 'issue', id };
    const label = labelFor(id, commands);
    const lab = label ? { label } : {};
    const prev = old.get(id);
    if (!prev) {
      ops.push({ kind: 'issue.create', target, payload: { record: issue }, ...lab });
      continue;
    }
    if (same(prev, issue)) continue;
    const base = contentHash(prev);
    // sightings by content: removed first, then added (a replace is a remove plus an add)
    const prevS = Array.isArray(prev.sightings) ? prev.sightings : [];
    const nextS = Array.isArray(issue.sightings) ? issue.sightings : [];
    const prevH = prevS.map(sightingHash);
    const nextH = nextS.map(sightingHash);
    prevS.forEach((s, k) => {
      const hash = prevH[k] ?? '';
      if (!nextH.includes(hash)) {
        ops.push({
          kind: 'issue.sighting.remove',
          target,
          base,
          payload: { hash, sighting: s },
          ...lab,
        });
      }
    });
    nextS.forEach((s, k) => {
      const hash = nextH[k] ?? '';
      if (!prevH.includes(hash)) {
        ops.push({
          kind: 'issue.sighting.add',
          target,
          base,
          payload: { hash, sighting: s },
          ...lab,
        });
      }
    });
    if (prev.status !== issue.status) {
      ops.push({
        kind: 'issue.status',
        target,
        base,
        payload: { from: String(prev.status), to: String(issue.status) },
        ...lab,
      });
    }
    const patch = diffFields(prev, issue, ['sightings', 'status']);
    if (!empty(patch))
      ops.push({ kind: 'issue.patch', target, base, payload: { ...patch }, ...lab });
  }
  for (const prev of before) {
    const id = String(prev.id);
    if (now.has(id)) continue;
    const label = labelFor(id, commands);
    ops.push({
      kind: 'issue.delete',
      target: { rec: 'issue', id },
      base: contentHash(prev),
      payload: {},
      ...(label ? { label } : {}),
    });
  }
  return ops;
}

// ---------------------------------------------------------------- other record files

interface Unit {
  target: RecordRef;
  value: Obj;
}

/** A record file split into units (one per change item, detection, part, layer, ...). */
interface FileKind {
  kind: OpKind;
  /** `record` payloads (`{ record }`) instead of field patches. */
  record?: boolean;
  units(rel: string, json: Obj): Unit[];
}

const listUnits = (
  json: Obj,
  list: string,
  key: (item: Obj) => string | undefined,
  target: (id: string) => RecordRef,
  rest: RecordRef,
): Unit[] | null => {
  const items = Array.isArray(json[list]) ? (json[list] as unknown[]) : [];
  const out: Unit[] = [];
  for (const item of items) {
    if (!isObj(item)) return null;
    const id = key(item);
    if (id === undefined) return null;
    out.push({ target: target(id), value: item });
  }
  const others = Object.fromEntries(Object.entries(json).filter(([k]) => k !== list));
  out.push({ target: rest, value: others });
  return out;
};

const base = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);

const FILES: { match: RegExp; kind: FileKind }[] = [
  {
    match: /^change\/[^/]+\.json$/,
    kind: {
      kind: 'change.review',
      units: (rel, json) => {
        const set = typeof json.id === 'string' ? json.id : base(rel).replace(/\.json$/, '');
        return (
          listUnits(
            json,
            'items',
            (i) => (typeof i.id === 'string' ? i.id : undefined),
            (id) => ({ rec: 'change-item', id, in: set }),
            { rec: 'change-set', id: set },
          ) ?? [{ target: { rec: 'change-set', id: set }, value: json }]
        );
      },
    },
  },
  {
    match: /^detections\/[^/]+\.json$/,
    kind: {
      kind: 'detection.review',
      units: (rel, json) => {
        const pass = base(rel);
        // detections without ids: the whole pass is one record (known limit)
        return (
          listUnits(
            json,
            'detections',
            (d) => (typeof d.id === 'string' ? d.id : undefined),
            (id) => ({ rec: 'detection', id, in: pass }),
            { rec: 'detection-pass', id: pass },
          ) ?? [{ target: { rec: 'detection-pass', id: pass }, value: json }]
        );
      },
    },
  },
  {
    match: /^models\/[^/]+\.procmodel\.json$/,
    kind: {
      kind: 'procmodel.part',
      units: (rel, json) => {
        const model =
          typeof json.id === 'string' ? json.id : base(rel).replace(/\.procmodel\.json$/, '');
        return (
          listUnits(
            json,
            'parts',
            (p) => (typeof p.id === 'string' ? p.id : undefined),
            (id) => ({ rec: 'part', id, in: model }),
            { rec: 'model', id: model },
          ) ?? [{ target: { rec: 'model', id: model }, value: json }]
        );
      },
    },
  },
  {
    match: /^edits\/boundaries\.json$/,
    kind: {
      kind: 'boundary.edit',
      record: true,
      units: (_rel, json) =>
        listUnits(
          json,
          'edits',
          (e) =>
            typeof e.pile === 'string' && typeof e.epoch === 'string'
              ? `${e.pile}/${e.epoch}`
              : undefined,
          (id) => ({ rec: 'boundary', id }),
          { rec: 'boundary', id: 'file' },
        ) ?? [{ target: { rec: 'boundary', id: 'file' }, value: json }],
    },
  },
  {
    match: /^report\/narrative\.json$/,
    kind: {
      kind: 'narrative.version',
      record: true,
      units: (_rel, json) => {
        const parts = isObj(json.parts) ? json.parts : {};
        return Object.entries(parts)
          .filter((e): e is [string, Obj] => isObj(e[1]))
          .map(([id, part]) => ({ target: { rec: 'narrative', id }, value: part }));
      },
    },
  },
  {
    match: /^manifest\.json$/,
    kind: {
      kind: 'manifest.entry',
      units: (_rel, json) =>
        listUnits(
          json,
          'layers',
          (l) => (typeof l.id === 'string' ? l.id : undefined),
          (id) => ({ rec: 'manifest', id, in: 'layers' }),
          { rec: 'manifest', id: 'project' },
        ) ?? [{ target: { rec: 'manifest', id: 'project' }, value: json }],
    },
  },
];

/** The record files the journal follows (project-relative, forward slashes). */
export function isJournaledFile(rel: string): boolean {
  return rel === 'issues.json' || FILES.some((f) => f.match.test(rel));
}

/** Folders that hold journaled record files, for scanning a project. */
export const JOURNALED_DIRS = ['change', 'detections', 'models', 'edits', 'report'] as const;

const key = (t: RecordRef) => `${t.rec}\u0000${t.id}\u0000${t.in ?? ''}`;

/**
 * The ops for one record file going from `before` to `after` (either may be null: the file was
 * added or removed). A file that is not a known shape becomes one `record.external` op.
 */
export function diffRecordFile(
  rel: string,
  before: unknown,
  after: unknown,
  commands?: readonly EditCommand[],
): DraftOp[] {
  if (before !== null && after !== null && same(before, after)) return [];
  if (rel === 'issues.json') {
    const list = (v: unknown) =>
      isObj(v) && Array.isArray(v.issues) ? v.issues.filter(isObj) : null;
    const b = before === null ? [] : list(before);
    const a = after === null ? [] : list(after);
    if (b && a) return diffIssues(b, a, commands);
  }
  const spec = FILES.find((f) => f.match.test(rel))?.kind;
  const okShape = (v: unknown) => v === null || isObj(v);
  if (!spec || !okShape(before) || !okShape(after)) return [externalOp(rel, before, after)];
  const bu = before === null ? [] : spec.units(rel, before);
  const au = after === null ? [] : spec.units(rel, after);
  const old = new Map(bu.map((u) => [key(u.target), u]));
  const ops: DraftOp[] = [];
  const seen = new Set<string>();
  for (const u of au) {
    const k = key(u.target);
    seen.add(k);
    const prev = old.get(k);
    if (prev && same(prev.value, u.value)) continue;
    const label = labelFor(u.target.id, commands);
    ops.push(unitOp(spec, u.target, prev?.value ?? null, u.value, label));
  }
  for (const u of bu) {
    if (seen.has(key(u.target))) continue;
    ops.push(unitOp(spec, u.target, u.value, null, labelFor(u.target.id, commands)));
  }
  return ops;
}

function unitOp(
  spec: FileKind,
  target: RecordRef,
  before: Obj | null,
  after: Obj | null,
  label: string | undefined,
): DraftOp {
  const b = before ? { base: contentHash(before) } : {};
  const lab = label ? { label } : {};
  if (spec.record) {
    const record = after ?? { removed: true };
    return {
      kind: spec.kind,
      target,
      ...b,
      payload: { record, ...(before ? { was: before } : {}) },
      ...lab,
    };
  }
  return { kind: spec.kind, target, ...b, payload: { ...diffFields(before, after) }, ...lab };
}

/** A difference the journal cannot split into records: file hashes before and after. */
export function externalOp(rel: string, before: unknown, after: unknown): DraftOp {
  return {
    kind: 'record.external',
    target: { rec: 'file', id: rel },
    payload: {
      file: rel,
      before: before === null ? null : contentHash(before),
      after: after === null ? null : contentHash(after),
    },
  };
}
