import { canonicalJson, contentHash } from '@aio/journal';
import type { Conflict, QuarantineEntry, RecordRef } from '@aio/schema';
import { RELEASE_PREFIX } from './quarantine';
import type { Write } from './registers';

/** One side of a conflict, before it is told apart as ours or theirs. */
export interface Side {
  value: unknown;
  by: string;
  hlc: string;
  op: string;
}

/** A conflict as the engine finds it: the value in the state files now (winner) and the other. */
export interface ConflictSeed {
  target: RecordRef;
  field: string;
  kind: Conflict['kind'];
  winner: Side;
  loser: Side;
}

export function sideOf(w: Write): Side {
  return {
    value: w.absent ? null : w.value,
    by: w.node.op.act,
    hlc: w.node.op.hlc,
    op: w.node.op.id,
  };
}

/** A stable id: the same two writes give the same id on every copy. */
export function conflictId(seed: ConflictSeed): string {
  const ops = [seed.winner.op, seed.loser.op].sort();
  const t = seed.target;
  return `cf_${contentHash([t.rec, t.in ?? '', t.id, seed.field, seed.kind, ops]).slice(0, 40)}`;
}

/**
 * The conflict as one person sees it: `ours` is the side they wrote (when they wrote one of the
 * two), otherwise the value in the state files now. A renumbered code keeps the old code as `ours`.
 */
export function toConflict(seed: ConflictSeed, viewer?: string): Conflict {
  const mine =
    seed.kind === 'code' ||
    (viewer !== undefined && seed.loser.by === viewer && seed.winner.by !== viewer);
  const [ours, theirs] = mine ? [seed.loser, seed.winner] : [seed.winner, seed.loser];
  return {
    id: conflictId(seed),
    target: seed.target,
    field: seed.field,
    ours,
    theirs,
    kind: seed.kind,
    current: mine ? 'theirs' : 'ours',
  };
}

/** An op for main to seal and append (through the journal service). */
export interface OpDraft {
  kind: string;
  target: RecordRef;
  payload: Record<string, unknown>;
  label?: string;
}

const PATCH_KIND: Record<string, string> = {
  issue: 'issue.patch',
  'change-item': 'change.review',
  detection: 'detection.review',
  'detection-pass': 'detection.review',
  part: 'procmodel.part',
  manifest: 'manifest.entry',
};

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The ops that write `value` into a field (Keep, Take theirs, Edit or Restore). */
export function writeDrafts(
  target: RecordRef,
  field: string,
  value: unknown,
  current?: unknown,
): OpDraft[] {
  if (field === 'assignee') {
    return [
      {
        kind: 'assign.set',
        target,
        payload: {
          target: { kind: target.rec, id: target.id, ...(target.in ? { in: target.in } : {}) },
          assignee: value ?? null,
        },
      },
    ];
  }
  if (target.rec === 'boundary') {
    return [{ kind: 'boundary.edit', target, payload: { record: value } }];
  }
  if (target.rec === 'issue' && field === 'status' && typeof value === 'string') {
    return [
      {
        kind: 'issue.status',
        target,
        payload: { from: typeof current === 'string' ? current : value, to: value },
      },
    ];
  }
  const kind = PATCH_KIND[target.rec];
  if (!kind) return [];
  // a group (class with its severity model) is written whole
  const group = field === 'classId' || (target.rec === 'change-item' && field === 'status');
  const values = group && obj(value) ? (obj(value) ?? {}) : { [field]: value };
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [f, v] of Object.entries(values)) {
    if (v === null || v === undefined) unset.push(f);
    else set[f] = v;
  }
  return [
    {
      kind,
      target,
      payload: {
        ...(Object.keys(set).length > 0 ? { set } : {}),
        ...(unset.length > 0 ? { unset } : {}),
      },
    },
  ];
}

/**
 * The ops that resolve a conflict: a `conflict.resolve` op recording the choice, then, when the
 * chosen value is not the one in the state files, the write that puts it there. `value` is the
 * edited value (Edit) or a value from history (Restore).
 */
export function resolveDrafts(
  conflict: Conflict,
  choice: 'ours' | 'theirs' | 'restore',
  value?: unknown,
): OpDraft[] {
  const chosen =
    choice === 'ours' ? conflict.ours.value : choice === 'theirs' ? conflict.theirs.value : value;
  const current = conflict[conflict.current].value;
  const record: OpDraft = {
    kind: 'conflict.resolve',
    target: conflict.target,
    payload: {
      conflict: conflict.id,
      choice,
      ...(choice === 'restore' || value !== undefined ? { value: chosen ?? null } : {}),
    },
  };
  if (conflict.kind === 'code') return [record];
  if (conflict.kind === 'delete-edit') {
    return chosen === true && current !== true
      ? [record, { kind: 'issue.delete', target: conflict.target, payload: {} }]
      : [record];
  }
  if (conflict.kind === 'merge') {
    const into = obj(chosen)?.into;
    return typeof into === 'string' && obj(current)?.into === undefined
      ? [record, { kind: 'issue.merge', target: conflict.target, payload: { into } }]
      : [record];
  }
  if (canonicalJson(chosen ?? null) === canonicalJson(current ?? null)) return [record];
  return [record, ...writeDrafts(conflict.target, conflict.field, chosen, current)];
}

/** The op an owner writes to apply a quarantined op anyway. */
export function releaseDraft(entry: Pick<QuarantineEntry, 'op' | 'target'>): OpDraft {
  return {
    kind: 'conflict.resolve',
    target: entry.target,
    payload: { conflict: `${RELEASE_PREFIX}${entry.op}`, choice: 'theirs' },
  };
}
