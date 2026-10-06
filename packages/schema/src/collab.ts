import { z } from 'zod';
import { Hlc, IsoDate, Sha256Hex, Vec3 } from './common';
import { ActorId, VerificationLevel } from './identity';

/**
 * Assign, comment and approve (M9 stream T3, data-conventions section 18). These exist only as
 * journal ops and their projection: no field is added to `Issue` (older parsers strip unknown
 * keys) or to the strict review records (older parsers refuse them).
 */

/** What a comment, assignment or approval is about. */
export const CollabTargetKind = z.enum([
  'issue',
  'change-item',
  'change-set',
  'detection-pass',
  'part',
  'model',
  'report',
  'project',
]);

/**
 * A target: `id` of the record and, for records inside a file, `in` (the change set id of a change
 * item, the model id of a part). `report` and `project` use the project id.
 */
export const CollabTarget = z.object({
  kind: CollabTargetKind,
  id: z.string().min(1).max(300),
  in: z.string().min(1).max(300).optional(),
});

/** Random ids: a prefix and 16 base32 letters (80 bits). */
export const CommentId = z
  .string()
  .regex(/^cm_[a-z2-7]{16}$/, 'A comment id is cm_ and 16 base32 letters.');
export const ApprovalId = z
  .string()
  .regex(/^ap_[a-z2-7]{16}$/, 'An approval id is ap_ and 16 base32 letters.');

/** `team`: members only. `client`: also shown to the customer (packages, reply files, server). */
export const CommentVisibility = z.enum(['team', 'client']);

/** A camera and time a comment can fly to (Attach view). */
export const SavedView = z.object({
  camera: z.object({
    position: Vec3,
    target: Vec3,
    fovDeg: z.number().positive().max(179).optional(),
  }),
  /** Seconds into a video, or the capture id shown. */
  time: z.number().nonnegative().optional(),
  capture: z.string().min(1).max(128).optional(),
  layer: z.string().min(1).max(128).optional(),
});

/** Markdown-lite text; links shown as text, never fetched. RTL and Arabic allowed. */
export const CommentText = z.string().trim().min(1).max(10_000);

// ---- op payloads ----

/** `comment.add`. */
export const CommentPayload = z.object({
  id: CommentId,
  target: CollabTarget,
  text: CommentText,
  visibility: CommentVisibility.default('team'),
  mentions: z.array(ActorId).max(50).default([]),
  view: SavedView.optional(),
  replyTo: CommentId.optional(),
});
/** `comment.edit`: a new version, by the author only. */
export const CommentEditPayload = z.object({
  id: CommentId,
  text: CommentText,
  mentions: z.array(ActorId).max(50).optional(),
});
/** `comment.delete`: a tombstone, by the author or an owner. */
export const CommentDeletePayload = z.object({ id: CommentId });
/**
 * `comment.redact`: an owner removes the text of every version. `ops` names the `comment.add` and
 * `comment.edit` ops whose payloads are removed (as `op.redact` does for one op), so Verify accepts
 * the missing payloads and the chain still verifies.
 */
export const CommentRedactPayload = z.object({
  id: CommentId,
  ops: z.array(Sha256Hex).min(1).max(100),
  reason: z.string().max(500).optional(),
});

/** `assign.set`: `assignee: null` clears it. */
export const AssignPayload = z.object({
  target: CollabTarget,
  assignee: ActorId.nullable(),
  due: IsoDate.optional(),
  note: z.string().max(2000).optional(),
});

/** `accept` is a client's acceptance; it is recorded and never changes a status by itself. */
export const ApprovalDecision = z.enum(['approve', 'changes-requested', 'accept']);

/** `approval.add`. Counts only while the target's material content hash equals `contentHash`. */
export const ApprovalPayload = z
  .object({
    id: ApprovalId,
    target: CollabTarget,
    decision: ApprovalDecision,
    contentHash: Sha256Hex,
    comment: z.string().max(10_000).optional(),
  })
  .refine((p) => p.decision !== 'changes-requested' || (p.comment ?? '').trim() !== '', {
    message: 'Request changes needs a comment.',
    path: ['comment'],
  });
/** `approval.withdraw`: by the same actor only. */
export const ApprovalWithdrawPayload = z.object({ id: ApprovalId });

/** Issue fields whose change voids approvals (decision 6). Title and note are recorded only. */
export const MaterialField = z.enum([
  'class',
  'severity',
  'sightings',
  'measurements',
  'status',
  'title',
  'note',
]);

/**
 * The approval rules of a team project (decision 6). Every number and switch has a default, so the
 * founder's choice changes a default, never a record. `policy.set` ops carry a partial policy.
 */
export const ApprovalPolicy = z.object({
  /** Distinct eligible approvals needed for `approved`. */
  required: z.number().int().min(1).max(5).default(1),
  /** The issue's creator does not count towards `required`. */
  fourEyes: z.boolean().default(true),
  /** Who may close or reopen an approved issue. */
  closeBy: z.enum(['owner', 'owner-or-reviewer']).default('owner'),
  viewersMayComment: z.boolean().default(false),
  /** `record`: client acceptance is kept and shown; `off`: reply files may not carry it. */
  clientAcceptance: z.enum(['record', 'off']).default('record'),
  /** Changing one of these after approval voids the approvals and returns the status to reviewed. */
  materialFields: z
    .array(MaterialField)
    .default(['class', 'severity', 'sightings', 'measurements', 'status']),
});

/**
 * The team-wide policy (`policy.set`, owner only). Defaults are the recommended founder decisions:
 * self-asserted identities accepted (decision 5), journal always on for team projects (decision 8).
 */
export const TeamPolicy = z.object({
  approval: ApprovalPolicy.default(ApprovalPolicy.parse({})),
  /** Lowest verification a member needs before their ops count (decision 5). */
  minVerification: VerificationLevel.default('self'),
  /** What a customer package carries by default: the signed audit summary (decision 8). */
  packageHistory: z.enum(['summary', 'full']).default('summary'),
});

/** `policy.set` payload: the fields to change. */
export const PolicySetPayload = z.object({
  approval: ApprovalPolicy.partial().optional(),
  minVerification: VerificationLevel.optional(),
  packageHistory: z.enum(['summary', 'full']).optional(),
});

export const DEFAULT_APPROVAL_POLICY = ApprovalPolicy.parse({});
export const DEFAULT_TEAM_POLICY = TeamPolicy.parse({});

// ---- projection (collab:read) ----

export const CommentView = z.object({
  id: CommentId,
  target: CollabTarget,
  author: ActorId,
  /** Null when deleted or redacted. */
  text: z.string().nullable(),
  visibility: CommentVisibility,
  mentions: z.array(ActorId),
  view: SavedView.optional(),
  replyTo: CommentId.optional(),
  createdAt: Hlc,
  editedAt: Hlc.optional(),
  versions: z.number().int().min(1),
  deleted: z.boolean(),
  redacted: z.object({ by: ActorId, at: Hlc }).optional(),
});

export const AssignmentView = z.object({
  target: CollabTarget,
  assignee: ActorId,
  due: IsoDate.optional(),
  note: z.string().optional(),
  by: ActorId,
  at: Hlc,
});

export const ApprovalView = z.object({
  id: ApprovalId,
  target: CollabTarget,
  by: ActorId,
  decision: ApprovalDecision,
  contentHash: Sha256Hex,
  comment: z.string().optional(),
  at: Hlc,
  withdrawn: z.boolean(),
  /** The target's material content still equals the signed hash. */
  current: z.boolean(),
});

/** Everything collaborative about a project, rebuilt from the journal (never stored as truth). */
export const CollabState = z.object({
  comments: z.array(CommentView),
  assignments: z.array(AssignmentView),
  approvals: z.array(ApprovalView),
  /** Null for a project that is not shared: free status stepping as in 0.8. */
  policy: TeamPolicy.nullable(),
});

export type CollabTargetKind = z.infer<typeof CollabTargetKind>;
export type CollabTarget = z.infer<typeof CollabTarget>;
export type CommentId = z.infer<typeof CommentId>;
export type ApprovalId = z.infer<typeof ApprovalId>;
export type CommentVisibility = z.infer<typeof CommentVisibility>;
export type SavedView = z.infer<typeof SavedView>;
export type CommentPayload = z.infer<typeof CommentPayload>;
export type AssignPayload = z.infer<typeof AssignPayload>;
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
export type ApprovalPayload = z.infer<typeof ApprovalPayload>;
export type MaterialField = z.infer<typeof MaterialField>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;
export type TeamPolicy = z.infer<typeof TeamPolicy>;
export type CommentView = z.infer<typeof CommentView>;
export type AssignmentView = z.infer<typeof AssignmentView>;
export type ApprovalView = z.infer<typeof ApprovalView>;
export type CollabState = z.infer<typeof CollabState>;

/** A stable key for a target (maps, file names): `kind:in:id`. */
export function targetKey(t: CollabTarget): string {
  return `${t.kind}:${t.in ?? ''}:${t.id}`;
}
