import type { Conflict, Op, QuarantineEntry, RecordRef } from '@aio/schema';
import { indexOps, type HeldOp } from './causal';
import { conflictId, toConflict, type ConflictSeed } from './conflicts';
import {
  gate,
  RELEASE_PREFIX,
  type ClockNotice,
  type GateOptions,
  type TeamView,
} from './quarantine';
import type { FieldWrite } from './registers';
import { projectCollab, type CollabProjection } from './rules/collab';
import { projectIssues, type ProjectedIssue, type Recode } from './rules/issue';
import { projectRecords, refKey, type RecordsProjection } from './rules/records';

export interface ProjectOptions extends GateOptions {
  /** The actor looking: conflicts show their own side as `ours`. */
  viewer?: string;
}

/** The result of projecting a set of ops: state per record, plus what a person must look at. */
export interface Projection {
  /** Record key (`<rec>:<in>:<id>`) to its merged JSON (issues whole; other records as overlays). */
  records: Map<string, unknown>;
  /** Issues the journal knows, live ones in the order they were made. */
  issues: ProjectedIssue[];
  /** Change items, detections, passes, parts and manifest entries, as field overlays. */
  subRecords: RecordsProjection['records'];
  boundaries: RecordsProjection['boundaries'];
  narrative: RecordsProjection['narrative'];
  collab: Omit<CollabProjection, 'conflicts'>;
  /** Open conflicts (resolved ones are left out). */
  conflicts: Conflict[];
  quarantined: QuarantineEntry[];
  /** Ops waiting for earlier ops from another copy (a gap). */
  held: HeldOp[];
  /** Codes renumbered because two issues made apart had the same code: write `issue.recode`. */
  recodes: Recode[];
  /** Remote clocks ahead of this machine (5 minutes: a notice; 24 hours: held). */
  clock: ClockNotice[];
  team: TeamView;
  /** Every value written to a record's fields, losers included, oldest first. */
  history(target: RecordRef, field?: string): FieldWrite[];
  /** Ids of applied ops, in total order. */
  applied: string[];
}

/**
 * Project ops into state for every record type (decision 7). Order-independent: any permutation
 * or duplication of `ops` gives the same projection, and copies holding the same ops write the
 * same bytes. Pure: no file system, no clock (pass `now` for the clock-ahead hold).
 */
export function project(ops: readonly Op[], opts: ProjectOptions = {}): Projection {
  const index = indexOps(ops);
  const g = gate(index, opts);
  const exports = g.applied.filter((n) => n.op.kind === 'package.export');
  const issues = projectIssues(g.applied, index, exports);
  const records = projectRecords(g.applied, index);
  const collab = projectCollab(g.applied, index);

  const resolved = new Set<string>();
  for (const n of g.applied) {
    if (n.op.kind !== 'conflict.resolve') continue;
    const c = (n.op.payload as { conflict?: unknown } | undefined)?.conflict;
    if (typeof c === 'string' && !c.startsWith(RELEASE_PREFIX)) resolved.add(c);
  }
  const seeds: ConflictSeed[] = [...issues.conflicts, ...records.conflicts, ...collab.conflicts];
  const conflicts = seeds
    .filter((s) => !resolved.has(conflictId(s)))
    .map((s) => toConflict(s, opts.viewer))
    .sort((a, b) => {
      const x = a.ours.hlc > a.theirs.hlc ? a.ours.hlc : a.theirs.hlc;
      const y = b.ours.hlc > b.theirs.hlc ? b.ours.hlc : b.theirs.hlc;
      return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : 1;
    });

  const map = new Map<string, unknown>();
  for (const i of issues.issues) {
    if (i.state !== 'deleted') map.set(refKey({ rec: 'issue', id: i.id }), i.record);
  }
  for (const r of records.records) map.set(refKey(r.ref), { set: r.set, unset: r.unset });
  for (const b of records.boundaries) map.set(refKey({ rec: 'boundary', id: b.key }), b.record);

  return {
    records: map,
    issues: issues.issues,
    subRecords: records.records,
    boundaries: records.boundaries,
    narrative: records.narrative,
    collab: {
      comments: collab.comments,
      assignments: collab.assignments,
      approvals: collab.approvals,
    },
    conflicts,
    quarantined: g.quarantined,
    held: index.held,
    recodes: issues.recodes,
    clock: g.clock,
    team: g.team,
    history: (target, field) =>
      target.rec === 'issue' ? issues.history(target.id, field) : records.history(target, field),
    applied: g.applied.map((n) => n.op.id),
  };
}
