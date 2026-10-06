import { z } from 'zod';
import { Hlc, IsoTime, PublicKeyB64, Sha256Hex, SignatureB64 } from './common';
import { CollabTarget } from './collab';
import { ActorId, AppStamp, DeviceId, Initials, PersonName } from './identity';
import { ChainId, OpId, Seq } from './journal';

/**
 * Exchange files and hub folders (M9 stream T5, data-conventions section 19): moving ops and
 * blobs between copies with no server, by USB, mail or a shared folder.
 */

export const TEAM_SCHEMA = 'aio.team/1' as const;
export const EXCHANGE_SCHEMA = 'aio.exchange/1' as const;
export const HUB_SCHEMA = 'aio.hub/1' as const;
export const PRESENCE_SCHEMA = 'aio.presence/1' as const;

/** `<project>/team.json`, only when the project is shared. Older builds ignore it. */
export const TEAM_FILE = 'team.json';
/** File extension of an exchange file (patch, bundle or reply). */
export const EXCHANGE_EXTENSION = '.aiosync';
/** Member of an exchange file that holds its signed header. */
export const EXCHANGE_HEADER_FILE = 'aio-exchange.json';
/** File at the root of a hub folder (brand-neutral, like `aio-package.json`). */
export const HUB_FILE = 'aio-hub.json';
/** A presence file older than this is ignored ("Rana has F03 open" is advisory). */
export const PRESENCE_TTL_MS = 2 * 60 * 1000;

/** `t_` plus 128 random bits in base32: one team project, the same in every copy. */
export const TeamProjectId = z
  .string()
  .regex(/^t_[a-z2-7]{26}$/, 'A team project id is t_ and 26 base32 letters.');

/** `<project>/team.json` (`aio.team/1`). */
export const TeamProject = z.object({
  schema: z.literal(TEAM_SCHEMA),
  teamProjectId: TeamProjectId,
  name: z.string().min(1).max(200),
  createdAt: IsoTime,
  createdBy: ActorId,
});

/** The heads of a set of chains: what a copy has, or what it knew of a peer. */
export const Heads = z.record(ChainId, z.object({ seq: Seq, id: OpId }));

/** `patch`: ops only; `bundle`: ops plus the blobs the recipient lacks; `reply`: a client's answer. */
export const ExchangeKind = z.enum(['patch', 'bundle', 'reply']);

/** `x_` plus 80 random bits: an exchange file, so a second import says "already applied". */
export const ExchangeId = z
  .string()
  .regex(/^x_[a-z2-7]{16}$/, 'An exchange id is x_ and 16 base32 letters.');

/**
 * `aio-exchange.json` inside a `.aiosync` (ZIP64, store mode, optional AES-256), signed by the
 * sender's device (domain `aio.exchange/1`) over the canonical header without `sig`. Members:
 * `journal/devices/<device>.json`, `journal/ops/<chain>/<from>-<to>.jsonl`, `blobs/<aa>/<sha256>`.
 */
export const ExchangeHeader = z.looseObject({
  schema: z.literal(EXCHANGE_SCHEMA),
  id: ExchangeId,
  kind: ExchangeKind,
  teamProjectId: TeamProjectId,
  createdAt: IsoTime,
  from: z.object({ actor: ActorId, device: DeviceId, name: PersonName, app: AppStamp }),
  /** Intended recipients (advisory: anyone with the file and passphrase can import it). */
  to: z
    .object({ actors: z.array(ActorId).optional(), note: z.string().max(500).optional() })
    .optional(),
  /** What the sender assumed the recipient had: their heads, or a date. */
  since: z.union([
    z.object({ heads: Heads }),
    z.object({ date: IsoTime }),
    z.object({ all: z.literal(true) }),
  ]),
  /** Op ranges carried per chain (`from` to `to` inclusive). */
  chains: z.array(z.object({ chain: ChainId, from: Seq, to: Seq, member: z.string().min(1) })),
  /** Heads of the sender after these ops. */
  heads: Heads,
  blobs: z.array(z.object({ sha256: Sha256Hex, size: z.number().int().nonnegative() })).default([]),
  counts: z.object({
    ops: z.number().int().nonnegative(),
    devices: z.number().int().nonnegative(),
    blobs: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  /** A reply: the customer package it answers (its header's project id and export time). */
  package: z.object({ projectId: z.string().min(1), createdAt: IsoTime }).optional(),
  encrypted: z.boolean(),
  sig: SignatureB64,
});

/** Formatting of op chunk members and hub files: `<from>-<to>.jsonl`, six digits each. */
export function opChunkName(from: number, to: number): string {
  const six = (n: number) => String(n).padStart(6, '0');
  return `${six(from)}-${six(to)}.jsonl`;
}

/** What import shows before anything is applied (exchange:preview). */
export const ExchangePreview = z.object({
  file: z.string(),
  header: ExchangeHeader,
  signature: z.enum(['valid', 'invalid', 'unknown-device', 'revoked-device']),
  sender: z.object({ name: z.string(), initials: z.string().optional(), member: z.boolean() }),
  /** Ops by kind (`comment.add: 3`). */
  byKind: z.record(z.string(), z.number().int().nonnegative()),
  newOps: z.number().int().nonnegative(),
  alreadyHave: z.number().int().nonnegative(),
  /** Ops after a gap, held until the missing ones arrive ("needs changes from <device> up to #N"). */
  held: z.array(z.object({ chain: ChainId, device: DeviceId, upTo: Seq })),
  expectedConflicts: z.number().int().nonnegative(),
  blobs: z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
  }),
  alreadyApplied: z.boolean(),
  problems: z.array(z.string()),
});

/** `aio-hub.json` at the root of a hub folder (`aio.hub/1`). */
export const HubFile = z.looseObject({
  schema: z.literal(HUB_SCHEMA),
  id: z.string().regex(/^h_[a-z2-7]{16}$/),
  createdAt: IsoTime,
  /** Project folders live under `projects/<teamProjectId>/`. */
  projects: z.array(z.object({ teamProjectId: TeamProjectId, name: z.string() })).default([]),
});

/** Hub layout, relative to the hub root. Each device writes only its own files that never change. */
export const HUB_PATHS = {
  project: (team: string) => `projects/${team}`,
  devices: (team: string) => `projects/${team}/devices`,
  ops: (team: string, chain: string) => `projects/${team}/ops/${chain}`,
  blobs: (team: string) => `projects/${team}/blobs`,
  presence: (team: string, device: string) => `projects/${team}/presence/${device}.json`,
} as const;

/** `presence/<device>.json`: a heartbeat; advisory only. */
export const Presence = z.object({
  schema: z.literal(PRESENCE_SCHEMA),
  device: DeviceId,
  actor: ActorId,
  name: PersonName,
  initials: Initials,
  at: IsoTime,
  hlc: Hlc.optional(),
  open: CollabTarget.optional(),
});

/** What a customer package allows its holder to send back (`PackageHeader.reply`). */
export const PackageReplyPolicy = z.object({
  teamProjectId: TeamProjectId,
  /** The owner device key reply files are addressed to. */
  ownerKey: PublicKeyB64,
  comments: z.boolean(),
  acceptance: z.boolean(),
});

export type TeamProjectId = z.infer<typeof TeamProjectId>;
export type TeamProject = z.infer<typeof TeamProject>;
export type Heads = z.infer<typeof Heads>;
export type ExchangeKind = z.infer<typeof ExchangeKind>;
export type ExchangeHeader = z.infer<typeof ExchangeHeader>;
export type ExchangePreview = z.infer<typeof ExchangePreview>;
export type HubFile = z.infer<typeof HubFile>;
export type Presence = z.infer<typeof Presence>;
export type PackageReplyPolicy = z.infer<typeof PackageReplyPolicy>;
