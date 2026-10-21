import { join } from 'node:path';
import {
  genesisOf,
  pinTeamFile,
  readTeamPin,
  type Signer,
  type TeamPin,
  type TeamPinState,
} from '@aio/journal';
import { TEAM_FILE, TeamProject } from '@aio/schema';
import { readJson, writeJsonAtomic } from './fsutil';

/**
 * The genesis a copy pins in `team.json` (security review, Oct 2026): every place that judges the
 * team (members, quarantine, collab, Verify) reads it here, and sync pins it before it takes in ops
 * from another copy. A project shared by an older version is pinned on first use: the owner's
 * device signs the pin, any other copy keeps an unsigned local pin. Never bricks a project: no
 * team.json, or a team.json this version cannot pin, judges as before (Verify names it).
 */

/** The pin state of a project folder; null when it has no `team.json` (not shared). */
export async function teamPinState(root: string): Promise<TeamPinState | null> {
  const raw = await readJson(join(root, TEAM_FILE)).catch(() => undefined);
  if (raw === undefined) return null;
  return readTeamPin(raw);
}

/** The pin to judge the team with (signed or local), or null. */
export async function teamPinOf(root: string): Promise<TeamPin | null> {
  const s = await teamPinState(root);
  return s && (s.status === 'signed' || s.status === 'local') ? s.pin : null;
}

/**
 * Pin the genesis of `ops` in `team.json` when it pins nothing yet (trust on first use), signed
 * when `signer` is the device that shared. Call it before ops from another copy are taken in.
 * Returns the state after.
 */
export async function ensureTeamPin(
  root: string,
  ops: readonly Record<string, unknown>[],
  signer?: Signer | null,
): Promise<TeamPinState | null> {
  const file = join(root, TEAM_FILE);
  const raw = await readJson(file).catch(() => undefined);
  if (raw === undefined) return null;
  const state = readTeamPin(raw);
  if (state.status !== 'none') return state;
  const team = TeamProject.safeParse(raw);
  const genesis = genesisOf(ops);
  if (!team.success || !genesis) return state;
  await writeJsonAtomic(file, pinTeamFile(team.data, genesis, signer));
  return teamPinState(root);
}

/**
 * A `team.json` from a hub folder or a sender, before this copy keeps it: its pin only when the
 * genesis device signed it (a hub folder is writable by anyone with access), else none (this copy
 * pins on first use).
 */
export function trustedTeamFile(team: TeamProject): TeamProject {
  if (readTeamPin(team).status === 'signed') return team;
  return {
    schema: team.schema,
    teamProjectId: team.teamProjectId,
    name: team.name,
    createdAt: team.createdAt,
    createdBy: team.createdBy,
  };
}
