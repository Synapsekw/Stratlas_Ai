import type { Signer } from '@aio/journal';
import type { DeviceRecord, Op, RecordRef } from '@aio/schema';

/**
 * What sync needs from the other streams: T2's identity (`DevicePort`, `identityPorts.ts`), T1's
 * journal service and T4's merge engine (`JournalPort`, `MergePort`, `engine.ts`).
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
   * Make sure every saved change is in the journal before ops are sent or merged: pending appends
   * finish, and a change made to the files outside the app is recorded first.
   */
  flush(ctx: ProjectCtx): Promise<void>;
  /** Append an event op to this copy's chain (`project.share`, `exchange.import`). */
  record(ctx: ProjectCtx, kind: string, target: RecordRef, payload: unknown): Promise<Op | null>;
  /**
   * Ops from another copy (planned: no gaps): appended to their own chains by T1, then projected
   * into the state files by T4, as one journal step. Returns the records that changed (for
   * `journal:changed`) and the open conflicts.
   */
  ingest(ctx: ProjectCtx, ops: readonly Op[]): Promise<{ records: RecordRef[]; conflicts: number }>;
}

/** T4: the merge engine. */
export interface MergePort {
  /** Open conflicts and quarantined ops (status and Library badge). */
  counts(ctx: ProjectCtx): Promise<{ conflicts: number; quarantined: number }>;
}
