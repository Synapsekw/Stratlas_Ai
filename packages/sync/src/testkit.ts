/**
 * TEST-ONLY helpers: fictional devices with throwaway keys, and chains of ops. Never used by the
 * app; keys live only for the test run.
 */
import { generateKeyPairSync } from 'node:crypto';
import { contentHash, formatHlc, randomId, sealOp, signerFromKey, type Signer } from '@aio/journal';
import { DEVICE_SCHEMA, type DeviceRecord, type Op } from '@aio/schema';

export interface TestDevice {
  signer: Signer;
  record: DeviceRecord;
  actor: string;
  chain: string;
  name: string;
}

export function testDevice(name = 'Rana Example', initials = 'RE'): TestDevice {
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = signerFromKey(privateKey);
  const actor = randomId('a_', 26);
  const unsigned = {
    schema: DEVICE_SCHEMA,
    id: signer.device,
    alg: 'ed25519' as const,
    key: signer.publicKey,
    actor,
    name,
    initials,
    label: 'TEST-ONLY device',
    app: { name: 'test-app', version: '0.9.0' },
    createdAt: '2026-10-07T08:00:00.000Z',
    certs: [],
  };
  const record = { ...unsigned, sig: signer.sign('aio.device/1', contentHash(unsigned)) };
  return { signer, record, actor, chain: `${signer.device}.${randomId('r_', 16)}`, name };
}

export interface OpSpec {
  kind?: string;
  target?: Op['target'];
  payload?: unknown;
  deps?: Record<string, string>;
  ms?: number;
}

/** Append `specs.length` ops to a device's chain after `prev` (null: from seq 1). */
export function chainOps(dev: TestDevice, specs: OpSpec[], after: Op | null = null): Op[] {
  const out: Op[] = [];
  let prev = after;
  for (const s of specs) {
    const seq = (prev?.seq ?? 0) + 1;
    const op = sealOp(
      {
        v: 1,
        chain: dev.chain,
        dev: dev.signer.device,
        act: dev.actor,
        seq,
        hlc: formatHlc({
          ms: s.ms ?? 1_791_360_000_000 + seq * 1000,
          counter: 0,
          device: dev.signer.device,
        }),
        prev: prev?.id ?? null,
        ...(s.deps ? { deps: s.deps } : {}),
        kind: s.kind ?? 'issue.patch',
        target: s.target ?? { rec: 'issue', id: 'i_f01' },
      },
      s.payload ?? { set: { severity: seq } },
      dev.signer,
    );
    out.push(op);
    prev = op;
  }
  return out;
}

/** `n` simple issue patches. */
export function patches(dev: TestDevice, n: number, after: Op | null = null): Op[] {
  return chainOps(
    dev,
    Array.from({ length: n }, (_, i) => ({ payload: { set: { title: `Change ${i + 1}` } } })),
    after,
  );
}
