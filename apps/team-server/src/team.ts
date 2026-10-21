/**
 * One team project as the server holds it, judged with the journal's own team logic (`@aio/journal`
 * `judgeOp`, `orderForTeam`, `teamFences`), so the server reaches the verdict every app reaches on
 * the same ops (security review 2026-10-21; this replaces the server's own replay). The team is the
 * replay of the stored team ops in team order: clock order, except that an op a revocation,
 * removal or demotion (or the pinned genesis) had not seen and that is dated before it is judged
 * right after it.
 *
 * What only the server adds: the genesis pin is taken from the first history the project's
 * creator pushed (trust on first use, on the server), the project's blobs (`blob.add`), each
 * chain's last clock reading, and the device that shared the project.
 */
import {
  clockGoesBack,
  emptyTeam,
  isShared,
  isTeamKind,
  judgeOp,
  membersOf,
  orderForTeam,
  pinOf,
  teamFences,
  type RefusalCode as TeamRefusalCode,
  type TeamPin,
  type TeamState,
  type Verdict,
} from '@aio/journal';
import { BlobAddPayload, type Member, type Op, type RefusalCode, type Role } from '@aio/schema';

/** The journal's refusal codes as `aio.sync/1` names them (as the desktop's quarantine does). */
export const REFUSAL_CODES: Record<TeamRefusalCode, RefusalCode> = {
  'not-member': 'non-member',
  'unknown-device': 'non-member',
  role: 'role',
  verification: 'role',
  'last-owner': 'role',
  'bad-certificate': 'role',
  'revoked-device': 'revoked',
  'clock-back': 'chain',
  unsigned: 'signature',
  'bad-signature': 'signature',
  edited: 'hash',
  invalid: 'schema',
};

interface Entry {
  op: Op;
  raw: Record<string, unknown>;
}

export class ProjectTeam {
  /** The stored team ops, in arrival order. */
  private readonly teamOps: Entry[] = [];
  /** Every stored op's clock reading (a chain's predecessor may be any kind). */
  private readonly clocks = new Map<string, string>();
  private readonly chainClock = new Map<string, string>();
  private readonly blobs = new Set<string>();
  private readonly sharedBy = new Map<string, string>();
  private current: TeamState;

  constructor(private pinned: TeamPin | null = null) {
    this.current = emptyTeam(pinned);
  }

  get pin(): TeamPin | null {
    return this.pinned;
  }

  /** Pin the genesis (once): from now on only that op makes the first owner. */
  setPin(pin: TeamPin): void {
    this.pinned = pin;
    this.current = this.replay([]).state;
  }

  /** Take in stored ops (arrival order), then replay the team once. */
  add(ops: readonly Op[]): void {
    for (const op of ops) this.take(op);
    this.current = this.replay([]).state;
  }

  private take(op: Op): void {
    this.clocks.set(op.id, op.hlc);
    this.chainClock.set(op.chain, op.hlc);
    if (op.kind === 'blob.add') {
      const p = BlobAddPayload.safeParse(op.payload);
      if (p.success) this.blobs.add(p.data.sha256);
    }
    if (op.kind === 'project.share' && this.sharedBy.size === 0) this.sharedBy.set(op.dev, op.act);
    if (isTeamKind(op.kind)) this.teamOps.push({ op, raw: op });
  }

  /**
   * Judge new ops against the stored ones, exactly as an app judges the union: the team order of
   * the stored team ops and the candidates, each candidate judged against the team at its place.
   */
  replay(candidates: readonly Entry[]): { state: TeamState; verdicts: Map<string, Verdict> } {
    const clocks = new Map(this.clocks);
    for (const c of candidates) clocks.set(c.op.id, c.op.hlc);
    const team = [...this.teamOps, ...candidates.filter((c) => isTeamKind(c.op.kind))];
    // the clock readings of the team ops' predecessors, for the clock-back check of the replay
    const stubs: Record<string, unknown>[] = [];
    for (const { op } of team) {
      const hlc = op.prev === null ? undefined : clocks.get(op.prev);
      if (op.prev !== null && hlc !== undefined) stubs.push({ id: op.prev, hlc });
    }
    const fences = teamFences([...stubs, ...team.map((e) => e.raw)], this.pinned);
    const fresh = new Set(candidates.map((c) => c.op.id));
    const all = [...this.teamOps, ...candidates];
    let state = emptyTeam(this.pinned);
    const verdicts = new Map<string, Verdict>();
    for (const { op, raw } of orderForTeam(all, (e) => e.op, fences)) {
      const back = clockGoesBack(op, op.prev === null ? undefined : clocks.get(op.prev));
      const step = back ? { verdict: back, state } : judgeOp(state, op, raw);
      state = step.state;
      if (fresh.has(op.id)) verdicts.set(op.id, step.verdict);
    }
    return { state, verdicts };
  }

  /** The genesis the stored history has (the op that made the first owner), for a first pin. */
  genesisPin(raws: readonly Record<string, unknown>[]): TeamPin | null {
    if (this.pinned || !isShared(this.current)) return null;
    let state = emptyTeam(null);
    for (const { op, raw } of orderForTeam(this.teamOps, (e) => e.op, [])) {
      const step = judgeOp(state, op, raw);
      if (!isShared(state) && isShared(step.state)) return pinOf(raws, op.id);
      state = step.state;
    }
    return null;
  }

  get shared(): boolean {
    return isShared(this.current);
  }

  /** The device a member op names, and whose it is. */
  deviceKey(device: string): { actor: string; key: string } | null {
    const d = this.current.devices.get(device);
    return d ? { actor: d.actor, key: d.key } : null;
  }

  /** Does the project bind this device to this actor (a member op, or the share itself)? */
  binds(actor: string, device: string): boolean {
    return this.deviceKey(device)?.actor === actor || this.sharedBy.get(device) === actor;
  }

  /** Does the journal name this actor at all (removed members too)? */
  inJournal(actor: string): boolean {
    return this.current.members.has(actor);
  }

  /** The actor's role now; null when not a member (or removed). */
  roleNow(actor: string): Role | null {
    const m = this.current.members.get(actor);
    return m && !m.removed ? m.role : null;
  }

  /** The clock reading at which the journal revoked a device; null when it did not. */
  revokedAt(device: string): string | null {
    return this.current.devices.get(device)?.revokedAt ?? null;
  }

  /** The clock reading of a chain's last stored op; null for a new chain. */
  clockOf(chain: string): string | null {
    return this.chainClock.get(chain) ?? null;
  }

  hasBlob(sha256: string): boolean {
    return this.blobs.has(sha256);
  }

  members(): Member[] {
    return membersOf(this.current);
  }
}
