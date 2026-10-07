import { contentHash } from '@aio/journal';
import { Issue } from '@aio/schema';
import type { OpIndex, OpNode } from '../causal';
import { sideOf, type ConflictSeed } from '../conflicts';
import { FieldLog, writeOf, type FieldWrite } from '../registers';
import { FIELD_GROUPS } from '../rules';

/** Issue fields that follow the last writer without ever raising a conflict. */
export const QUIET_ISSUE_FIELDS = ['updatedAt'] as const;
/** Optional issue fields a restore clears when its record has none. */
const OPTIONAL_FIELDS = ['measurements', 'capture', 'track', 'resolvedIn'] as const;
/** The key order today's writer gives an issue (the zod shape), sightings in place. */
const ISSUE_KEYS = Object.keys(Issue.shape);

interface Tag {
  hash: string;
  value: unknown;
  node: OpNode;
  index: number;
}

interface IssueState {
  id: string;
  fields: FieldLog;
  /** `issue.create` and `issue.restore` ops. */
  records: OpNode[];
  /** Every op but deletes and merges. */
  edits: OpNode[];
  deletes: { node: OpNode; into?: string }[];
  tags: Tag[];
  removes: { hash: string; node: OpNode }[];
  /** Ops that replaced the whole set (a restore, or a patch of `sightings`). */
  clears: OpNode[];
  /** The code of the first record op (the code the person saw when making it). */
  createdCode?: string;
}

/** An issue as the journal knows it. */
export interface ProjectedIssue {
  id: string;
  /**
   * `live`: made by an op and not deleted (`record` is the whole issue); `deleted`; `partial`: no
   * op made it (it predates the journal), so `record` and `unset` overlay the file's issue.
   */
  state: 'live' | 'deleted' | 'partial';
  record: Record<string, unknown>;
  unset: string[];
  /** Total-order position of the op that made it (sorts the file). */
  order: number;
}

export interface Recode {
  issue: string;
  from: string;
  to: string;
  /** Package files exported after the old code was in use (their codes are out of date). */
  delivered: string[];
}

export interface IssueProjection {
  issues: ProjectedIssue[];
  conflicts: ConflictSeed[];
  /** Codes renumbered here because two issues made apart had the same code. */
  recodes: Recode[];
  history(id: string, field?: string): FieldWrite[];
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const ISSUE_KINDS = new Set([
  'issue.create',
  'issue.patch',
  'issue.delete',
  'issue.restore',
  'issue.sighting.add',
  'issue.sighting.remove',
  'issue.status',
  'issue.merge',
  'issue.recode',
]);

/** Ops of the issue rule: the `issue.*` kinds, and external changes found in an issue. */
export function isIssueOp(node: OpNode): boolean {
  if (ISSUE_KINDS.has(node.op.kind)) return true;
  return node.op.kind === 'record.external' && node.op.target.rec === 'issue';
}

/** Next free code for a prefix: one more than the highest in use (F09 and F09 make F10). */
export function nextFreeCode(used: ReadonlySet<string>, prefix: string): string {
  let max = 0;
  for (const code of used) {
    if (!code.startsWith(prefix)) continue;
    const n = Number(code.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

const prefixOf = (code: string) => /^[A-Z]{1,3}/.exec(code)?.[0] ?? 'F';
const numberOf = (code: string) => Number(code.slice(prefixOf(code).length)) || 0;

/**
 * Project issues (decision 7): fields by last writer per field (class with its severity model),
 * sightings as an add-wins set keyed by content hash (a remove takes only the adds it had seen),
 * deletes and merges that lose to a concurrent edit (the issue stays, and the inbox says so),
 * merges that carry sightings added concurrently to the source into the target, and colliding
 * codes renumbered by clock order.
 */
export function projectIssues(
  applied: readonly OpNode[],
  index: OpIndex,
  exports: readonly OpNode[] = [],
): IssueProjection {
  const states = new Map<string, IssueState>();
  const stateOf = (id: string): IssueState => {
    let s = states.get(id);
    if (!s) {
      s = {
        id,
        fields: new FieldLog(FIELD_GROUPS, QUIET_ISSUE_FIELDS),
        records: [],
        edits: [],
        deletes: [],
        tags: [],
        removes: [],
        clears: [],
      };
      states.set(id, s);
    }
    return s;
  };
  const addSightings = (s: IssueState, node: OpNode, list: unknown) => {
    if (!Array.isArray(list)) return;
    list.forEach((value, i) => {
      s.tags.push({ hash: contentHash(value), value, node, index: i });
    });
  };
  const patch = (s: IssueState, node: OpNode, p: Record<string, unknown>) => {
    const set = { ...obj(p.set) };
    delete set.id;
    if ('sightings' in set) {
      s.clears.push(node);
      addSightings(s, node, set.sightings);
      delete set.sightings;
    }
    const unset = Array.isArray(p.unset)
      ? p.unset.filter((f): f is string => typeof f === 'string' && f !== 'id' && f !== 'sightings')
      : [];
    s.fields.write(node, set, unset);
  };

  for (const node of applied) {
    if (!isIssueOp(node)) continue;
    const s = stateOf(node.op.target.id);
    const p = obj(node.op.payload);
    const hasPayload = node.op.payload !== undefined;
    if (node.op.kind === 'issue.delete' || node.op.kind === 'issue.merge') {
      const into = typeof p.into === 'string' ? p.into : undefined;
      s.deletes.push({ node, ...(into !== undefined ? { into } : {}) });
      continue;
    }
    s.edits.push(node);
    if (!hasPayload) continue; // redacted: the value is gone from every copy
    switch (node.op.kind) {
      case 'issue.create':
      case 'issue.restore': {
        const record = { ...obj(p.record) };
        const restore = node.op.kind === 'issue.restore' || s.records.length > 0;
        if (s.createdCode === undefined && typeof record.code === 'string') {
          s.createdCode = record.code;
        }
        s.records.push(node);
        if (restore) s.clears.push(node);
        addSightings(s, node, record.sightings);
        delete record.sightings;
        delete record.id;
        const unset = restore ? OPTIONAL_FIELDS.filter((f) => !(f in record)) : [];
        s.fields.write(node, record, unset);
        break;
      }
      case 'issue.patch':
        patch(s, node, p);
        break;
      case 'record.external':
        if (p.patch !== undefined) patch(s, node, obj(p.patch));
        break;
      case 'issue.status':
        if (typeof p.to === 'string') s.fields.write(node, { status: p.to });
        break;
      case 'issue.recode':
        if (typeof p.to === 'string') s.fields.write(node, { code: p.to });
        break;
      case 'issue.sighting.add':
        if (typeof p.hash === 'string' && p.sighting !== undefined) {
          s.tags.push({ hash: p.hash, value: p.sighting, node, index: 0 });
        }
        break;
      case 'issue.sighting.remove':
        if (typeof p.hash === 'string') s.removes.push({ hash: p.hash, node });
        break;
      default:
        break;
    }
  }

  const conflicts: ConflictSeed[] = [];
  const target = (id: string) => ({ rec: 'issue', id });

  // deleted when one delete (or merge) had seen every edit; a merge ignores sightings added meanwhile
  const deadBy = new Map<string, { node: OpNode; into?: string }>();
  for (const s of states.values()) {
    let dominating: { node: OpNode; into?: string } | undefined;
    for (const d of s.deletes) {
      const relevant =
        d.into !== undefined ? s.edits.filter((e) => e.op.kind !== 'issue.sighting.add') : s.edits;
      if (relevant.every((e) => index.before(e, d.node))) {
        if (!dominating || d.node.order > dominating.node.order) dominating = d;
      }
    }
    if (dominating) {
      deadBy.set(s.id, dominating);
      continue;
    }
    if (s.deletes.length === 0) continue;
    // kept because of a concurrent edit: the inbox offers "Delete again" (or "Merge again")
    const d = s.deletes[s.deletes.length - 1];
    if (!d) continue;
    const edit = [...s.edits].reverse().find((e) => index.concurrent(e, d.node));
    if (!edit) continue;
    conflicts.push({
      target: target(s.id),
      field: 'deleted',
      kind: d.into !== undefined ? 'merge' : 'delete-edit',
      winner: { ...sideOf(writeOf(edit, false)), value: false },
      loser: {
        ...sideOf(writeOf(d.node, true)),
        value: d.into !== undefined ? { into: d.into } : true,
      },
    });
  }

  // a merge carries the source's sightings (those added meanwhile too) into the target
  const finalTarget = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    for (;;) {
      const into = deadBy.get(at)?.into;
      if (into === undefined || seen.has(into) || !states.has(into)) return at;
      seen.add(at);
      at = into;
    }
  };
  for (const [id, d] of [...deadBy].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (d.into === undefined) continue;
    const to = finalTarget(id);
    if (to === id) continue;
    const src = states.get(id);
    const dst = states.get(to);
    if (!src || !dst) continue;
    dst.tags.push(...src.tags);
    dst.removes.push(...src.removes);
  }

  const sightingsOf = (s: IssueState): unknown[] | undefined => {
    if (s.tags.length === 0) return undefined;
    const alive = s.tags.filter(
      (t) =>
        !s.removes.some((r) => r.hash === t.hash && index.before(t.node, r.node)) &&
        !s.clears.some((c) => index.before(t.node, c)),
    );
    const byOrder = (a: Tag, b: Tag) => a.node.order - b.node.order || a.index - b.index;
    // never leave an issue without a sighting (the schema needs one): keep the newest
    const kept = alive.length > 0 ? alive.sort(byOrder) : [...s.tags].sort(byOrder).slice(-1);
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const t of kept) {
      if (seen.has(t.hash)) continue;
      seen.add(t.hash);
      out.push(t.value);
    }
    return out;
  };

  const issues: ProjectedIssue[] = [];
  for (const s of states.values()) {
    const { set, unset } = s.fields.overlay();
    const sightings = sightingsOf(s);
    if (sightings) set.sightings = sightings;
    if (s.records.length === 0) {
      issues.push({
        id: s.id,
        state: deadBy.has(s.id) ? 'deleted' : 'partial',
        record: set,
        unset,
        order: Number.MAX_SAFE_INTEGER,
      });
      continue;
    }
    const record: Record<string, unknown> = { id: s.id };
    for (const k of ISSUE_KEYS) if (k in set) record[k] = set[k];
    for (const k of Object.keys(set).sort()) if (!(k in record)) record[k] = set[k];
    issues.push({
      id: s.id,
      state: deadBy.has(s.id) ? 'deleted' : 'live',
      record,
      unset: [],
      order: s.records[0]?.order ?? 0,
    });
  }
  issues.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // field conflicts on live issues
  for (const p of issues) {
    if (p.state === 'deleted') continue;
    const s = states.get(p.id);
    if (!s) continue;
    for (const c of s.fields.conflicts(index)) {
      conflicts.push({
        target: target(p.id),
        field: c.field,
        kind: c.field === 'status' ? 'status' : 'value',
        winner: sideOf(c.winner),
        loser: sideOf(c.loser),
      });
    }
  }

  // colliding codes: the issue made later (by clock) takes the next free code
  const live = issues.filter((p) => p.state === 'live' && typeof p.record.code === 'string');
  const used = new Set(live.map((p) => p.record.code as string));
  const byCode = new Map<string, ProjectedIssue[]>();
  for (const p of live) {
    const code = p.record.code as string;
    byCode.set(code, [...(byCode.get(code) ?? []), p]);
  }
  const recodes: Recode[] = [];
  const codes = [...byCode.keys()].sort((a, b) =>
    prefixOf(a) < prefixOf(b) ? -1 : prefixOf(a) > prefixOf(b) ? 1 : numberOf(a) - numberOf(b),
  );
  for (const code of codes) {
    const group = byCode.get(code) ?? [];
    for (const p of group.slice(1)) {
      const to = nextFreeCode(used, prefixOf(code));
      used.add(to);
      p.record.code = to;
      const made = states.get(p.id)?.records[0];
      const delivered = made
        ? exports
            .filter((e) => index.before(made, e) && typeof obj(e.op.payload).file === 'string')
            .map((e) => obj(e.op.payload).file as string)
        : [];
      recodes.push({ issue: p.id, from: code, to, delivered });
    }
  }

  // a code changed because two issues made apart had the same one: listed until dismissed
  const made = new Map<string, ProjectedIssue[]>();
  for (const p of live) {
    const code = states.get(p.id)?.createdCode;
    if (code !== undefined) made.set(code, [...(made.get(code) ?? []), p]);
  }
  for (const [code, group] of made) {
    for (let i = 1; i < group.length; i += 1) {
      const later = group[i];
      const earlier = group.find((g, j) => {
        if (j >= i) return false;
        const a = states.get(g.id)?.records[0];
        const b = later ? states.get(later.id)?.records[0] : undefined;
        return a !== undefined && b !== undefined && index.concurrent(a, b);
      });
      if (!later || !earlier || later.record.code === code) continue;
      const lNode = states.get(later.id)?.records[0];
      const eNode = states.get(earlier.id)?.records[0];
      if (!lNode || !eNode) continue;
      conflicts.push({
        target: target(later.id),
        field: 'code',
        kind: 'code',
        winner: { value: later.record.code, by: eNode.op.act, hlc: eNode.op.hlc, op: eNode.op.id },
        loser: { value: code, by: lNode.op.act, hlc: lNode.op.hlc, op: lNode.op.id },
      });
    }
  }

  return {
    issues,
    conflicts,
    recodes,
    history: (id, field) => states.get(id)?.fields.history(field) ?? [],
  };
}
