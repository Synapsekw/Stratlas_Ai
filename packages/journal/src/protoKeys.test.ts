import { describe, expect, it } from 'vitest';
import { diffFields } from './diff';
import { replayTeam, teamFences } from './members';
import { sealOp } from './op';
import { signerFromSeed } from './sign';

/** Keys from files and ops are untrusted: `__proto__` stays a plain key, never a prototype. */
describe('untrusted keys', () => {
  it('diffFields keeps __proto__ as an own field and never sets a prototype', () => {
    const before = JSON.parse('{"a":1}') as Record<string, unknown>;
    const after = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const out = diffFields(before, after);
    expect(Object.getPrototypeOf(out.set)).toBe(Object.prototype);
    expect(Object.keys(out.set ?? {})).toEqual(['__proto__']);
    expect(out.set?.polluted).toBeUndefined();
    const back = diffFields(after, before);
    expect(back.unset).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(back.was)).toBe(Object.prototype);
    expect(back.was?.polluted).toBeUndefined();
  });

  it('a seen map naming __proto__ is refused, never merged into a fence', () => {
    const rana = signerFromSeed('11'.repeat(32));
    const actor = `a_${'b'.repeat(26)}`;
    const chain = `${rana.device}.r_${'a'.repeat(16)}`;
    const add = sealOp(
      {
        v: 1,
        chain,
        dev: rana.device,
        act: actor,
        seq: 1,
        hlc: `1790000000000.0000.${rana.device}`,
        prev: null,
        kind: 'member.add',
        target: { rec: 'member', id: actor },
      },
      {
        actor,
        name: 'Rana Example',
        initials: 'RE',
        role: 'owner',
        devices: [{ id: rana.device, key: rana.publicKey }],
      },
      rana,
    );
    const other = signerFromSeed('22'.repeat(32));
    const otherActor = `a_${'c'.repeat(26)}`;
    const addOther = sealOp(
      {
        v: 1,
        chain,
        dev: rana.device,
        act: actor,
        seq: 2,
        hlc: `1790000000500.0000.${rana.device}`,
        prev: add.id,
        kind: 'member.add',
        target: { rec: 'member', id: otherActor },
      },
      {
        actor: otherActor,
        name: 'Omar Sample',
        initials: 'OS',
        role: 'reviewer',
        devices: [{ id: other.device, key: other.publicKey }],
      },
      rana,
    );
    const revoke = sealOp(
      {
        v: 1,
        chain,
        dev: rana.device,
        act: actor,
        seq: 3,
        hlc: `1790000001000.0000.${rana.device}`,
        prev: addOther.id,
        kind: 'device.revoke',
        target: { rec: 'device', id: other.device },
      },
      JSON.parse(`{"device":"${other.device}","seen":{"__proto__":{"x":1},"constructor":4}}`),
      rana,
    );
    const raws = [add, addOther, revoke] as unknown as Record<string, unknown>[];
    // a seen map with keys that are not chains is not a valid revocation: held, no fence
    expect(teamFences(raws)).toEqual([]);
    expect(replayTeam(raws).verdicts.get(revoke.id)).toMatchObject({ ok: false, code: 'invalid' });
  });
});
