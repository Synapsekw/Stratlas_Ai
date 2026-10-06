import { z } from 'zod';
import { FetchPolicy } from './blobs';
import { Hlc, IsoTime, Sha256Hex, SignatureB64 } from './common';
import { Heads, TeamProjectId } from './exchange';
import {
  ActorId,
  DeviceCert,
  DeviceId,
  DeviceRecord,
  IdentityCard,
  Member,
  Role,
} from './identity';
import { ChainId, Op, OpId, RecordRef, ReplicaId, Seq } from './journal';

/**
 * Sync between copies (M9 streams T4 to T7): the transports' data types, the `aio.sync/1` HTTP
 * protocol shared by the team server and the app, conflicts and quarantine.
 */

export const SYNC_PROTOCOL = 'aio.sync/1' as const;
export const RECEIPT_SCHEMA = 'aio.receipt/1' as const;

/** How a copy shares: not at all, exchange files only, a hub folder, or a team server. */
export const SyncMode = z.enum(['off', 'exchange', 'hub', 'server']);

/**
 * Decision 1 as data: which modes this build offers and the server's status. The recommended
 * default is file-first GA with the server as a preview; a later decision changes these defaults.
 */
export const HostingModel = z.object({
  modes: z.array(SyncMode).default(['off', 'exchange', 'hub', 'server']),
  server: z.enum(['off', 'preview', 'ga']).default('preview'),
  /** A hosted service run by Synapse (option c): not before M10. */
  hosted: z.boolean().default(false),
});
export const DEFAULT_HOSTING = HostingModel.parse({});

/** userData `team/projects.json`: per project folder path, this machine's sharing setup. */
export const ProjectTeamConfig = z.object({
  /** Normalised project root (the library key). */
  root: z.string().min(1),
  replicaId: ReplicaId,
  mode: SyncMode,
  teamProjectId: TeamProjectId.optional(),
  hubPath: z.string().min(1).optional(),
  serverId: z.string().min(1).max(64).optional(),
  /** Fetch policy per layer id; absent layers follow `defaultFetchPolicy`. */
  fetch: z.record(z.string(), FetchPolicy).default({}),
  /** What each peer device was last sent (patches since these). */
  peers: z.record(DeviceId, Heads).default({}),
  /** Decision 8: the journal of a private project may be off (the switch is recorded). */
  journal: z.enum(['on', 'off']).default('on'),
  lastSync: IsoTime.optional(),
});
export const TEAM_CONFIG_SCHEMA = 'aio.team-config/1' as const;
export const TeamConfigFile = z.object({
  schema: z.literal(TEAM_CONFIG_SCHEMA),
  projects: z.array(ProjectTeamConfig),
});

// ---- transport data types (`SyncTransport` lives in @aio/sync) ----

/** A byte range of a blob, end exclusive. */
export const ByteRange = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

/** Why a pushed op was refused (server 403s, importer quarantine reasons). */
export const RefusalCode = z.enum([
  'schema',
  'hash',
  'signature',
  'chain',
  'gap',
  'role',
  'revoked',
  'non-member',
  'clock-ahead',
]);

/**
 * The server's own hash chain countersigning every accepted op (`aio.receipt/1`), so an export of
 * the server's audit matches the app's Verify.
 */
export const Receipt = z.object({
  schema: z.literal(RECEIPT_SCHEMA),
  server: z.string().min(1).max(64),
  seq: Seq,
  op: OpId,
  /** Id of the previous receipt; null for the first. */
  prev: Sha256Hex.nullable(),
  at: IsoTime,
  id: Sha256Hex,
  sig: SignatureB64,
});

export const PushResult = z.object({
  accepted: z.array(OpId),
  duplicates: z.array(OpId),
  refused: z.array(z.object({ id: z.string(), code: RefusalCode, message: z.string() })),
  receipts: z.array(Receipt).default([]),
});

export const PullPage = z.object({
  ops: z.array(Op),
  /** Opaque: pass back to get the next page. */
  cursor: z.string().max(4096).nullable(),
  more: z.boolean(),
});

// ---- aio.sync/1 over HTTPS (team server, preview) ----

/** Routes of `aio.sync/1`, relative to the server base URL. */
export const SYNC_ROUTES = {
  health: '/v1/health',
  enrol: '/v1/enrol',
  heads: '/v1/projects/:id/heads',
  ops: '/v1/projects/:id/ops',
  members: '/v1/projects/:id/members',
  blob: '/v1/blobs/:sha256',
} as const;

/**
 * Every request is signed by the device key (RFC 9421 HTTP Message Signatures, `ed25519`); there
 * are no bearer tokens. These are the covered components, in order.
 */
export const SIGNED_REQUEST_COMPONENTS = [
  '@method',
  '@target-uri',
  'content-digest',
  'x-aio-device',
  'x-aio-nonce',
] as const;

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  /** The protocol range the server speaks. */
  protocol: z.object({ min: z.number().int(), max: z.number().int() }),
});

export const EnrolRequest = z.object({
  /** The invite code from `invite --role ...` (M9; M10 may accept account tokens instead). */
  code: z.string().min(6).max(128),
  device: DeviceRecord,
  card: IdentityCard.optional(),
});
export const EnrolResponse = z.object({
  server: z.object({
    id: z.string().min(1).max(64),
    name: z.string(),
    version: z.string(),
    /** SHA-256 of the server certificate, pinned at enrolment. */
    fingerprint: Sha256Hex,
  }),
  cert: DeviceCert,
  role: Role,
  projects: z.array(z.object({ teamProjectId: TeamProjectId, name: z.string() })),
});

export const HeadsResponse = z.object({ project: TeamProjectId, heads: Heads });
export const PushOpsRequest = z.object({ ops: z.array(Op).min(1).max(5000) });
export const PushOpsResponse = PushResult;
export const PullOpsQuery = z.object({
  since: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
export const PullOpsResponse = PullPage;
export const MembersResponse = z.object({ members: z.array(Member) });
export const SyncErrorBody = z.object({ error: z.string(), code: z.string() });

// ---- conflicts and quarantine (T4) ----

/** Two concurrent values of one field: the person keeps one; the other stays in history. */
export const Conflict = z.object({
  id: z.string().min(1).max(300),
  target: RecordRef,
  field: z.string().min(1).max(100),
  ours: z.object({ value: z.unknown(), by: ActorId, hlc: Hlc, op: OpId }),
  theirs: z.object({ value: z.unknown(), by: ActorId, hlc: Hlc, op: OpId }),
  /** Delete against edit, close against reopen, confirm against dismiss... */
  kind: z.enum(['value', 'delete-edit', 'status', 'code', 'merge']),
  /** The value in the state files now (the last writer by HLC). */
  current: z.enum(['ours', 'theirs']),
});

/** An op kept but not applied, listed for an owner. */
export const QuarantineEntry = z.object({
  op: OpId,
  chain: ChainId,
  seq: Seq,
  by: ActorId,
  device: DeviceId,
  hlc: Hlc,
  kind: z.string(),
  target: RecordRef,
  reason: RefusalCode,
  message: z.string(),
});

/** Sharing status of the open project (team:status, Library badge). */
export const TeamStatus = z.object({
  mode: SyncMode,
  teamProjectId: TeamProjectId.optional(),
  name: z.string().optional(),
  role: Role.optional(),
  lastSync: IsoTime.optional(),
  pending: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  /** Hub or server not reachable: work continues locally. */
  reachable: z.boolean().optional(),
});

/** One enrolled team server on this machine (server:list). Credentials stay in the vault. */
export const ServerInfo = z.object({
  id: z.string().min(1).max(64),
  url: z.url({ protocol: /^https$/ }),
  name: z.string(),
  fingerprint: Sha256Hex,
  version: z.string().optional(),
  enrolledAt: IsoTime,
  role: Role.optional(),
});

export type SyncMode = z.infer<typeof SyncMode>;
export type HostingModel = z.infer<typeof HostingModel>;
export type ProjectTeamConfig = z.infer<typeof ProjectTeamConfig>;
export type ByteRange = z.infer<typeof ByteRange>;
export type RefusalCode = z.infer<typeof RefusalCode>;
export type PushResult = z.infer<typeof PushResult>;
export type PullPage = z.infer<typeof PullPage>;
export type Receipt = z.infer<typeof Receipt>;
export type Conflict = z.infer<typeof Conflict>;
export type QuarantineEntry = z.infer<typeof QuarantineEntry>;
export type TeamStatus = z.infer<typeof TeamStatus>;
export type ServerInfo = z.infer<typeof ServerInfo>;
export type HealthResponse = z.infer<typeof HealthResponse>;
export type EnrolRequest = z.infer<typeof EnrolRequest>;
export type EnrolResponse = z.infer<typeof EnrolResponse>;
