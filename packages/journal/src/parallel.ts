import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { SIGNING_DOMAINS, type VerifyReport } from '@aio/schema';
import { checkDeviceRecord } from './checkpoint';
import { loadJournal, type JournalFiles } from './load';
import { verifyLoaded, type VerifyOptions } from './verify';

/**
 * Ed25519 verification is about 75 us per op, so 100,000 ops take 7 to 8 s on one thread. The
 * signatures are checked on worker threads (plain JavaScript, `node:crypto` only, so it runs the
 * same in main, the data process and tests); everything else stays in `verifyLoaded`.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { createPublicKey, verify } = require('node:crypto');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const keys = new Map();
const { domain, items } = workerData;
const ok = new Uint8Array(items.length);
for (let i = 0; i < items.length; i++) {
  const [key, id, sig] = items[i];
  try {
    let k = keys.get(key);
    if (k === undefined) {
      k = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(key, 'base64url')]), format: 'der', type: 'spki' });
      keys.set(key, k);
    }
    ok[i] = verify(null, Buffer.from(domain + '\\n' + id, 'utf8'), k, Buffer.from(sig, 'base64url')) ? 1 : 0;
  } catch {
    ok[i] = 0;
  }
}
parentPort.postMessage(ok);
`;

/** Check `[publicKey, opId, signature]` triples on up to `threads` workers. */
export async function verifyOpSignatures(
  items: readonly (readonly [string, string, string])[],
  threads = Math.max(1, Math.min(4, availableParallelism() - 1)),
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (items.length === 0) return out;
  const n = items.length < 2000 ? 1 : threads;
  const size = Math.ceil(items.length / n);
  const chunks = Array.from({ length: n }, (_, i) => items.slice(i * size, (i + 1) * size));
  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<Uint8Array>((resolve, reject) => {
          const w = new Worker(WORKER, {
            eval: true,
            workerData: { domain: SIGNING_DOMAINS.op, items: chunk },
          });
          w.once('message', (m: Uint8Array) => {
            resolve(m);
            void w.terminate();
          });
          w.once('error', reject);
        }),
    ),
  );
  results.forEach((ok, c) => {
    const chunk = chunks[c] ?? [];
    chunk.forEach(([, id], i) => out.set(id, ok[i] === 1));
  });
  return out;
}

/** `verifyJournal` with op signatures checked on worker threads (same report). */
export async function verifyJournalParallel(
  files: JournalFiles,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const j = loadJournal(files);
  const keys = new Map<string, string>();
  for (const [dev, d] of j.devices) {
    if (d.raw?.id === dev && checkDeviceRecord(d.raw)) keys.set(dev, String(d.raw.key));
  }
  const items: [string, string, string][] = [];
  for (const c of j.chains.values()) {
    const key = keys.get(c.chain.split('.')[0] ?? '');
    if (!key) continue;
    for (const s of c.segments) {
      for (const l of s.lines) {
        if (l.ok && typeof l.raw.id === 'string' && typeof l.raw.sig === 'string') {
          items.push([key, l.raw.id, l.raw.sig]);
        }
      }
    }
  }
  const signatures = await verifyOpSignatures(items);
  return verifyLoaded(j, { ...opts, signatures });
}
