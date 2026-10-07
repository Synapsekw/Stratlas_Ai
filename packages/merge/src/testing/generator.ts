/**
 * Seeded multi-actor histories for tests, benches and the team demo (M9 T4). Everything is
 * synthetic: fictional people (`*@example.com`), TEST-ONLY keys derived from a fixed text, made-up
 * issues on a made-up site. Never use these keys outside tests.
 */
import {
  base32,
  contentHash,
  createClock,
  sealOp,
  sha256Hex,
  signerFromSeed,
  type Signer,
} from '@aio/journal';
import type { Op } from '@aio/schema';
import { compareOps } from '../causal';

/** A small, fast, seeded random source (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  ['Rana Example', 'RE'],
  ['Omar Sample', 'OS'],
  ['Lina Test', 'LT'],
  ['Sami Example', 'SE'],
  ['Huda Sample', 'HS'],
  ['Karim Test', 'KT'],
] as const;

export interface SimPerson {
  name: string;
  initials: string;
  email: string;
  actor: string;
  device: string;
  chain: string;
  signer: Signer;
}

interface ReplicaState {
  known: Map<string, Op>;
  heads: Map<string, { seq: number; id: string }>;
  clock: ReturnType<typeof createClock>;
  seq: number;
  prev: string | null;
}

/** TEST-ONLY: a deterministic Ed25519 seed for simulated person `i`. */
export function testOnlySeed(i: number): string {
  return sha256Hex(`stratlas TEST-ONLY merge generator person ${i}`);
}

export interface TeamSimOptions {
  /** How many fictional people, one device and one replica each (max 6). */
  people?: number;
  /** Wall time at the start (ms). */
  start?: number;
  /** Clock offset per person (ms), to plant skew. */
  skewMs?: readonly number[];
  /** Sign ops (slower); unsigned ops are still hash-chained. */
  sign?: boolean;
}

/**
 * Simulated team: each person writes ops on their own chain with their own clock, and copies
 * ops to others by `sync`. `deps` carry the heads of the other chains a person has seen, as the
 * journal does, so the merge engine can tell concurrent writes from later ones.
 */
export class TeamSim {
  readonly people: SimPerson[];
  private readonly replicas: ReplicaState[];
  private wall: number;
  private readonly sign: boolean;

  constructor(opts: TeamSimOptions = {}) {
    const n = Math.min(opts.people ?? 3, NAMES.length);
    this.wall = opts.start ?? 1_790_000_000_000;
    this.sign = opts.sign ?? false;
    this.people = [];
    this.replicas = [];
    for (let i = 0; i < n; i += 1) {
      const [name, initials] = NAMES[i] ?? NAMES[0];
      const signer = signerFromSeed(testOnlySeed(i));
      const replica = `r_${base32(Buffer.from(sha256Hex(`replica ${i}`), 'hex')).slice(0, 16)}`;
      const actor = `a_${base32(Buffer.from(sha256Hex(`actor ${i}`), 'hex')).slice(0, 26)}`;
      this.people.push({
        name,
        initials,
        email: `${name.split(' ')[0]?.toLowerCase() ?? 'person'}@example.com`,
        actor,
        device: signer.device,
        chain: `${signer.device}.${replica}`,
        signer,
      });
      const skew = opts.skewMs?.[i] ?? 0;
      this.replicas.push({
        known: new Map(),
        heads: new Map(),
        clock: createClock(signer.device, () => this.wall + skew),
        seq: 0,
        prev: null,
      });
    }
  }

  /** Move the shared wall clock on. */
  advance(ms = 1000): void {
    this.wall += ms;
  }

  person(i: number): SimPerson {
    const p = this.people[i];
    if (!p) throw new Error(`No person ${i}`);
    return p;
  }

  private replica(i: number): ReplicaState {
    const r = this.replicas[i];
    if (!r) throw new Error(`No replica ${i}`);
    return r;
  }

  /** Person `who` writes an op now. */
  write(
    who: number,
    kind: string,
    target: Op['target'],
    payload: unknown,
    extra: { label?: string; via?: Op['via'] } = {},
  ): Op {
    const p = this.person(who);
    const r = this.replica(who);
    this.advance(1);
    r.seq += 1;
    const deps: Record<string, string> = {};
    for (const [chain, head] of [...r.heads].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (chain !== p.chain) deps[chain] = head.id;
    }
    const unsealed = {
      v: 1 as const,
      chain: p.chain,
      dev: p.device,
      act: p.actor,
      seq: r.seq,
      hlc: r.clock.tick(),
      prev: r.prev,
      ...(Object.keys(deps).length > 0 ? { deps } : {}),
      kind,
      target,
      ...(extra.label ? { label: extra.label } : {}),
      ...(extra.via ? { via: extra.via } : {}),
    };
    const op = sealOp(unsealed, payload, this.sign ? p.signer : undefined);
    r.prev = op.id;
    this.learn(r, op);
    return op;
  }

  private learn(r: ReplicaState, op: Op): void {
    r.known.set(op.id, op);
    const head = r.heads.get(op.chain);
    if (!head || op.seq > head.seq) r.heads.set(op.chain, { seq: op.seq, id: op.id });
  }

  /** Copy to `to` every op `from` holds (or of the given chains only). Returns how many were new. */
  sync(from: number, to: number, chains?: readonly string[]): number {
    const src = this.replica(from);
    const dst = this.replica(to);
    const fresh = [...src.known.values()]
      .filter((op) => !dst.known.has(op.id) && (!chains || chains.includes(op.chain)))
      .sort((a, b) => (a.chain === b.chain ? a.seq - b.seq : compareOps(a, b)));
    for (const op of fresh) {
      dst.clock.receive(op.hlc);
      this.learn(dst, op);
    }
    return fresh.length;
  }

  /** Everyone gets everything. */
  syncAll(): void {
    for (let i = 0; i < this.people.length; i += 1) {
      for (let j = 0; j < this.people.length; j += 1) if (i !== j) this.sync(i, j);
    }
    for (let i = 1; i < this.people.length; i += 1) this.sync(0, i);
  }

  /** The ops person `who` holds. */
  known(who: number): Op[] {
    return [...this.replica(who).known.values()];
  }

  /** Every op written by anyone. */
  all(): Op[] {
    const out = new Map<string, Op>();
    for (const r of this.replicas) for (const [id, op] of r.known) out.set(id, op);
    return [...out.values()];
  }
}

// ---- synthetic records ----

export function sighting(photo: number, x = 100, y = 80): Record<string, unknown> {
  return {
    on: 'image',
    layer: 'photos',
    photo: `p_${String(photo).padStart(4, '0')}`,
    geom: { type: 'box', x, y, w: 64, h: 48 },
  };
}

export function issueRecord(
  id: string,
  code: string,
  author: string,
  at: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    code,
    classId: 'corrosion',
    severityModelId: 'sev-5',
    severity: 2,
    status: 'draft',
    title: `Defect ${code}`,
    note: '',
    author,
    createdAt: at,
    updatedAt: at,
    sightings: [sighting(1)],
    source: 'human',
    ...extra,
  };
}

export const sightingHash = (s: unknown): string => contentHash(s);

const iso = (ms: number) => new Date(ms).toISOString();

export interface RandomHistoryOptions extends TeamSimOptions {
  seed: number;
  /** Ops to write in total. */
  steps?: number;
  /** Chance of a sync between two people after each step. */
  syncChance?: number;
  /** Everyone syncs at the end (default true). */
  settle?: boolean;
}

/**
 * A random history over issues, comments, assignments, approvals, change items, detections and
 * model parts, with concurrent edits, deletes against edits, colliding codes and partial syncs.
 */
export function randomHistory(opts: RandomHistoryOptions): { sim: TeamSim; ops: Op[] } {
  const rnd = seededRandom(opts.seed);
  const sim = new TeamSim(opts);
  const n = sim.people.length;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  // what each person knows about (a cheap local model, enough to write sensible ops)
  const issues: Set<string>[] = sim.people.map(() => new Set());
  const sightings = new Map<string, Set<string>>();
  const comments = sim.people.map(() => new Map<string, string>());
  const approvals = sim.people.map(() => new Map<string, string>());
  let nextIssue = 0;
  let nextCode = 1;
  const steps = opts.steps ?? 60;
  const refresh = (who: number) => {
    for (const op of sim.known(who)) {
      if (op.kind === 'issue.create') issues[who]?.add(op.target.id);
      if (op.kind === 'comment.add') {
        const p = op.payload as { id: string };
        comments[who]?.set(p.id, op.act);
      }
      if (op.kind === 'approval.add') {
        const p = op.payload as { id: string };
        approvals[who]?.set(p.id, op.act);
      }
    }
  };
  const id16 = (prefix: string, k: number) =>
    `${prefix}${base32(Buffer.from(sha256Hex(`${prefix}${opts.seed}.${k}`), 'hex')).slice(0, 16)}`;
  let counter = 0;

  for (let s = 0; s < steps; s += 1) {
    const who = Math.floor(rnd() * n);
    const me = sim.person(who);
    sim.advance(Math.floor(rnd() * 5000));
    const mine = [...(issues[who] ?? [])].sort();
    const roll = rnd();
    const at = iso(1_790_000_000_000 + s * 1000);
    if (mine.length === 0 || roll < 0.12) {
      const id = `i_${String(nextIssue).padStart(4, '0')}`;
      nextIssue += 1;
      // codes collide on purpose now and then (two people making issues while apart)
      const code = `F${String(rnd() < 0.3 ? Math.max(1, nextCode - 1) : nextCode).padStart(2, '0')}`;
      nextCode += 1;
      sim.write(
        who,
        'issue.create',
        { rec: 'issue', id },
        { record: issueRecord(id, code, me.name, at) },
      );
      issues[who]?.add(id);
      sightings.set(id, new Set([sightingHash(sighting(1))]));
    } else {
      const issue = pick(mine);
      const target = { rec: 'issue', id: issue };
      const ctarget = { kind: 'issue' as const, id: issue };
      if (roll < 0.35) {
        const field = pick(['severity', 'title', 'note', 'class'] as const);
        const set: Record<string, unknown> =
          field === 'severity'
            ? { severity: 1 + Math.floor(rnd() * 5), updatedAt: at }
            : field === 'class'
              ? {
                  classId: pick(['corrosion', 'crack', 'leak']),
                  severityModelId: 'sev-5',
                  updatedAt: at,
                }
              : { [field]: `${field} ${Math.floor(rnd() * 4)}`, updatedAt: at };
        sim.write(who, 'issue.patch', target, { set });
      } else if (roll < 0.45) {
        const sg = sighting(2 + Math.floor(rnd() * 6), Math.floor(rnd() * 3) * 10);
        const hash = sightingHash(sg);
        sim.write(who, 'issue.sighting.add', target, { hash, sighting: sg });
        sightings.get(issue)?.add(hash);
      } else if (roll < 0.5) {
        const known = [...(sightings.get(issue) ?? [])].sort();
        if (known.length > 1)
          sim.write(who, 'issue.sighting.remove', target, { hash: pick(known) });
      } else if (roll < 0.57) {
        const to = pick(['draft', 'reviewed', 'approved', 'closed']);
        sim.write(who, 'issue.status', target, { from: 'draft', to });
      } else if (roll < 0.61) {
        sim.write(who, 'issue.delete', target, {});
      } else if (roll < 0.62) {
        sim.write(who, 'issue.restore', target, {
          record: issueRecord(issue, 'F01', me.name, at, { title: 'Restored' }),
        });
      } else if (roll < 0.64) {
        const into = mine.find((x) => x !== issue);
        if (into !== undefined) sim.write(who, 'issue.merge', target, { into });
      } else if (roll < 0.7) {
        counter += 1;
        const id = id16('cm_', counter);
        sim.write(who, 'comment.add', target, {
          id,
          target: ctarget,
          text: `Note ${counter} from ${me.initials}`,
          visibility: 'team',
          mentions: [],
        });
        comments[who]?.set(id, me.actor);
      } else if (roll < 0.74) {
        const own = [...(comments[who] ?? [])].filter(([, a]) => a === me.actor).map(([c]) => c);
        if (own.length > 0) {
          const id = pick(own.sort());
          if (rnd() < 0.7) sim.write(who, 'comment.edit', target, { id, text: `Edited ${s}` });
          else sim.write(who, 'comment.delete', target, { id });
        }
      } else if (roll < 0.8) {
        sim.write(who, 'assign.set', target, {
          target: ctarget,
          assignee: rnd() < 0.2 ? null : sim.person(Math.floor(rnd() * n)).actor,
        });
      } else if (roll < 0.85) {
        counter += 1;
        const id = id16('ap_', counter);
        sim.write(who, 'approval.add', target, {
          id,
          target: ctarget,
          decision: 'approve',
          contentHash: sha256Hex(`content ${issue}`),
        });
        approvals[who]?.set(id, me.actor);
      } else if (roll < 0.87) {
        const own = [...(approvals[who] ?? [])].filter(([, a]) => a === me.actor).map(([c]) => c);
        if (own.length > 0) sim.write(who, 'approval.withdraw', target, { id: pick(own.sort()) });
      } else if (roll < 0.91) {
        sim.write(
          who,
          'change.review',
          { rec: 'change-item', id: `issue:${pick(['F01', 'F02', 'F03'])}`, in: 'c1-c2-issues' },
          { set: { status: pick(['confirmed', 'dismissed', 'open']), by: me.name, at } },
        );
      } else if (roll < 0.95) {
        sim.write(
          who,
          'detection.review',
          { rec: 'detection', id: pick(['a1', 'a2']), in: 'ai-run1.json' },
          { set: { status: pick(['accepted', 'rejected']), reviewedBy: me.name, reviewedAt: at } },
        );
      } else {
        sim.write(
          who,
          'procmodel.part',
          { rec: 'part', id: pick(['t1', 't2']), in: 'm1' },
          { set: { status: pick(['accepted', 'rejected', 'draft']) } },
        );
      }
    }
    if (rnd() < (opts.syncChance ?? 0.25) && n > 1) {
      const a = Math.floor(rnd() * n);
      const b = (a + 1 + Math.floor(rnd() * (n - 1))) % n;
      sim.sync(a, b);
      refresh(b);
    }
  }
  if (opts.settle ?? true) sim.syncAll();
  return { sim, ops: sim.all() };
}

/**
 * Share the simulated project as T2 does: person 0 shares (`project.share`) and adds themself as
 * the first owner with their own device, then adds the others with their device keys. Team checks
 * need signatures, so build the sim with `sign: true`.
 */
export function shareTeam(
  sim: TeamSim,
  roles: readonly ('owner' | 'reviewer' | 'viewer' | 'client')[],
): void {
  sim.write(0, 'project.share', { rec: 'project', id: 't' }, { teamProjectId: 't', name: 'Site' });
  roles.forEach((role, i) => {
    const p = sim.person(i);
    sim.write(
      0,
      'member.add',
      { rec: 'member', id: p.actor },
      {
        actor: p.actor,
        name: p.name,
        initials: p.initials,
        role: i === 0 ? 'owner' : role,
        devices: [{ id: p.device, key: p.signer.publicKey }],
      },
    );
  });
}
