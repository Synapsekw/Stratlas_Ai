import { z } from 'zod';
import { BlobAddPayload } from './blobs';
import {
  ApprovalPayload,
  ApprovalWithdrawPayload,
  AssignPayload,
  CommentDeletePayload,
  CommentEditPayload,
  CommentPayload,
  CommentRedactPayload,
  PolicySetPayload,
} from './collab';
import { Hlc, Id, IsoTime, Sha256Hex, SignatureB64 } from './common';
import {
  ActorId,
  DeviceId,
  DeviceRevokePayload,
  MemberAddPayload,
  MemberLinkPayload,
  MemberRemovePayload,
  MemberRolePayload,
  type Permission,
} from './identity';

/**
 * The journal (M9 stream T1, data-conventions section 17): a signed, hash-chained, per-device log
 * of every change to a project. One JSON line per op in `journal/ops/<chain>/NNNNNN.jsonl`.
 *
 * Hashes are SHA-256 over JSON canonicalised by RFC 8785 (JCS); signatures are Ed25519 over
 * `<domain>\n<hash>` (UTF-8), so a signature for one kind of record never verifies as another.
 * Verification works on the raw parsed JSON of each line, never on a zod output: the op schemas
 * keep unknown keys (`looseObject`) so a newer op still hashes the same in an older reader.
 */

export const OP_SCHEMA = 'aio.op/1' as const;
export const CHECKPOINT_SCHEMA = 'aio.checkpoint/1' as const;

/** Folder of the journal inside a folder project. Older builds ignore it. */
export const JOURNAL_DIR = 'journal';
export const JOURNAL_DEVICES_DIR = 'journal/devices';
export const JOURNAL_OPS_DIR = 'journal/ops';
export const JOURNAL_CHECKPOINTS_DIR = 'journal/checkpoints';

/** A segment is closed at whichever comes first. */
export const SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
export const SEGMENT_MAX_OPS = 10_000;
/** A checkpoint is signed every this many ops, and at every exchange or sync. */
export const CHECKPOINT_EVERY_OPS = 500;
/** A remote clock this far ahead raises a notice; this far ahead holds the op in the inbox. */
export const CLOCK_AHEAD_NOTICE_MS = 5 * 60 * 1000;
export const CLOCK_AHEAD_HOLD_MS = 24 * 60 * 60 * 1000;

/** Signature domains (the first line of every signed message). */
export const SIGNING_DOMAINS = {
  op: 'aio.op/1',
  checkpoint: 'aio.checkpoint/1',
  device: 'aio.device/1',
  cert: 'aio.cert/1',
  idcard: 'aio.idcard/1',
  exchange: 'aio.exchange/1',
  receipt: 'aio.receipt/1',
  request: 'aio.request/1',
} as const;

/** An op id: SHA-256 of the canonical op without `id`, `payload` and `sig` (it covers `ph`). */
export const OpId = Sha256Hex;

/** `r_` plus 80 random bits in base32: one per project folder path in userData. */
export const ReplicaId = z
  .string()
  .regex(/^r_[a-z2-7]{16}$/, 'A replica id is r_ and 16 base32 letters.');

/** `<deviceId>.<replicaId>`: one hash chain. A copied or moved folder starts a new chain. */
export const ChainId = z
  .string()
  .regex(/^d_[a-z2-7]{52}\.r_[a-z2-7]{16}$/, 'A chain id is <device>.<replica>.');

/** Position of an op in its chain, from 1. */
export const Seq = z.number().int().min(1);

/**
 * Every op kind this build knows. Readers accept any `<word>.<word>` kind (`OpKindName`) so an op
 * added by a later version is kept, verified and shown as "unknown change", never refused.
 */
export const OP_KINDS = [
  // issues
  'issue.create',
  'issue.patch',
  'issue.delete',
  'issue.restore',
  'issue.sighting.add',
  'issue.sighting.remove',
  'issue.status',
  'issue.merge',
  'issue.recode',
  // collaboration
  'comment.add',
  'comment.edit',
  'comment.delete',
  'comment.redact',
  'assign.set',
  'approval.add',
  'approval.withdraw',
  // other records
  'change.review',
  'detection.review',
  'procmodel.part',
  'manifest.entry',
  'boundary.edit',
  'narrative.version',
  // binaries
  'blob.add',
  // team
  'member.add',
  'member.role',
  'member.remove',
  'member.link',
  'device.revoke',
  'policy.set',
  'project.share',
  // events
  'package.export',
  'exchange.import',
  'conflict.resolve',
  'record.external',
  'checkpoint',
  // the journal itself (decision 8: the switch is recorded; redaction by an owner)
  'journal.off',
  'journal.on',
  'op.redact',
] as const;
export const OpKind = z.enum(OP_KINDS);
export const OpKindName = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z-]*(\.[a-z][a-z-]*)*$/, 'An op kind is dotted lower-case words.');

/** Record kinds an op can target. Readers accept unknown kinds the same way as op kinds. */
export const RECORD_KINDS = [
  'issue',
  'comment',
  'assignment',
  'approval',
  'change-item',
  'change-set',
  'detection',
  'detection-pass',
  'part',
  'model',
  'manifest',
  'boundary',
  'narrative',
  'report',
  'blob',
  'member',
  'device',
  'policy',
  'project',
  'op',
  'file',
] as const;
export const RecordKind = z.enum(RECORD_KINDS);

/**
 * What an op changes: the record kind, its id and, for records inside a file, `in` (the change set
 * id of a change item, the pass file of a detection, the model id of a part).
 */
export const RecordRef = z.looseObject({
  rec: z.string().min(1).max(40),
  id: z.string().min(1).max(300),
  in: z.string().min(1).max(300).optional(),
});

/** How a change came about, besides "by hand in Stratlas" (no `via`). One key per op. */
export const Via = z.union([
  z.looseObject({
    agent: z.looseObject({
      conversation: z.string().min(1).max(128),
      callId: z.string().min(1).max(128),
      provider: z.string().max(64).optional(),
      model: z.string().max(128).optional(),
    }),
  }),
  z.looseObject({
    pipeline: z.looseObject({
      name: z.string().min(1).max(64),
      jobId: z.string().min(1).max(128),
      packVersion: z.string().max(40).optional(),
    }),
  }),
  z.looseObject({
    import: z.looseObject({
      source: z.enum(['exchange', 'hub', 'server', 'reply', 'package']),
      ref: z.string().max(300).optional(),
      from: DeviceId.optional(),
    }),
  }),
  z.looseObject({
    external: z.looseObject({
      /** When the difference was found: on open, around a pipeline job, or at a sync. */
      found: z.enum(['open', 'job', 'sync']),
      file: z.string().max(1024).optional(),
    }),
  }),
]);

/**
 * `aio.op/1`, one JSON line. `prev` is the id of `seq - 1` in the same chain (null for seq 1), and
 * the first op of a segment links to the last op of the previous segment the same way. `deps`
 * holds the heads of the other chains this device had seen. `payload` is absent only when redacted
 * (an `op.redact` or `comment.redact` op names it); `ph` stays, so the chain still verifies.
 */
export const Op = z
  .looseObject({
    v: z.literal(1),
    id: OpId,
    chain: ChainId,
    dev: DeviceId,
    act: ActorId,
    seq: Seq,
    hlc: Hlc,
    prev: OpId.nullable(),
    deps: z.record(ChainId, OpId).optional(),
    kind: OpKindName,
    target: RecordRef,
    /** Content hash of the target record before the op (crash recovery, external edits). */
    base: Sha256Hex.optional(),
    /** SHA-256 of the canonical payload. */
    ph: Sha256Hex,
    payload: z.unknown().optional(),
    via: Via.optional(),
    /** Readable label from the editor's command ("F01 to reviewed"). */
    label: z.string().max(200).optional(),
    /** Absent when the vault failed: the op is "unsigned" (still hash-chained) and Verify says so. */
    sig: SignatureB64.optional(),
  })
  .superRefine((op, ctx) => {
    if (!op.chain.startsWith(`${op.dev}.`)) {
      ctx.addIssue({
        code: 'custom',
        message: 'The chain does not belong to the device.',
        path: ['chain'],
      });
    }
    if (!op.hlc.endsWith(`.${op.dev}`)) {
      ctx.addIssue({
        code: 'custom',
        message: 'The clock reading is not from the device.',
        path: ['hlc'],
      });
    }
    if ((op.seq === 1) !== (op.prev === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Only the first op of a chain has no prev.',
        path: ['prev'],
      });
    }
  });

/** The fields covered by the op id (everything but `id`, `payload` and `sig`). */
export const OP_ID_EXCLUDES = ['id', 'payload', 'sig'] as const;

// ---- payloads of the journal's own kinds ----

/** `issue.patch` and `manifest.entry`: fields set and unset (field-level, last writer wins). */
export const PatchPayload = z.object({
  set: z.record(z.string(), z.unknown()).optional(),
  unset: z.array(z.string()).optional(),
  /**
   * M9 integration: the values the fields had before (History shows "severity 1 to 3" without
   * replaying the chain). Informational only: merging never reads it.
   */
  was: z.record(z.string(), z.unknown()).optional(),
});
/** `issue.create`, `issue.restore`: the whole record (an `Issue`, kept as JSON). */
export const RecordPayload = z.object({ record: z.record(z.string(), z.unknown()) });
export const IssueStatusPayload = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export const IssueMergePayload = z.object({ into: Id });
export const IssueRecodePayload = z.object({ from: z.string(), to: z.string() });
/** `issue.sighting.add|remove`: the sighting and its content hash (sightings have no id). */
export const SightingPayload = z.object({
  hash: Sha256Hex,
  sighting: z.record(z.string(), z.unknown()).optional(),
});
/** `record.external`: a difference found on disk (old build, pipeline outside a job, hand edit). */
export const ExternalPayload = z.object({
  file: z.string().min(1).max(1024),
  before: Sha256Hex.nullable(),
  after: Sha256Hex.nullable(),
  patch: PatchPayload.optional(),
});
/** `op.redact`: the payload of `op` is removed from every copy; the chain still verifies. */
export const RedactPayload = z.object({
  op: OpId,
  chain: ChainId,
  seq: Seq,
  reason: z.string().max(500).optional(),
});
/** `conflict.resolve`: the person's choice in the Conflicts inbox. */
export const ConflictResolvePayload = z.object({
  conflict: z.string().min(1).max(300),
  choice: z.enum(['ours', 'theirs', 'restore']),
  value: z.unknown().optional(),
});
export const CheckpointPayload = z.object({
  file: z.string().min(1),
  root: Sha256Hex,
  count: z.number().int(),
});
export const ProjectSharePayload = z.object({
  teamProjectId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
});
export const PackageExportPayload = z.object({
  file: z.string().min(1).max(260),
  readOnly: z.boolean(),
  history: z.enum(['none', 'summary', 'full']),
});
export const ExchangeImportPayload = z.object({
  exchange: z.string().min(1).max(64),
  kind: z.enum(['patch', 'bundle', 'reply']),
  ops: z.number().int().nonnegative(),
});
export const JournalSwitchPayload = z.object({ reason: z.string().max(500).optional() });

/** The payload schema of each known kind (the server and the importer validate with these). */
export const OP_PAYLOADS = {
  'issue.create': RecordPayload,
  'issue.patch': PatchPayload,
  'issue.delete': z.object({}),
  'issue.restore': RecordPayload,
  'issue.sighting.add': SightingPayload,
  'issue.sighting.remove': SightingPayload,
  'issue.status': IssueStatusPayload,
  'issue.merge': IssueMergePayload,
  'issue.recode': IssueRecodePayload,
  'comment.add': CommentPayload,
  'comment.edit': CommentEditPayload,
  'comment.delete': CommentDeletePayload,
  'comment.redact': CommentRedactPayload,
  'assign.set': AssignPayload,
  'approval.add': ApprovalPayload,
  'approval.withdraw': ApprovalWithdrawPayload,
  'change.review': PatchPayload,
  'detection.review': PatchPayload,
  'procmodel.part': PatchPayload,
  'manifest.entry': PatchPayload,
  'boundary.edit': RecordPayload,
  'narrative.version': RecordPayload,
  'blob.add': BlobAddPayload,
  'member.add': MemberAddPayload,
  'member.role': MemberRolePayload,
  'member.remove': MemberRemovePayload,
  'member.link': MemberLinkPayload,
  'device.revoke': DeviceRevokePayload,
  'policy.set': PolicySetPayload,
  'project.share': ProjectSharePayload,
  'package.export': PackageExportPayload,
  'exchange.import': ExchangeImportPayload,
  'conflict.resolve': ConflictResolvePayload,
  'record.external': ExternalPayload,
  checkpoint: CheckpointPayload,
  'journal.off': JournalSwitchPayload,
  'journal.on': JournalSwitchPayload,
  'op.redact': RedactPayload,
} as const satisfies Record<z.infer<typeof OpKind>, z.ZodType>;

/**
 * The permission each kind needs at its HLC (shared by the desktop's quarantine and the server's
 * 403). `null`: no role check (events any member's device records about itself).
 */
export const OP_PERMISSION = {
  'issue.create': 'edit',
  'issue.patch': 'edit',
  'issue.delete': 'edit',
  'issue.restore': 'edit',
  'issue.sighting.add': 'edit',
  'issue.sighting.remove': 'edit',
  'issue.status': 'edit',
  'issue.merge': 'edit',
  'issue.recode': 'edit',
  'comment.add': 'comment.team',
  'comment.edit': 'comment.team',
  'comment.delete': 'comment.team',
  'comment.redact': 'admin',
  'assign.set': 'assign',
  'approval.add': 'approve',
  'approval.withdraw': 'approve',
  'change.review': 'edit',
  'detection.review': 'edit',
  'procmodel.part': 'edit',
  'manifest.entry': 'builder.edit',
  'boundary.edit': 'edit',
  'narrative.version': 'edit',
  'blob.add': 'builder.edit',
  'member.add': 'admin',
  'member.role': 'admin',
  'member.remove': 'admin',
  'member.link': 'admin',
  'device.revoke': 'admin',
  'policy.set': 'admin',
  'project.share': 'admin',
  'package.export': 'export.package',
  'exchange.import': null,
  'conflict.resolve': 'edit',
  'record.external': null,
  checkpoint: null,
  'journal.off': 'admin',
  'journal.on': null,
  'op.redact': 'admin',
} as const satisfies Record<z.infer<typeof OpKind>, Permission | null>;

/**
 * Decision 8 as data: the journal is on for every folder project; a person may switch it off for
 * a private project (the switch is recorded as `journal.off`), never for a team project.
 */
export const JournalPolicy = z.object({
  defaultOn: z.boolean().default(true),
  allowOffPrivate: z.boolean().default(true),
  allowOffTeam: z.boolean().default(false),
});
export const DEFAULT_JOURNAL_POLICY = JournalPolicy.parse({});

/** `aio.checkpoint/1`, `journal/checkpoints/<ms>.<counter>.<chain>.json`, signed (domain checkpoint). */
export const Checkpoint = z.looseObject({
  schema: z.literal(CHECKPOINT_SCHEMA),
  chain: ChainId,
  dev: DeviceId,
  act: ActorId,
  hlc: Hlc,
  /** Seq of this chain's op at the checkpoint. */
  seq: Seq,
  /** Head of every chain known at the checkpoint, this one included. */
  heads: z.record(ChainId, z.looseObject({ seq: Seq, id: OpId })),
  /** Ops known across all chains. */
  count: z.number().int().nonnegative(),
  /** Merkle root over the heads sorted by chain id (leaf: SHA-256 of `<chain> <seq> <id>`). */
  root: Sha256Hex,
  /** SHA-256 of the canonical checkpoint without `id` and `sig`. */
  id: Sha256Hex,
  sig: SignatureB64.optional(),
});

/** The file name of a checkpoint: short enough for deep project paths on Windows. */
export function checkpointFileName(hlc: string, chain: string): string {
  const [ms, counter] = hlc.split('.');
  return `${ms ?? '0'}.${counter ?? '0'}.${chain}.json`;
}

/** The file name of segment `n` (from 1) of a chain: `000001.jsonl`. */
export function segmentFileName(n: number): string {
  return `${String(n).padStart(6, '0')}.jsonl`;
}

/** The labelled editor commands `project:writeIssues` may carry (`createIssueEditor.commit()`). */
export const EditCommand = z.object({
  label: z.string().min(1).max(200),
  ids: z.array(Id).max(10_000),
  via: Via.optional(),
});

/** How a change came about, as History shows it. */
export const ChangeHow = z.enum(['hand', 'agent', 'pipeline', 'external', 'import', 'server']);

/** One History or Audit row (journal:history). */
export const AuditEntry = z.object({
  op: OpId,
  chain: ChainId,
  seq: Seq,
  hlc: Hlc,
  /** Wall time of the clock reading. */
  at: IsoTime,
  actor: z.object({ id: ActorId, name: z.string().optional(), initials: z.string().optional() }),
  device: DeviceId,
  kind: OpKindName,
  target: RecordRef,
  label: z.string().optional(),
  how: ChangeHow,
  via: Via.optional(),
  /** Before and after per field, when the projection knows them. */
  changes: z
    .array(
      z.object({
        field: z.string(),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
      }),
    )
    .optional(),
  state: z.enum(['ok', 'unsigned', 'quarantined', 'bad-signature', 'unknown-kind']),
  redacted: z.object({ by: ActorId, at: Hlc }).optional(),
});

export const AuditFilter = z.object({
  actors: z.array(ActorId).optional(),
  kinds: z.array(OpKindName).optional(),
  target: RecordRef.optional(),
  how: z.array(ChangeHow).optional(),
  from: IsoTime.optional(),
  to: IsoTime.optional(),
});

/** What Verify can find, each named with the exact file and line. */
export const VerifyCode = z.enum([
  /** A line is not valid JSON or not an op. */
  'parse',
  /** The op's fields do not hash to its id (an edited line). */
  'hash-mismatch',
  /** The payload does not hash to `ph` (an edited payload). */
  'payload-hash',
  /** A payload is missing and no redaction op names it. */
  'payload-missing',
  /** A seq is missing in a chain (a removed line). */
  'chain-gap',
  /** Ops are out of seq order in a file (reordered lines). */
  'order',
  /** A chain ends before an op another chain or a checkpoint references (a truncated tail). */
  'truncated',
  /** A whole segment file is missing while later segments or other chains reference it. */
  'segment-missing',
  /** Two ops claim the same chain and seq, or the same prev (a copied folder kept writing). */
  'fork',
  'bad-signature',
  'unsigned',
  'unknown-device',
  'revoked-device',
  'checkpoint-mismatch',
  'clock-ahead',
]);

export const VerifyProblem = z.object({
  code: VerifyCode,
  /** Project-relative file, forward slashes. */
  file: z.string().optional(),
  /** 1-based line in `file`. */
  line: z.number().int().min(1).optional(),
  chain: ChainId.optional(),
  seq: Seq.optional(),
  op: OpId.optional(),
  message: z.string(),
});

/** The Verify report (journal:verify, `tools/audit-verify`). `ok` only when `problems` is empty. */
export const VerifyReport = z.object({
  ok: z.boolean(),
  checkedAt: IsoTime,
  head: z.object({ root: Sha256Hex, count: z.number().int().nonnegative() }).nullable(),
  chains: z.array(
    z.object({
      chain: ChainId,
      device: DeviceId,
      ops: z.number().int().nonnegative(),
      segments: z.number().int().nonnegative(),
      head: z.object({ seq: Seq, id: OpId }).nullable(),
    }),
  ),
  counts: z.object({
    ops: z.number().int().nonnegative(),
    signed: z.number().int().nonnegative(),
    unsigned: z.number().int().nonnegative(),
    external: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    redacted: z.number().int().nonnegative(),
  }),
  problems: z.array(VerifyProblem),
});

/** Audit exports (journal `audit:export`, package exports of kind `files`). */
export const AuditExportFormat = z.enum(['audit-csv', 'audit-json']);

export const AUDIT_FILE_SCHEMA = 'aio.audit/1' as const;

/**
 * The signed audit export (`audit-json`, `aio.audit/1`): the entries shown, the Verify report and
 * every file of the project's `journal/` folder as text (device records, segments, checkpoints),
 * so `tools/audit-verify/verify.mjs` re-checks it with no app. Readers keep unknown keys.
 */
export const AuditFile = z.looseObject({
  schema: z.literal(AUDIT_FILE_SCHEMA),
  app: z.object({ name: z.string(), version: z.string() }),
  project: z.object({ name: z.string() }),
  exportedAt: IsoTime,
  filter: AuditFilter.optional(),
  head: z.object({ root: Sha256Hex, count: z.number().int().nonnegative() }).nullable(),
  verify: VerifyReport.nullable(),
  entries: z.array(AuditEntry),
  /** Project-relative path (`journal/...`) to the file's text. */
  journal: z.record(z.string(), z.string()),
});
export type AuditFile = z.infer<typeof AuditFile>;

export type OpId = z.infer<typeof OpId>;
export type ReplicaId = z.infer<typeof ReplicaId>;
export type ChainId = z.infer<typeof ChainId>;
export type OpKind = z.infer<typeof OpKind>;
export type RecordKind = z.infer<typeof RecordKind>;
export type RecordRef = z.infer<typeof RecordRef>;
export type Via = z.infer<typeof Via>;
export type Op = z.infer<typeof Op>;
export type OpPayload<K extends OpKind> = z.output<(typeof OP_PAYLOADS)[K]>;
export type JournalPolicy = z.infer<typeof JournalPolicy>;
export type Checkpoint = z.infer<typeof Checkpoint>;
export type EditCommand = z.infer<typeof EditCommand>;
export type ChangeHow = z.infer<typeof ChangeHow>;
export type AuditEntry = z.infer<typeof AuditEntry>;
export type AuditFilter = z.infer<typeof AuditFilter>;
export type VerifyCode = z.infer<typeof VerifyCode>;
export type VerifyProblem = z.infer<typeof VerifyProblem>;
export type VerifyReport = z.infer<typeof VerifyReport>;
export type AuditExportFormat = z.infer<typeof AuditExportFormat>;

export function isKnownOpKind(kind: string): kind is OpKind {
  return (OP_KINDS as readonly string[]).includes(kind);
}
