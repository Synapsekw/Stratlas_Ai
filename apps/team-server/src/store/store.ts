import type { DeviceRecord, Heads, Op, Receipt, Role, TeamProject } from '@aio/schema';

/** A device enrolled with this server (an invite code plus its self-signed public record). */
export interface EnrolledDevice {
  device: string;
  actor: string;
  /** Raw Ed25519 public key, base64url. */
  key: string;
  name: string;
  initials: string;
  /** The role the invite gave: used in projects where the journal has no member op for the actor. */
  role: Role;
  /** The project the invite was for; null: every project on this server. */
  project: string | null;
  enrolledAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  /** The device record as the app sent it. */
  record: DeviceRecord;
}

/** A one-time invite code. Only its SHA-256 is kept. */
export interface Invite {
  codeHash: string;
  role: Role;
  project: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
}

/** Seq per chain: what a reader already has. A chain left out counts as 0. */
export type SeqByChain = Readonly<Record<string, number>>;

/**
 * Where the server keeps a team's data. Ops and receipts are append-only: there is no update or
 * delete for them (Postgres also refuses UPDATE, DELETE and TRUNCATE on those tables with a
 * trigger; the memory adapter simply has no such method). Ops are kept as the JSON the device
 * sent, so every hash and signature still verifies. The server validates and stores; it never
 * merges.
 */
export interface Store {
  readonly kind: 'memory' | 'postgres';
  /** Prepare the store (Postgres: run the migrations). */
  init(): Promise<void>;
  close(): Promise<void>;

  meta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  /** Team projects this server holds. */
  projects(): Promise<TeamProject[]>;
  project(teamProjectId: string): Promise<TeamProject | null>;
  createProject(project: TeamProject): Promise<void>;

  heads(teamProjectId: string): Promise<Heads>;
  /** Which of these op ids the project holds. */
  hasOps(teamProjectId: string, ids: readonly string[]): Promise<Set<string>>;
  /** Store ops not seen before (by id), in this order; returns the ids stored and those already there. */
  appendOps(
    teamProjectId: string,
    ops: readonly Op[],
  ): Promise<{ stored: string[]; duplicates: string[] }>;
  /** Ops after `since` per chain, in the order the server received them, at most `limit`. */
  opsSince(
    teamProjectId: string,
    since: SeqByChain,
    limit: number,
  ): Promise<{ ops: Op[]; more: boolean }>;
  /** Every op of a project in arrival order (audit export, backup, rebuilding the roles). */
  allOps(teamProjectId: string): AsyncIterable<Op>;

  appendReceipts(receipts: readonly Receipt[]): Promise<void>;
  lastReceipt(): Promise<Receipt | null>;
  /** Receipts after `afterSeq`, in order, at most `limit`. */
  receipts(afterSeq: number, limit: number): Promise<Receipt[]>;

  addInvite(invite: Invite): Promise<void>;
  /** Mark an unused, unexpired invite used by `device` and return it; null when there is none. */
  takeInvite(codeHash: string, now: string, device: string): Promise<Invite | null>;
  invites(): Promise<Invite[]>;

  /** Add or replace an enrolled device. */
  putDevice(device: EnrolledDevice): Promise<void>;
  device(deviceId: string): Promise<EnrolledDevice | null>;
  devices(): Promise<EnrolledDevice[]>;
  revokeDevice(deviceId: string, at: string, reason: string | null): Promise<boolean>;
}
