import { canonicalJson } from '@aio/journal';
import type { RecordRef } from '@aio/schema';
import type { OpIndex, OpNode } from '../causal';
import { sideOf, type ConflictSeed } from '../conflicts';
import { FieldLog, writeOf, concurrentLosers, type FieldWrite, type Write } from '../registers';
import { OWNER_ONLY_MANIFEST_FIELDS } from '../rules';

/**
 * Records inside other files, merged per field by last writer: change items (`change.review`),
 * detections and whole detection passes (`detection.review`), model parts (`procmodel.part`) and
 * manifest entries (`manifest.entry`). Boundary edits are last writer per pile and survey date;
 * narrative versions only grow.
 */

const KIND_REC: Record<string, readonly string[]> = {
  'change.review': ['change-item'],
  'detection.review': ['detection', 'detection-pass'],
  'procmodel.part': ['part'],
  'manifest.entry': ['manifest'],
};

/** Fields checked together, per record kind (the first names the conflict). */
const GROUPS: Record<string, readonly (readonly string[])[]> = {
  'change-item': [['status', 'by', 'at']],
  detection: [['geom', 'bbox', 'space', 'width', 'height']],
};
/** Fields that follow the last writer and never raise a conflict. */
const QUIET: Record<string, readonly string[]> = {
  detection: ['reviewedBy', 'reviewedAt', 'updatedAt'],
  part: ['updatedAt'],
};
/** Fields whose conflicts are status conflicts (confirm against dismiss, accept against reject). */
const STATUS_FIELDS = new Set(['status']);

export interface SubRecord {
  ref: RecordRef;
  /** Winners as an overlay on the record in its file. */
  set: Record<string, unknown>;
  unset: string[];
  /** Total-order position of the first op (orders records the file did not have). */
  order: number;
}

export interface NarrativeVersionEntry {
  part: string;
  version: Record<string, unknown>;
  order: number;
}

export interface RecordsProjection {
  records: SubRecord[];
  boundaries: { key: string; record: Record<string, unknown>; order: number }[];
  narrative: NarrativeVersionEntry[];
  conflicts: ConflictSeed[];
  history(ref: RecordRef, field?: string): FieldWrite[];
}

export const refKey = (r: RecordRef): string => `${r.rec}:${r.in ?? ''}:${r.id}`;

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function isRecordsOp(node: OpNode): boolean {
  const { kind, target } = node.op;
  if (kind in KIND_REC) return KIND_REC[kind]?.includes(target.rec) ?? false;
  if (kind === 'record.external') {
    return Object.values(KIND_REC).some((recs) => recs.includes(target.rec));
  }
  return kind === 'boundary.edit' || kind === 'narrative.version';
}

export function projectRecords(applied: readonly OpNode[], index: OpIndex): RecordsProjection {
  const logs = new Map<string, { ref: RecordRef; log: FieldLog; order: number }>();
  const boundaryWrites = new Map<string, Write[]>();
  const narrative = new Map<string, NarrativeVersionEntry>();

  for (const node of applied) {
    if (!isRecordsOp(node) || node.op.payload === undefined) continue;
    const { kind, target } = node.op;
    const p = obj(node.op.payload);
    if (kind === 'boundary.edit') {
      const record = obj(p.record);
      const key =
        typeof record.pile === 'string' && typeof record.epoch === 'string'
          ? `${record.pile}/${record.epoch}`
          : target.id;
      const list = boundaryWrites.get(key) ?? [];
      list.push(writeOf(node, record));
      boundaryWrites.set(key, list);
      continue;
    }
    if (kind === 'narrative.version') {
      const record = obj(p.record);
      const part = typeof record.part === 'string' ? record.part : target.id;
      const version = { ...obj(record.version ?? record) };
      delete version.part;
      const key = `${part}\u0000${canonicalJson(version)}`;
      if (!narrative.has(key)) narrative.set(key, { part, version, order: node.order });
      continue;
    }
    const patch = kind === 'record.external' ? obj(p.patch) : p;
    const set = { ...obj(patch.set) };
    // a change review may come whole (`review: {...}`) or by field
    if (target.rec === 'change-item' && 'review' in set) {
      Object.assign(set, obj(set.review));
      delete set.review;
    }
    delete set.id;
    const unset = Array.isArray(patch.unset)
      ? patch.unset.filter((f): f is string => typeof f === 'string' && f !== 'id')
      : [];
    const key = refKey(target);
    let entry = logs.get(key);
    if (!entry) {
      entry = {
        ref: { rec: target.rec, id: target.id, ...(target.in ? { in: target.in } : {}) },
        log: new FieldLog(GROUPS[target.rec] ?? [], QUIET[target.rec] ?? []),
        order: node.order,
      };
      logs.set(key, entry);
    }
    entry.log.write(node, set, unset);
  }

  const conflicts: ConflictSeed[] = [];
  const records: SubRecord[] = [];
  for (const { ref, log, order } of logs.values()) {
    const { set, unset } = log.overlay();
    records.push({ ref, set, unset, order });
    for (const c of log.conflicts(index)) {
      const owner =
        ref.rec === 'manifest' &&
        (OWNER_ONLY_MANIFEST_FIELDS as readonly string[]).includes(c.field);
      conflicts.push({
        target: ref,
        field: c.field,
        kind: STATUS_FIELDS.has(c.field) && !owner ? 'status' : 'value',
        winner: sideOf(c.winner),
        loser: sideOf(c.loser),
      });
    }
  }
  records.sort((a, b) => a.order - b.order);

  const boundaries: RecordsProjection['boundaries'] = [];
  for (const [key, list] of boundaryWrites) {
    const winner = list[list.length - 1];
    if (!winner) continue;
    boundaries.push({ key, record: obj(winner.value), order: list[0]?.node.order ?? 0 });
    for (const c of concurrentLosers('edit', list, index)) {
      conflicts.push({
        target: { rec: 'boundary', id: key },
        field: 'edit',
        kind: 'value',
        winner: sideOf(c.winner),
        loser: sideOf(c.loser),
      });
    }
  }
  boundaries.sort((a, b) => a.order - b.order);

  return {
    records,
    boundaries,
    narrative: [...narrative.values()].sort((a, b) => a.order - b.order),
    conflicts,
    history: (ref, field) => {
      if (ref.rec === 'boundary') {
        return (boundaryWrites.get(ref.id) ?? []).map((w) => ({
          field: 'edit',
          value: w.value,
          absent: false,
          op: w.node.op.id,
          hlc: w.node.op.hlc,
          by: w.node.op.act,
        }));
      }
      return logs.get(refKey(ref))?.log.history(field) ?? [];
    },
  };
}
