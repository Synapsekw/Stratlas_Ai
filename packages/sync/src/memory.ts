import type { BlobRef, ByteRange, Heads, Op, PullPage, PushResult } from '@aio/schema';
import type { SyncTransport } from './transport';

/**
 * An in-memory transport for tests (merge, exchange and server suites). It stores and forwards
 * like the real ones: ops dedupe by id, heads per chain, blobs by hash. It checks nothing else.
 */
export function createMemoryTransport(): SyncTransport & { ops(): readonly Op[] } {
  const byId = new Map<string, Op>();
  const blobs = new Map<string, Uint8Array>();

  const heads = (): Heads => {
    const out: Heads = {};
    for (const op of byId.values()) {
      const h = out[op.chain];
      if (!h || op.seq > h.seq) out[op.chain] = { seq: op.seq, id: op.id };
    }
    return out;
  };

  return {
    kind: 'memory',
    ops: () => [...byId.values()],
    heads: () => Promise.resolve(heads()),
    pushOps(ops): Promise<PushResult> {
      const result: PushResult = { accepted: [], duplicates: [], refused: [], receipts: [] };
      for (const op of ops) {
        if (byId.has(op.id)) result.duplicates.push(op.id);
        else {
          byId.set(op.id, op);
          result.accepted.push(op.id);
        }
      }
      return Promise.resolve(result);
    },
    pullOps(since): Promise<PullPage> {
      const ops = [...byId.values()]
        .filter((op) => op.seq > (since[op.chain]?.seq ?? 0))
        .sort((a, b) => (a.chain === b.chain ? a.seq - b.seq : a.chain < b.chain ? -1 : 1));
      return Promise.resolve({ ops, cursor: null, more: false });
    },
    hasBlobs: (shas) => Promise.resolve(new Set(shas.filter((s) => blobs.has(s)))),
    async putBlob(ref: BlobRef, data, offset = 0) {
      const parts: Uint8Array[] = [];
      for await (const chunk of data) parts.push(chunk);
      const before = offset > 0 ? (blobs.get(ref.sha256) ?? new Uint8Array()).slice(0, offset) : [];
      blobs.set(ref.sha256, Uint8Array.from([...before, ...parts.flatMap((p) => [...p])]));
    },
    getBlob(sha256: string, range?: ByteRange) {
      const b = blobs.get(sha256);
      if (!b) return Promise.resolve(null);
      const slice = range ? b.slice(range.start, range.end) : b;
      return Promise.resolve(
        (async function* () {
          await Promise.resolve();
          yield slice;
        })(),
      );
    },
  };
}
