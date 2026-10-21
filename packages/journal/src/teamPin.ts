import { MemberAddPayload, TeamProject, type TeamGenesis } from '@aio/schema';
import { contentHash, deviceIdFromKey } from './hash';
import { pinOf, replayTeam, type TeamPin } from './members';
import type { Signer } from './sign';
import { verifySignature } from './sign';

/**
 * The genesis a copy pins in `team.json` (security review, Oct 2026). The owner's device signs the
 * file when it shares (domain `aio.team/1`); a copy that joined pins what it first saw without a
 * signature (trust on first use, kept locally). A project shared by an older version has no pin
 * until a copy opens it with this version.
 */
export type TeamPinState =
  /** The genesis device signed the pin. */
  | { status: 'signed'; pin: TeamPin; genesis: TeamGenesis }
  /** This copy pinned what it first saw (no signature). */
  | { status: 'local'; pin: TeamPin; genesis: TeamGenesis }
  /** `team.json` pins nothing (shared by an older version). */
  | { status: 'none' }
  /** The pin does not verify (its key is not its device's, or its signature does not match). */
  | { status: 'invalid'; reason: string };

const withoutSig = (team: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(team).filter(([k]) => k !== 'sig'));

/** The pin as the replay takes it. */
export function pinFromGenesis(genesis: TeamGenesis): TeamPin {
  return { op: genesis.op, at: genesis.at, heads: genesis.heads };
}

/** Read the pin of a raw `team.json`. */
export function readTeamPin(raw: unknown): TeamPinState {
  const parsed = TeamProject.safeParse(raw);
  if (!parsed.success) return { status: 'invalid', reason: 'team.json is not readable.' };
  const genesis = parsed.data.genesis;
  if (!genesis) return { status: 'none' };
  let id: string;
  try {
    id = deviceIdFromKey(Buffer.from(genesis.key, 'base64url'));
  } catch {
    id = '';
  }
  if (id !== genesis.device) {
    return { status: 'invalid', reason: 'The key in team.json is not the key of its device.' };
  }
  const sig = parsed.data.sig;
  if (sig === undefined) return { status: 'local', pin: pinFromGenesis(genesis), genesis };
  const ok = verifySignature(
    genesis.key,
    'aio.team/1',
    contentHash(withoutSig(raw as Record<string, unknown>)),
    sig,
  );
  return ok
    ? { status: 'signed', pin: pinFromGenesis(genesis), genesis }
    : {
        status: 'invalid',
        reason: 'The signature on team.json does not match the device that shared the project.',
      };
}

/**
 * The genesis of a history: the op that made the first owner (as the replay finds it with no pin)
 * and the history before it. Null when the history has no team.
 */
export function genesisOf(raws: readonly Record<string, unknown>[]): TeamGenesis | null {
  const replay = replayTeam(raws);
  if (!replay.genesis) return null;
  const pin = pinOf(raws, replay.genesis);
  const op = raws.find((r) => r.id === replay.genesis);
  const card = MemberAddPayload.safeParse(op?.payload);
  const device = card.success ? card.data.devices.find((d) => d.id === op?.dev) : undefined;
  if (!pin || !device) return null;
  return { op: pin.op, device: device.id, key: device.key, at: pin.at, heads: { ...pin.heads } };
}

/**
 * `team.json` with the genesis pinned: signed when `signer` is the genesis device (the owner who
 * shared), else a local pin without `sig`.
 */
export function pinTeamFile(
  team: TeamProject,
  genesis: TeamGenesis,
  signer?: Signer | null,
): TeamProject {
  const body: TeamProject = { ...team, genesis };
  delete body.sig;
  if (signer?.device !== genesis.device) return body;
  return { ...body, sig: signer.sign('aio.team/1', contentHash(body)) };
}
