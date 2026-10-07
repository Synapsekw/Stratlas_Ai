import {
  DEFAULT_TEAM_POLICY,
  OP_KINDS,
  OP_PERMISSION,
  PERMISSIONS,
  Role,
  type DeviceCert,
  type Op,
  type Permission,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { contentHash, randomId } from './hash';
import {
  canApply,
  certifyDevice,
  deriveInitials,
  permissionFor,
  permits,
  replayTeam,
  uniqueInitials,
  verifyCert,
} from './members';
import { sealOp } from './op';
import { signerFromSeed, type Signer } from './sign';

// TEST-ONLY seeds: fictional people, never real devices.
const SEEDS = {
  rana: '11'.repeat(32),
  omar: '22'.repeat(32),
  lina: '33'.repeat(32),
  ranaLaptop: '44'.repeat(32),
};

interface Person {
  actor: string;
  name: string;
  initials: string;
  signer: Signer;
}

function person(name: string, initials: string, seed: string, actor?: string): Person {
  return { actor: actor ?? randomId('a_', 26), name, initials, signer: signerFromSeed(seed) };
}

/** A tiny journal writer: one chain per device, clock readings from a shared counter. */
function journal() {
  const ops: Op[] = [];
  const heads = new Map<string, { seq: number; id: string }>();
  let ms = 1_790_000_000_000;
  return {
    ops,
    write(
      by: Person,
      kind: string,
      payload: unknown,
      opts: { sign?: boolean; target?: { rec: string; id: string }; ms?: number } = {},
    ): Op {
      const chain = `${by.signer.device}.r_${'a'.repeat(16)}`;
      const head = heads.get(chain);
      ms = opts.ms ?? ms + 1000;
      const op = sealOp(
        {
          v: 1,
          chain,
          dev: by.signer.device,
          act: by.actor,
          seq: (head?.seq ?? 0) + 1,
          hlc: `${String(ms)}.0000.${by.signer.device}`,
          prev: head?.id ?? null,
          kind,
          target: opts.target ?? { rec: 'member', id: by.actor },
        },
        payload,
        opts.sign === false ? undefined : by.signer,
      );
      heads.set(chain, { seq: op.seq, id: op.id });
      ops.push(op);
      return op;
    },
  };
}

function card(p: Person, role: string, cert?: DeviceCert) {
  return {
    actor: p.actor,
    name: p.name,
    initials: p.initials,
    role,
    devices: [{ id: p.signer.device, key: p.signer.publicKey }],
    ...(cert ? { cert } : {}),
  };
}

const ISSUED = '2026-10-07T10:00:00.000Z';
const issuePatch = { set: { severity: 3 } };
const issue = { rec: 'issue', id: 'i1' };

function shared() {
  const rana = person('Rana Example', 'RE', SEEDS.rana);
  const omar = person('Omar Sample', 'OS', SEEDS.omar);
  const lina = person('Lina Example', 'LE', SEEDS.lina);
  const j = journal();
  j.write(rana, 'member.add', card(rana, 'owner'));
  return { rana, omar, lina, j };
}

describe('initials', () => {
  it('takes the first letters of the first and last words', () => {
    expect(deriveInitials('Rana Example')).toBe('RE');
    expect(deriveInitials('  omar  van der sample ')).toBe('OS');
    expect(deriveInitials('Jean-Luc Picard')).toBe('JP');
  });

  it('keeps Arabic letters and skips the article al-', () => {
    expect(deriveInitials('رنا السالم')).toBe('رس');
    expect(deriveInitials('عمر')).toBe('عم');
  });

  it('gives a single name two letters and never fails', () => {
    expect(deriveInitials('Omar')).toBe('OM');
    expect(deriveInitials('O')).toBe('O');
    expect(deriveInitials('1234')).toBe('X');
    expect(deriveInitials('ß example')).toBe('SE');
  });

  it('adds a digit suffix when the initials are taken', () => {
    expect(uniqueInitials('DR', [])).toBe('DR');
    expect(uniqueInitials('DR', ['DR'])).toBe('DR2');
    expect(uniqueInitials('DR', ['DR', 'DR2'])).toBe('DR3');
    expect(uniqueInitials('DR4', ['DR'])).toBe('DR4');
    expect(uniqueInitials('DR4', ['DR4'])).toBe('DR');
    expect(uniqueInitials('DR4', ['DR4', 'DR'])).toBe('DR2');
  });
});

describe('permission table', () => {
  it('gives every known op kind a permission or none', () => {
    for (const kind of OP_KINDS) expect(permissionFor(kind)).toBe(OP_PERMISSION[kind]);
    // a kind from a newer version needs edit rights (a viewer's unknown change is held)
    expect(permissionFor('issue.frobnicate')).toBe('edit');
  });

  it('matches the roles table of the plan for each role', () => {
    const table: Record<Permission, string> = {} as Record<Permission, string>;
    for (const p of Object.keys(PERMISSIONS) as Permission[]) {
      table[p] = Role.options
        .filter((r) => permits(r, p, DEFAULT_TEAM_POLICY))
        .map((r) => r[0])
        .join('');
    }
    expect(table).toEqual({
      read: 'orvc',
      'comment.team': 'or',
      'comment.client': 'orc',
      accept: 'orc',
      edit: 'or',
      assign: 'or',
      approve: 'or',
      'close-approved': 'o',
      'builder.edit': 'or',
      'builder.georef': 'o',
      admin: 'o',
      'export.package': 'or',
      'export.audit': 'orv',
      verify: 'orvc',
    });
  });

  it('lets the policy switches add one role', () => {
    const policy = {
      ...DEFAULT_TEAM_POLICY,
      approval: {
        ...DEFAULT_TEAM_POLICY.approval,
        viewersMayComment: true,
        closeBy: 'owner-or-reviewer' as const,
      },
    };
    expect(permits('viewer', 'comment.team', policy)).toBe(true);
    expect(permits('reviewer', 'close-approved', policy)).toBe(true);
    expect(permits('client', 'comment.team', policy)).toBe(false);
  });
});

describe('team replay', () => {
  it('has no roles while the project is not shared', () => {
    const rana = person('Rana Example', 'RE', SEEDS.rana);
    const j = journal();
    const op = j.write(rana, 'issue.patch', issuePatch, { target: issue, sign: false });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.shared).toBe(false);
    expect(r.members).toEqual([]);
    expect(r.verdicts.get(op.id)).toEqual({ ok: true });
  });

  it('makes the person who shares the first owner', () => {
    const { rana, j } = shared();
    const r = replayTeam(j.ops);
    expect(r.shared).toBe(true);
    expect(r.members).toHaveLength(1);
    expect(r.members[0]).toMatchObject({
      actor: rana.actor,
      name: 'Rana Example',
      role: 'owner',
      verification: 'self',
      addedBy: rana.actor,
      devices: [{ id: rana.signer.device, key: rana.signer.publicKey, revoked: false }],
    });
  });

  it('refuses a first member who is not the owner adding themself', () => {
    const rana = person('Rana Example', 'RE', SEEDS.rana);
    const omar = person('Omar Sample', 'OS', SEEDS.omar);
    const j = journal();
    const op = j.write(rana, 'member.add', card(omar, 'owner'));
    const r = replayTeam(j.ops);
    expect(r.shared).toBe(false);
    expect(r.quarantined).toEqual([
      expect.objectContaining({ op: op.id, code: 'not-member' }) as unknown,
    ]);
  });

  it('adds a reviewer from an owner, certified by the owner device', () => {
    const { rana, omar, j } = shared();
    const cert = certifyDevice(rana.signer, rana.actor, omar.actor, omar.signer.device, ISSUED);
    j.write(rana, 'member.add', card(omar, 'reviewer', cert), {
      target: { rec: 'member', id: omar.actor },
    });
    const r = replayTeam(j.ops);
    const m = r.members.find((x) => x.actor === omar.actor);
    expect(m).toMatchObject({ role: 'reviewer', verification: 'owner', addedBy: rana.actor });
  });

  it('holds a member.add whose certificate does not verify', () => {
    const { rana, omar, lina, j } = shared();
    // certificate for a different device than the one in the card
    const cert = certifyDevice(rana.signer, rana.actor, omar.actor, lina.signer.device, ISSUED);
    const op = j.write(rana, 'member.add', card(omar, 'reviewer', cert));
    const r = replayTeam(j.ops);
    expect(r.members.map((m) => m.actor)).not.toContain(omar.actor);
    expect(r.quarantined[0]).toMatchObject({ op: op.id, code: 'bad-certificate' });
  });

  it('refuses team changes from a reviewer and explains why', () => {
    const { rana, omar, lina, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    const op = j.write(omar, 'member.add', card(lina, 'reviewer'));
    const r = replayTeam(j.ops);
    expect(r.members.map((m) => m.actor)).not.toContain(lina.actor);
    const q = r.quarantined.find((x) => x.op === op.id);
    expect(q?.code).toBe('role');
    expect(q?.reason).toBe(
      'Omar Sample is a reviewer in this project. Only an owner can change members, roles, devices and the team policy.',
    );
  });

  it('judges an op by the role its author had at its clock reading', () => {
    const { rana, omar, j } = shared();
    j.write(rana, 'member.add', card(omar, 'viewer'));
    const before = j.write(omar, 'issue.patch', issuePatch, { target: issue });
    j.write(rana, 'member.role', { actor: omar.actor, role: 'reviewer' });
    const after = j.write(omar, 'issue.patch', issuePatch, { target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.verdicts.get(before.id)).toMatchObject({ ok: false, code: 'role' });
    expect(r.verdicts.get(after.id)).toEqual({ ok: true });
  });

  it('quarantines ops from a revoked device after the revocation only', () => {
    const { rana, omar, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    const early = j.write(omar, 'issue.patch', issuePatch, { target: issue });
    j.write(rana, 'device.revoke', { device: omar.signer.device, reason: 'Laptop lost' });
    const late = j.write(omar, 'issue.patch', issuePatch, { target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.verdicts.get(early.id)).toEqual({ ok: true });
    expect(r.verdicts.get(late.id)).toMatchObject({ ok: false, code: 'revoked-device' });
    const m = r.members.find((x) => x.actor === omar.actor);
    expect(m?.devices[0]).toMatchObject({ revoked: true });
    expect(m?.devices[0]?.revokedAt).toMatch(/^\d{13}\.0000\.d_/);
  });

  it('lets a person come back with a new device after a revocation', () => {
    const { rana, omar, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    j.write(rana, 'device.revoke', { device: omar.signer.device });
    const omarNew = { ...omar, signer: signerFromSeed('55'.repeat(32)) };
    j.write(rana, 'member.add', card(omarNew, 'reviewer'));
    const late = j.write(omarNew, 'issue.patch', issuePatch, { target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.members.find((x) => x.actor === omar.actor)?.devices).toHaveLength(2);
    expect(r.verdicts.get(late.id)).toEqual({ ok: true });
  });

  it('holds ops from people outside the team, unsigned ops and edited ops', () => {
    const { rana, omar, j } = shared();
    const stranger = j.write(omar, 'issue.patch', issuePatch, { target: issue });
    const unsigned = j.write(rana, 'issue.patch', issuePatch, { target: issue, sign: false });
    const edited = j.write(rana, 'issue.patch', issuePatch, { target: issue });
    (edited as { label?: string }).label = 'changed by hand';
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.verdicts.get(stranger.id)).toMatchObject({ ok: false, code: 'not-member' });
    expect(r.verdicts.get(unsigned.id)).toMatchObject({ ok: false, code: 'unsigned' });
    expect(r.verdicts.get(edited.id)).toMatchObject({ ok: false, code: 'edited' });
  });

  it('refuses an op that claims another person through their device', () => {
    const { rana, omar, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    // Omar's device writes as Rana (the actor field claims the owner)
    const forged = j.write({ ...omar, actor: rana.actor }, 'member.remove', {
      actor: omar.actor,
    });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.verdicts.get(forged.id)).toMatchObject({ ok: false, code: 'unknown-device' });
    expect(r.members).toHaveLength(2);
  });

  it('keeps at least one owner', () => {
    const { rana, omar, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    const demote = j.write(rana, 'member.role', { actor: rana.actor, role: 'viewer' });
    const remove = j.write(rana, 'member.remove', { actor: rana.actor });
    const revoke = j.write(rana, 'device.revoke', { device: rana.signer.device });
    const r = replayTeam(j.ops);
    for (const op of [demote, remove, revoke]) {
      expect(r.quarantined.find((q) => q.op === op.id)?.code).toBe('last-owner');
    }
    expect(r.members.find((m) => m.actor === rana.actor)?.role).toBe('owner');
  });

  it('removes a member, whose later ops are then held', () => {
    const { rana, omar, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    j.write(rana, 'member.remove', { actor: omar.actor });
    const late = j.write(omar, 'issue.patch', issuePatch, { target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.members.map((m) => m.actor)).toEqual([rana.actor]);
    expect(r.verdicts.get(late.id)).toMatchObject({ ok: false, code: 'not-member' });
  });

  it('keeps initials unique within the team with a digit', () => {
    const { rana, j } = shared();
    const rania = person('Rania Example', 'RE', SEEDS.lina);
    j.write(rana, 'member.add', card(rania, 'reviewer'));
    const r = replayTeam(j.ops);
    expect(r.members.map((m) => m.initials)).toEqual(['RE', 'RE2']);
  });

  it('applies the team policy: minimum verification and viewers commenting', () => {
    const { rana, omar, lina, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    const cert = certifyDevice(rana.signer, rana.actor, lina.actor, lina.signer.device, ISSUED);
    j.write(rana, 'member.add', card(lina, 'viewer', cert));
    j.write(rana, 'policy.set', {
      minVerification: 'owner',
      approval: { viewersMayComment: true },
    });
    const omarEdit = j.write(omar, 'issue.patch', issuePatch, { target: issue });
    const linaComment = j.write(lina, 'comment.add', {}, { target: { rec: 'comment', id: 'c' } });
    const ranaEdit = j.write(rana, 'issue.patch', issuePatch, { target: issue });
    const r = replayTeam(j.ops, { verdicts: 'all' });
    expect(r.policy.approval.viewersMayComment).toBe(true);
    j.write(rana, 'policy.set', { approval: { required: 2 } });
    // a partial policy changes only the fields it names
    expect(replayTeam(j.ops).policy.approval).toMatchObject({
      required: 2,
      viewersMayComment: true,
      fourEyes: true,
    });
    expect(r.verdicts.get(omarEdit.id)).toMatchObject({ ok: false, code: 'verification' });
    expect(r.verdicts.get(linaComment.id)).toEqual({ ok: true });
    // an owner is the root of trust and never needs certifying
    expect(r.verdicts.get(ranaEdit.id)).toEqual({ ok: true });
  });

  it('converges whatever order the ops arrive in', () => {
    const { rana, omar, lina, j } = shared();
    j.write(rana, 'member.add', card(omar, 'reviewer'));
    j.write(rana, 'member.add', card(lina, 'viewer'));
    j.write(rana, 'member.role', { actor: lina.actor, role: 'reviewer' });
    j.write(rana, 'device.revoke', { device: omar.signer.device });
    j.write(omar, 'issue.patch', issuePatch, { target: issue });
    const a = replayTeam(j.ops, { verdicts: 'all' });
    const b = replayTeam([...j.ops].reverse(), { verdicts: 'all' });
    expect(contentHash(b.members)).toBe(contentHash(a.members));
    expect([...b.verdicts.entries()].sort()).toEqual([...a.verdicts.entries()].sort());
  });

  it('records an M10 account link without raising verification', () => {
    const { rana, j } = shared();
    j.write(rana, 'member.link', {
      actor: rana.actor,
      issuer: 'accounts.example.com',
      account: 'acc-1',
      linkedAt: '2026-10-07T10:00:00.000Z',
      cert: 'reserved',
    });
    const r = replayTeam(j.ops);
    expect(r.members[0]?.account?.account).toBe('acc-1');
    expect(r.members[0]?.verification).toBe('self');
  });
});

describe('canApply', () => {
  it('checks one op against the current team, for UI gating and the server', () => {
    const { rana, omar, j } = shared();
    j.write(rana, 'member.add', card(omar, 'viewer'));
    const state = replayTeam(j.ops).state;
    const edit = journal().write(omar, 'issue.patch', issuePatch, { target: issue });
    expect(canApply(edit, state)).toMatchObject({
      ok: false,
      code: 'role',
      reason: 'Omar Sample is a viewer in this project. Only an owner or a reviewer can edit.',
    });
  });
});

describe('certificates', () => {
  it('verifies a certificate with the issuer key and refuses a changed one', () => {
    const rana = person('Rana Example', 'RE', SEEDS.rana);
    const omar = person('Omar Sample', 'OS', SEEDS.omar);
    const cert = certifyDevice(rana.signer, rana.actor, omar.actor, omar.signer.device, ISSUED);
    expect(cert.level).toBe('owner');
    expect(verifyCert(cert, rana.signer.publicKey)).toBe(true);
    expect(verifyCert({ ...cert, actor: rana.actor }, rana.signer.publicKey)).toBe(false);
    expect(verifyCert(cert, omar.signer.publicKey)).toBe(false);
    const other = signerFromSeed(SEEDS.ranaLaptop);
    expect(verifyCert(cert, other.publicKey)).toBe(false);
  });
});
