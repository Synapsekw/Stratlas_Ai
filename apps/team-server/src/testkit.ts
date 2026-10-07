/**
 * TEST-ONLY helpers shared by the server suite and the desktop e2e: fictional people with fixed
 * keys, op chains, and a loopback server (memory store, file system blobs, the TEST-ONLY
 * certificate). Never used by the server itself.
 */
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base32, contentHash, formatHlc, sealOp, signerFromSeed, type Signer } from '@aio/journal';
import type { DeviceRecord, Op, Role } from '@aio/schema';
import { makeInvite } from './auth/enrol';
import { createFsBlobStore } from './blobs/fs';
import { ephemeralIdentity, type ServerIdentity } from './identity';
import { buildServer } from './server';
import { createMemoryStore } from './store/memory';
import type { Store } from './store/store';

const fixtures = fileURLToPath(
  new URL('../../../packages/sync/src/http/__fixtures__/', import.meta.url),
);

/** The TEST-ONLY loopback certificate (127.0.0.1 and localhost) and its fingerprint. */
export function testTls() {
  const cert = readFileSync(join(fixtures, 'loopback-test-only.crt'));
  const key = readFileSync(join(fixtures, 'loopback-test-only.key'));
  const fingerprint = new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
  return { cert, key, fingerprint };
}

/** The test team project of the golden journal fixtures. */
export const TEST_TEAM = 't_vm6cv3mws7bgecezd4hkxj6qqt';

export interface Person {
  name: string;
  initials: string;
  email: string;
  actor: string;
  signer: Signer;
  record: DeviceRecord;
  chain: string;
}

const APP = { name: 'Quadrion AI', version: '0.9.0' };

/** A device record signed by its own key (`aio.device/1`). */
export function deviceRecord(
  signer: Signer,
  who: { actor: string; name: string; initials: string },
  createdAt = '2026-10-01T08:00:00.000Z',
): DeviceRecord {
  const rec = {
    schema: 'aio.device/1' as const,
    id: signer.device,
    alg: 'ed25519' as const,
    key: signer.publicKey,
    actor: who.actor,
    name: who.name,
    initials: who.initials,
    label: 'TEST-ONLY device',
    app: APP,
    createdAt,
    certs: [],
  };
  return { ...rec, sig: signer.sign('aio.device/1', contentHash(rec)) };
}

/** A fictional person with a fixed TEST-ONLY key (from a seed label). */
export function person(label: string, name: string, initials: string, seedHex?: string): Person {
  const seed = seedHex ?? contentHash(`aio-test-person:${label}`);
  const signer = signerFromSeed(seed);
  const actor = `a_${base32(Buffer.from(contentHash(`actor:${label}`), 'hex')).slice(0, 26)}`;
  const replica = `r_${base32(Buffer.from(contentHash(`replica:${label}`), 'hex')).slice(0, 16)}`;
  const who = { actor, name, initials };
  return {
    ...who,
    email: `${label}@example.com`,
    signer,
    record: deviceRecord(signer, who),
    chain: `${signer.device}.${replica}`,
  };
}

/** The fictional team: Rana (owner), Omar and Lina (reviewers), Sami (viewer), Dana (client). */
export function testPeople() {
  return {
    rana: person('rana', 'Rana Example', 'RE'),
    omar: person('omar', 'Omar Sample', 'OS'),
    lina: person('lina', 'Lina Test', 'LT'),
    sami: person('sami', 'Sami Viewer', 'SV'),
    dana: person('dana', 'Dana Client', 'DC'),
  };
}

/** Writes one person's chain: seq, prev and a clock that moves a minute per op. */
export class ChainWriter {
  private seq = 0;
  private prev: string | null = null;
  private ms: number;
  constructor(
    readonly who: Person,
    startMs = Date.parse('2026-10-01T09:00:00.000Z'),
  ) {
    this.ms = startMs;
  }

  /** The next op; `at` sets the clock reading (ms) instead of moving it a minute. */
  next(kind: string, target: Op['target'], payload: unknown, at?: number): Op {
    this.seq += 1;
    this.ms = at ?? this.ms + 60_000;
    const op = sealOp(
      {
        v: 1,
        chain: this.who.chain,
        dev: this.who.signer.device,
        act: this.who.actor,
        seq: this.seq,
        hlc: formatHlc({ ms: this.ms, counter: 0, device: this.who.signer.device }),
        prev: this.prev,
        kind,
        target,
      },
      payload,
      this.who.signer,
    );
    this.prev = op.id;
    return op;
  }
}

/** The `member.add` payload for a person. */
export function memberAdd(p: Person, role: Role) {
  return {
    actor: p.actor,
    name: p.name,
    initials: p.initials,
    email: p.email,
    role,
    devices: [{ id: p.signer.device, key: p.signer.publicKey }],
  };
}

export interface LoopbackServer {
  origin: string;
  fingerprint: string;
  store: Store;
  identity: ServerIdentity;
  /** A one-time invite code. */
  invite(role: Role, project?: string | null): Promise<string>;
  close(): Promise<void>;
}

/** A server on 127.0.0.1 over TLS with the TEST-ONLY certificate (memory store, temp blobs). */
export async function startLoopbackServer(
  options: { store?: Store; port?: number; name?: string } = {},
): Promise<LoopbackServer> {
  const tls = testTls();
  const store = options.store ?? createMemoryStore();
  await store.init();
  const blobDir = mkdtempSync(join(tmpdir(), 'aio-team-blobs-'));
  const identity = ephemeralIdentity();
  const app = buildServer({
    store,
    blobs: createFsBlobStore(blobDir),
    identity,
    version: '0.1.0-test',
    name: options.name ?? 'Test team server',
    https: { cert: tls.cert, key: tls.key },
    fingerprint: tls.fingerprint,
  });
  await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    origin: `https://127.0.0.1:${port}`,
    fingerprint: tls.fingerprint,
    store,
    identity,
    async invite(role, project = null) {
      const { code, invite } = makeInvite(role, project, new Date());
      await store.addInvite(invite);
      return code;
    },
    async close() {
      await app.close();
      await store.close();
      rmSync(blobDir, { recursive: true, force: true });
    },
  };
}
