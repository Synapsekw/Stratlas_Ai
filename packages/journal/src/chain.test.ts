import { generateKeyPairSync } from 'node:crypto';
import { SEGMENT_MAX_OPS, segmentFileName } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createChainWriter, type ChainTail } from './chain';
import { sealDeviceRecord } from './checkpoint';
import { signerFromKey } from './sign';
import { verifyJournal } from './verify';

const signer = signerFromKey(generateKeyPairSync('ed25519').privateKey);
const chain = `${signer.device}.r_aaaaaaaaaaaaaaaa`;
const actor = `a_${'b'.repeat(26)}`;
const NOW = 1_790_000_000_000;

function device() {
  return sealDeviceRecord(
    {
      schema: 'aio.device/1',
      id: signer.device,
      alg: 'ed25519',
      key: signer.publicKey,
      actor,
      name: 'Rana Example',
      initials: 'RE',
      app: { name: 'test-app', version: '0.9.0' },
      createdAt: new Date(NOW).toISOString(),
      certs: [],
    },
    signer,
  );
}

describe('createChainWriter', () => {
  it('chains, signs and verifies what it writes', () => {
    const w = createChainWriter({ chain, actor, signer, tail: null, now: () => NOW });
    const files = new Map<string, string>();
    files.set(`journal/devices/${signer.device}.json`, JSON.stringify(device()));
    for (let i = 0; i < 5; i++) {
      const { line, segment } = w.next({
        kind: 'issue.patch',
        target: { rec: 'issue', id: 'i_f01' },
        payload: { set: { severity: i } },
        label: `F01 severity ${String(i)}`,
      });
      const path = `journal/ops/${chain}/${segmentFileName(segment)}`;
      files.set(path, (files.get(path) ?? '') + line);
    }
    expect(w.tail?.seq).toBe(5);
    const r = verifyJournal(files, { now: new Date(NOW) });
    expect(r.problems).toEqual([]);
    expect(r.counts.signed).toBe(5);
  });

  it('keeps its clock moving forward from the last reading, whatever the wall clock says', () => {
    const w = createChainWriter({ chain, actor, signer, tail: null, now: () => NOW });
    const a = w.next({ kind: 'journal.on', target: { rec: 'project', id: 'p' }, payload: {} });
    const resumed = createChainWriter({
      chain,
      actor,
      signer,
      tail: w.tail,
      now: () => NOW - 60_000,
    });
    const b = resumed.next({
      kind: 'journal.on',
      target: { rec: 'project', id: 'p' },
      payload: {},
    });
    expect(b.op.hlc > a.op.hlc).toBe(true);
    expect(b.op.prev).toBe(a.op.id);
    resumed.observe(`${String(NOW + 5000)}.0003.d_${'c'.repeat(52)}`);
    const c = resumed.next({
      kind: 'journal.on',
      target: { rec: 'project', id: 'p' },
      payload: {},
    });
    expect(c.op.hlc.startsWith(`${String(NOW + 5000)}.0005.`)).toBe(true);
  });

  it('starts a new segment after 10,000 ops and links it to the last one', () => {
    const tail: ChainTail = {
      seq: 20_000,
      id: 'a'.repeat(64),
      hlc: `${String(NOW)}.0000.${signer.device}`,
      segment: 2,
      segmentBytes: 1000,
      segmentOps: SEGMENT_MAX_OPS,
      sinceCheckpoint: 499,
    };
    const w = createChainWriter({ chain, actor, signer: null, tail, now: () => NOW });
    const r = w.next({ kind: 'journal.on', target: { rec: 'project', id: 'p' }, payload: {} });
    expect(r.segment).toBe(3);
    expect(r.op.prev).toBe('a'.repeat(64));
    expect(r.op.sig).toBeUndefined();
    expect(w.checkpointDue()).toBe(true);
  });
});
