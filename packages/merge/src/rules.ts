import type { RecordKind } from '@aio/schema';

/**
 * How concurrent changes to each record type combine (the merge rules table of the M9 plan).
 * Pure and deterministic: the same set of ops gives byte-identical state in any order.
 *
 * - `lww-field`: last writer by HLC wins per field; concurrent different values become a conflict.
 * - `lww-record`: last writer wins for the whole record (detections without ids: whole pass).
 * - `add-wins-set`: observed-remove set (issue sightings by content hash).
 * - `grow-only`: never removed (comments, approvals, narrative versions); edits are versions.
 * - `none`: not merged (the record is not synced, or is an event).
 */
export type MergeRule = 'lww-field' | 'lww-record' | 'add-wins-set' | 'grow-only' | 'none';

export const MERGE_RULES = {
  issue: 'lww-field',
  comment: 'grow-only',
  assignment: 'lww-record',
  approval: 'grow-only',
  'change-item': 'lww-field',
  'change-set': 'lww-record',
  detection: 'lww-field',
  'detection-pass': 'lww-record',
  part: 'lww-field',
  model: 'lww-record',
  manifest: 'lww-field',
  boundary: 'lww-record',
  narrative: 'grow-only',
  report: 'none',
  blob: 'grow-only',
  member: 'lww-field',
  device: 'grow-only',
  policy: 'lww-field',
  project: 'none',
  op: 'none',
  file: 'lww-record',
} as const satisfies Record<RecordKind, MergeRule>;

/** Issue fields merged together (a class change carries its severity model). */
export const FIELD_GROUPS: readonly (readonly string[])[] = [['classId', 'severityModelId']];

/** Manifest fields only an owner changes; every concurrent change is a conflict. */
export const OWNER_ONLY_MANIFEST_FIELDS = ['crs', 'origin', 'verticalDatum'] as const;
