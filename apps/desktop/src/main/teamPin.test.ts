import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomId, sealOp, signerFromSeed, type Signer } from '@aio/journal';
import type { Op } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureTeamPin, teamPinOf, teamPinState, trustedTeamFile } from './teamPin';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aio-pin-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// TEST-ONLY seeds: fictional people, never real devices.
const rana = { actor: randomId('a_', 26), signer: signerFromSeed('11'.repeat(32)) };
const omar = signerFromSeed('22'.repeat(32));

function shareOps(by: { actor: string; signer: Signer }): Op[] {
  const chain = `${by.signer.device}.r_${'a'.repeat(16)}`;
  const share = sealOp(
    {
      v: 1,
      chain,
      dev: by.signer.device,
      act: by.actor,
      seq: 1,
      hlc: `1790000000000.0000.${by.signer.device}`,
      prev: null,
      kind: 'project.share',
      target: { rec: 'project', id: 'p' },
    },
    { teamProjectId: `t_${'a'.repeat(26)}`, name: 'P' },
    by.signer,
  );
  const add = sealOp(
    {
      v: 1,
      chain,
      dev: by.signer.device,
      act: by.actor,
      seq: 2,
      hlc: `1790000001000.0000.${by.signer.device}`,
      prev: share.id,
      kind: 'member.add',
      target: { rec: 'member', id: by.actor },
    },
    {
      actor: by.actor,
      name: 'Rana Example',
      initials: 'RE',
      role: 'owner',
      devices: [{ id: by.signer.device, key: by.signer.publicKey }],
    },
    by.signer,
  );
  return [share, add];
}

const legacy = {
  schema: 'aio.team/1',
  teamProjectId: `t_${'a'.repeat(26)}`,
  name: 'P',
  createdAt: '2026-10-07T10:00:00.000Z',
  createdBy: rana.actor,
};
const raws = (ops: Op[]) => ops as unknown as Record<string, unknown>[];

describe('team pin in team.json', () => {
  it('a project that is not shared has no pin and gets none', async () => {
    expect(await teamPinState(root)).toBeNull();
    expect(await ensureTeamPin(root, raws(shareOps(rana)), rana.signer)).toBeNull();
  });

  it('pins a project shared by an older version on first use: signed on the owner device', async () => {
    await writeFile(join(root, 'team.json'), JSON.stringify(legacy));
    expect(await teamPinState(root)).toEqual({ status: 'none' });
    const ops = shareOps(rana);
    const after = await ensureTeamPin(root, raws(ops), rana.signer);
    expect(after).toMatchObject({ status: 'signed', pin: { op: ops[1]?.id } });
    expect((await teamPinOf(root))?.op).toBe(ops[1]?.id);
    // pinned once: a second call changes nothing, even with another history
    const text = await readFile(join(root, 'team.json'), 'utf8');
    await ensureTeamPin(root, [], rana.signer);
    expect(await readFile(join(root, 'team.json'), 'utf8')).toBe(text);
  });

  it('pins locally (unsigned) on another member device', async () => {
    await writeFile(join(root, 'team.json'), JSON.stringify(legacy));
    expect(await ensureTeamPin(root, raws(shareOps(rana)), omar)).toMatchObject({
      status: 'local',
    });
  });

  it('keeps a hub or sender team.json pin only when the owner signed it', async () => {
    await writeFile(join(root, 'team.json'), JSON.stringify(legacy));
    await ensureTeamPin(root, raws(shareOps(rana)), rana.signer);
    const signed = JSON.parse(await readFile(join(root, 'team.json'), 'utf8')) as typeof legacy;
    expect(trustedTeamFile(signed as never)).toEqual(signed);
    const forged = { ...signed, name: 'Changed' };
    expect(trustedTeamFile(forged as never)).toEqual({ ...legacy, name: 'Changed' });
  });
});
