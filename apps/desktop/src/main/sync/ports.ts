import type { Signer } from '@aio/journal';
import type { DeviceRecord, Op, RecordRef } from '@aio/schema';

/**
 * What sync needs from the streams that build alongside it. Each port has an interim
 * implementation in `interim.ts` so exchange and hub sync work end to end in this branch; at
 * integration the integration lead passes the real ones to `registerSyncIpc` (see the T5 report:
 * T2 for `DevicePort`, T1 for `JournalPort`, T4 for `MergePort`).
 */

/** One open folder project as sync sees it. */
export interface ProjectCtx {
  projectId: string;
  root: string;
  replicaId: string;
  /** This copy's chain: `<device>.<replica>`. */
  chain: string;
  device: string;
  /** userData `journal-cache/<replica>/`: rebuildable sync state of this copy. */
  cacheDir: string;
}

export interface Me {
  actor: string;
  name: string;
  initials: string;
}

/** T2: the person and this device. Keys stay in the OS vault; only a signer comes out. */
export interface DevicePort {
  me(): Promise<Me>;
  /** null when the vault cannot be read (ops would be unsigned; exchange files cannot be made). */
  signer(): Promise<Signer | null>;
  /** This device's self-signed record (journal/devices, hubs, exchange files). */
  record(): Promise<DeviceRecord | null>;
}

/** T1: the journal of a project. */
export interface JournalPort {
  /**
   * Make sure every saved change is in the journal before ops are sent or merged. T1 journals each
   * write as it happens, so its version only waits for pending appends.
   */
  flush(ctx: ProjectCtx): Promise<void>;
  /** Append an event op to this copy's chain (`project.share`, `exchange.import`). */
  record(ctx: ProjectCtx, kind: string, target: RecordRef, payload: unknown): Promise<Op | null>;
}

/** T4: the merge engine. */
export interface MergePort {
  /**
   * Ops were just added to the journal from another copy: project them into the state files,
   * returning the records that changed (for `journal:changed`) and the open conflicts.
   */
  apply(ctx: ProjectCtx, ops: readonly Op[]): Promise<{ records: RecordRef[]; conflicts: number }>;
  /** Open conflicts and quarantined ops (status and Library badge). */
  counts(ctx: ProjectCtx): Promise<{ conflicts: number; quarantined: number }>;
}
