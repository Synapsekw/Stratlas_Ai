import { z } from 'zod';
import type { TeamPolicy } from './collab';
import { IsoTime, PublicKeyB64, SignatureB64 } from './common';

/**
 * People and devices (M9 stream T2, data-conventions section 17). An actor is a person, stable for
 * life; a device is one Ed25519 key pair on one machine. The private key lives only in the OS vault
 * (account `device-signing`); everything here is public.
 */

export const IDENTITY_SCHEMA = 'aio.identity/1' as const;
export const DEVICE_SCHEMA = 'aio.device/1' as const;
export const IDENTITY_CARD_SCHEMA = 'aio.idcard/1' as const;

/** userData file of this person's identity. */
export const IDENTITY_FILE = 'identity.json';
/** File extension of an identity card (how a person joins a team in file mode). */
export const IDENTITY_CARD_EXTENSION = '.aioid';
/** Vault account of the device signing key (never written anywhere else). */
export const DEVICE_KEY_ACCOUNT = 'device-signing';

/** `a_` plus 128 random bits in base32 (26 characters). Never changes; M10 links accounts to it. */
export const ActorId = z
  .string()
  .regex(/^a_[a-z2-7]{26}$/, 'An actor id is a_ and 26 base32 letters.');

/** `d_` plus the base32 SHA-256 of the raw public key (52 characters): cannot be claimed with another key. */
export const DeviceId = z
  .string()
  .regex(/^d_[a-z2-7]{52}$/, 'A device id is d_ and 52 base32 letters.');

/** Display name: what `Issue.author` and the other free-text author fields keep receiving. */
export const PersonName = z.string().trim().min(1).max(80);

/**
 * Initials: up to 3 letters (any script, Arabic included) and an optional digit that keeps them
 * unique within a team ("DR", "DR2").
 */
export const Initials = z
  .string()
  .regex(/^\p{L}{1,3}\d?$/u, 'Initials are 1 to 3 letters, optionally followed by one digit.');

/** Email is optional and only ever shown; fictional addresses in tests end in `@example.com`. */
export const Email = z.email().max(254);

/**
 * How far a member's identity is proven (decision 5), shown as a badge. `self` is accepted by
 * default; `TeamPolicy.minVerification` can require more without changing any record.
 */
export const VerificationLevel = z.enum(['self', 'owner', 'server', 'account']);
export const VERIFICATION_ORDER = VerificationLevel.options;

/** `userData/identity.json`: this person. Moved once from the renderer's `stratlas.author`. */
export const Identity = z.object({
  schema: z.literal(IDENTITY_SCHEMA),
  actor: ActorId,
  name: PersonName,
  initials: Initials,
  email: Email.optional(),
  createdAt: IsoTime,
  /** Where the name came from on first start: the old free-text author, or the OS account. */
  migratedFrom: z.enum(['author-setting', 'os-account', 'new']).optional(),
});

/** The app that made a record: name from `@aio/brand`, never hard-coded. */
export const AppStamp = z.object({
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
});

/**
 * A certificate one device gives another: "this device belongs to this actor" (and, from an owner,
 * the role). Signed with domain `aio.cert/1` over the hash of the certificate without `sig`.
 */
export const DeviceCert = z.object({
  /** Who certifies: an owner's device, a team server, or (M10) the account issuer. */
  level: VerificationLevel.exclude(['self']),
  issuer: z.object({ actor: ActorId.optional(), device: z.string().min(1).max(128) }),
  actor: ActorId,
  device: DeviceId,
  issuedAt: IsoTime,
  expiresAt: IsoTime.optional(),
  sig: SignatureB64,
});

/**
 * `<project>/journal/devices/<deviceId>.json`: the public half of a device, self-signed with domain
 * `aio.device/1`. Revocation is an op (`device.revoke`), never an edit of this file.
 */
export const DeviceRecord = z.object({
  schema: z.literal(DEVICE_SCHEMA),
  id: DeviceId,
  alg: z.literal('ed25519'),
  key: PublicKeyB64,
  actor: ActorId,
  name: PersonName,
  initials: Initials,
  /** A label for the machine the person chose ("Site laptop"); absent by default (no host names). */
  label: z.string().max(80).optional(),
  app: AppStamp,
  createdAt: IsoTime,
  certs: z.array(DeviceCert).default([]),
  sig: SignatureB64,
});

/** `.aioid`: name, initials, actor and device key, self-signed (domain `aio.idcard/1`). */
export const IdentityCard = z.object({
  schema: z.literal(IDENTITY_CARD_SCHEMA),
  actor: ActorId,
  name: PersonName,
  initials: Initials,
  email: Email.optional(),
  device: z.object({ id: DeviceId, alg: z.literal('ed25519'), key: PublicKeyB64 }),
  app: AppStamp,
  createdAt: IsoTime,
  sig: SignatureB64,
});

/** What a person may do in a shared project. A project that is not shared has no roles. */
export const Role = z.enum(['owner', 'reviewer', 'viewer', 'client']);

/**
 * Reserved for M10: a Synapse account linked to an actor by a `member.link` op with a certificate
 * from the account issuer. M9 parses it and does nothing else.
 */
export const AccountLink = z.object({
  actor: ActorId,
  issuer: z.string().min(1).max(200),
  account: z.string().min(1).max(200),
  linkedAt: IsoTime,
  cert: z.string().min(1).max(8192),
});

/** A member as projected from the `member.*` ops (members:list). */
export const Member = z.object({
  actor: ActorId,
  name: PersonName,
  initials: Initials,
  email: Email.optional(),
  role: Role,
  devices: z.array(
    z.object({
      id: DeviceId,
      key: PublicKeyB64,
      revoked: z.boolean(),
      /** HLC of the revocation: ops by this device after it are quarantined. */
      revokedAt: z.string().optional(),
    }),
  ),
  verification: VerificationLevel,
  addedBy: ActorId,
  /** HLC of the `member.add` op. */
  addedAt: z.string(),
  account: AccountLink.optional(),
  /** M9 integration: where the membership comes from (the journal, or a team server's grant). */
  source: z.enum(['journal', 'server']).optional(),
  /** M9 integration: the owner whose certificate verified this member (`verification: owner`). */
  certifiedBy: ActorId.optional(),
});

/** What a role check is about (the roles table of the M9 plan). */
export const Permission = z.enum([
  'read',
  'comment.team',
  'comment.client',
  'accept',
  'edit',
  'assign',
  'approve',
  'close-approved',
  'builder.edit',
  'builder.georef',
  'admin',
  'export.package',
  'export.audit',
  'verify',
]);

/**
 * Who may do what. `policy` names the `TeamPolicy` switch that extends the action to one more role
 * (viewers commenting, reviewers closing approved issues). `client` reads only the shared subset
 * of a customer package, never internal comments or drafts.
 */
export const PERMISSIONS = {
  read: { roles: ['owner', 'reviewer', 'viewer', 'client'] },
  'comment.team': {
    roles: ['owner', 'reviewer'],
    policy: { switch: 'viewersMayComment', adds: 'viewer' },
  },
  'comment.client': { roles: ['owner', 'reviewer', 'client'] },
  accept: { roles: ['owner', 'reviewer', 'client'] },
  edit: { roles: ['owner', 'reviewer'] },
  assign: { roles: ['owner', 'reviewer'] },
  approve: { roles: ['owner', 'reviewer'] },
  'close-approved': { roles: ['owner'], policy: { switch: 'closeBy', adds: 'reviewer' } },
  'builder.edit': { roles: ['owner', 'reviewer'] },
  'builder.georef': { roles: ['owner'] },
  admin: { roles: ['owner'] },
  'export.package': { roles: ['owner', 'reviewer'] },
  'export.audit': { roles: ['owner', 'reviewer', 'viewer'] },
  verify: { roles: ['owner', 'reviewer', 'viewer', 'client'] },
} as const satisfies Record<
  z.infer<typeof Permission>,
  {
    roles: readonly z.infer<typeof Role>[];
    policy?: { switch: 'viewersMayComment' | 'closeBy'; adds: z.infer<typeof Role> };
  }
>;

// ---- role checks (M9 integration: here so the renderer can gate with them) ----

/** Manifest fields only an owner changes (coordinate system, origin, vertical datum). */
export const GEOREF_FIELDS = ['crs', 'origin', 'verticalDatum'] as const;

/** The roles that hold a permission under a team policy (the policy switches add one role). */
export function rolesFor(permission: Permission, policy: TeamPolicy): Role[] {
  const rule: { roles: readonly Role[]; policy?: { switch: string; adds: Role } } =
    PERMISSIONS[permission];
  const roles = [...rule.roles];
  const extra = rule.policy;
  if (extra) {
    const on =
      extra.switch === 'viewersMayComment'
        ? policy.approval.viewersMayComment
        : policy.approval.closeBy === 'owner-or-reviewer';
    if (on && !roles.includes(extra.adds)) roles.push(extra.adds);
  }
  return roles;
}

/** Whether a role holds a permission under a team policy. */
export function permits(role: Role, permission: Permission, policy: TeamPolicy): boolean {
  return rolesFor(permission, policy).includes(role);
}

const ROLE_ARTICLES: Record<Role, string> = {
  owner: 'an owner',
  reviewer: 'a reviewer',
  viewer: 'a viewer',
  client: 'a client',
};

const PERMISSION_ACTIONS: Record<Permission, string> = {
  read: 'open the project',
  'comment.team': 'comment for the team',
  'comment.client': 'comment for the client',
  accept: 'record client acceptance',
  edit: 'edit',
  assign: 'assign work',
  approve: 'approve',
  'close-approved': 'close or reopen an approved issue',
  'builder.edit': 'change layers, imports and pipelines',
  'builder.georef': 'change the coordinate system, origin or datum',
  admin: 'change members, roles, devices and the team policy',
  'export.package': 'export a customer package',
  'export.audit': 'export the audit',
  verify: 'verify the history',
};

function listOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? 'nobody';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

/** "Omar Sample is a viewer in this project. Only an owner or a reviewer can edit." */
export function roleRefusal(
  name: string,
  role: Role,
  permission: Permission,
  policy: TeamPolicy,
): string {
  const who = listOr(rolesFor(permission, policy).map((r) => ROLE_ARTICLES[r]));
  return `${name} is ${ROLE_ARTICLES[role]} in this project. Only ${who} can ${PERMISSION_ACTIONS[permission]}.`;
}

// ---- op payloads of the team kinds (`member.*`, `device.revoke`) ----

export const MemberAddPayload = z.object({
  actor: ActorId,
  name: PersonName,
  initials: Initials,
  email: Email.optional(),
  role: Role,
  devices: z.array(z.object({ id: DeviceId, key: PublicKeyB64 })).min(1),
  /** The owner certificate, when an owner certified the card. */
  cert: DeviceCert.optional(),
});
export const MemberRolePayload = z.object({ actor: ActorId, role: Role });
export const MemberRemovePayload = z.object({ actor: ActorId });
export const MemberLinkPayload = AccountLink;
export const DeviceRevokePayload = z.object({
  device: DeviceId,
  reason: z.string().max(500).optional(),
});

export type ActorId = z.infer<typeof ActorId>;
export type DeviceId = z.infer<typeof DeviceId>;
export type VerificationLevel = z.infer<typeof VerificationLevel>;
export type Identity = z.infer<typeof Identity>;
export type AppStamp = z.infer<typeof AppStamp>;
export type DeviceCert = z.infer<typeof DeviceCert>;
export type DeviceRecord = z.infer<typeof DeviceRecord>;
export type IdentityCard = z.infer<typeof IdentityCard>;
export type Role = z.infer<typeof Role>;
export type AccountLink = z.infer<typeof AccountLink>;
export type Member = z.infer<typeof Member>;
export type Permission = z.infer<typeof Permission>;
export type MemberAddPayload = z.infer<typeof MemberAddPayload>;

/** Is `level` at least `min` on the verification ladder (`self` < `owner` < `server` < `account`). */
export function verifiedAtLeast(level: VerificationLevel, min: VerificationLevel): boolean {
  return VERIFICATION_ORDER.indexOf(level) >= VERIFICATION_ORDER.indexOf(min);
}
