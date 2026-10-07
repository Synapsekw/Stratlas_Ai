import type { Conflict, Op, QuarantineEntry } from '@aio/schema';

/** The result of projecting a set of ops: state per record, plus what a person must look at. */
export interface Projection {
  /** Record key (`<rec>:<in>:<id>`) to its merged JSON. */
  records: Map<string, unknown>;
  conflicts: Conflict[];
  quarantined: QuarantineEntry[];
}

/**
 * Project ops into state for every record type (the T4 merge engine). Order-independent:
 * any permutation or duplication of `ops` gives the same projection. T0 declares it; T4
 * implements it with the rules in `MERGE_RULES`.
 */
export function project(ops: readonly Op[]): Projection {
  throw new Error(`project is not implemented yet (M9 T4; ${ops.length} ops).`);
}
