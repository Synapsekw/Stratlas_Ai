/**
 * `HttpTransport`: the team server as a `SyncTransport`, so the desktop syncs to a server exactly
 * as it does to a hub folder or an exchange file. It stores and forwards; it never merges.
 */
import {
  HeadsResponse,
  MembersResponse,
  PullOpsResponse,
  PushOpsResponse,
  type BlobRef,
  type ByteRange,
  type Heads,
  type Member,
  type Op,
  type PullPage,
  type PushResult,
  type ServerKey,
} from '@aio/schema';
import type { SyncTransport } from '../transport';
import { errorFor, TeamServerError, type HttpClient } from './client';
import { receiptProblem, serverIdFromKey } from './receipts';
import { routePath } from './routes';
import { encodeSince } from './since';

/** Blob parts are uploaded and resumed in 8 MB pieces (data-conventions section 20). */
export const BLOB_PART_BYTES = 8 * 1024 * 1024;
/** Ops per push request (the protocol allows up to 5000). */
export const PUSH_BATCH = 1000;
/** Largest JSON body of a push request (the server takes up to 8 MB); one larger op goes alone. */
export const PUSH_BATCH_BYTES = 6 * 1024 * 1024;

export interface HttpTransportOptions {
  client: HttpClient;
  teamProjectId: string;
  /** Ops per pull page (1 to 5000). */
  pageSize?: number;
  partBytes?: number;
  /** Largest push body in bytes (tests); default `PUSH_BATCH_BYTES`. */
  pushBatchBytes?: number;
  /**
   * The server signing key pinned at enrolment. When given, every push receipt must verify
   * against it; without it (an enrolment from an older server) receipts are kept unchecked.
   */
  server?: ServerKey | undefined;
}

export interface HttpTransport extends SyncTransport {
  readonly kind: 'server';
  /** Bytes of a blob the server already holds from an earlier, interrupted upload. */
  blobReceived(sha256: string): Promise<number>;
  /** The project's members as the server enforces them. */
  members(): Promise<Member[]>;
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

function safeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

function parse<T>(schema: { parse(v: unknown): T }, body: Buffer): T {
  try {
    return schema.parse(JSON.parse(body.toString('utf8')));
  } catch {
    throw new TeamServerError('protocol', 'The team server sent an answer this app cannot read.');
  }
}

/** `{"ops":[` and `]}` around the ops of a push body. */
const PUSH_ENVELOPE_BYTES = Buffer.byteLength('{"ops":[]}');

/** Split ops into push requests of at most `PUSH_BATCH` ops and `maxBytes` of JSON body. */
export function pushBatches(ops: readonly Op[], maxBytes = PUSH_BATCH_BYTES): Op[][] {
  const batches: Op[][] = [];
  let batch: Op[] = [];
  let bytes = PUSH_ENVELOPE_BYTES;
  for (const op of ops) {
    const size = Buffer.byteLength(JSON.stringify(op));
    // `+ 1`: the comma before every op but the first
    if (batch.length > 0 && (batch.length >= PUSH_BATCH || bytes + 1 + size > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = PUSH_ENVELOPE_BYTES;
    }
    bytes += (batch.length > 0 ? 1 : 0) + size;
    batch.push(op);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function* chunked(
  data: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Buffer, void, undefined> {
  let pending: Buffer[] = [];
  let length = 0;
  for await (const chunk of data) {
    let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    while (length + buf.length >= size) {
      const take = size - length;
      pending.push(buf.subarray(0, take));
      yield Buffer.concat(pending);
      buf = buf.subarray(take);
      pending = [];
      length = 0;
    }
    if (buf.length > 0) {
      pending.push(Buffer.from(buf));
      length += buf.length;
    }
  }
  if (length > 0) yield Buffer.concat(pending);
}

export function createHttpTransport({
  client,
  teamProjectId,
  pageSize = 1000,
  partBytes = BLOB_PART_BYTES,
  pushBatchBytes = PUSH_BATCH_BYTES,
  server,
}: HttpTransportOptions): HttpTransport {
  const project = { id: teamProjectId };
  if (server && server.id !== serverIdFromKey(server.publicKey)) {
    throw new TeamServerError('fingerprint', 'The pinned server key does not match the server.');
  }

  async function ok(method: string, path: string, what: string, body?: unknown) {
    const res = await client.request(method, path, body === undefined ? {} : json(body));
    if (res.status < 200 || res.status >= 300) throw errorFor(res, what);
    return res;
  }

  async function received(sha256: string): Promise<{ complete: boolean; bytes: number }> {
    const res = await client.request('HEAD', routePath('blob', { sha256 }));
    if (res.status === 200) {
      return { complete: true, bytes: Number(res.headers['content-length'] ?? 0) };
    }
    if (res.status === 404) {
      return { complete: false, bytes: Number(res.headers['x-aio-blob-received'] ?? 0) };
    }
    throw errorFor(res, 'Checking a file');
  }

  return {
    kind: 'server',

    async heads(): Promise<Heads> {
      const res = await ok('GET', routePath('heads', project), 'Reading the server state');
      return parse(HeadsResponse, res.body).heads;
    },

    async pushOps(ops: readonly Op[]): Promise<PushResult> {
      const out: PushResult = { accepted: [], duplicates: [], refused: [], receipts: [] };
      for (const batch of pushBatches(ops, pushBatchBytes)) {
        const res = await client.request('POST', routePath('ops', project), json({ ops: batch }));
        // a 403 still lists each refused op (role, membership, revocation)
        const refused =
          res.status === 403 ? PushOpsResponse.safeParse(safeJson(res.body)).data : undefined;
        if (!refused && (res.status < 200 || res.status >= 300))
          throw errorFor(res, 'Sending changes');
        const r = refused ?? parse(PushOpsResponse, res.body);
        const problem = server ? receiptProblem(server, new Set(batch.map((o) => o.id)), r) : null;
        if (problem) {
          throw new TeamServerError(
            'protocol',
            `The team server sent a receipt that does not verify (${problem}). Ask your IT team to check the server.`,
          );
        }
        out.accepted.push(...r.accepted);
        out.duplicates.push(...r.duplicates);
        out.refused.push(...r.refused);
        out.receipts.push(...r.receipts);
      }
      return out;
    },

    async pullOps(since: Heads, cursor?: string | null): Promise<PullPage> {
      const query = new URLSearchParams({
        since: cursor ?? encodeSince(since),
        limit: String(pageSize),
      });
      const res = await ok(
        'GET',
        `${routePath('ops', project)}?${query.toString()}`,
        'Fetching changes',
      );
      return parse(PullOpsResponse, res.body);
    },

    async hasBlobs(sha256s: readonly string[]): Promise<Set<string>> {
      const have = new Set<string>();
      for (const sha256 of sha256s) {
        if ((await received(sha256)).complete) have.add(sha256);
      }
      return have;
    },

    blobReceived: async (sha256) => (await received(sha256)).bytes,

    async putBlob(ref: BlobRef, data: AsyncIterable<Uint8Array>, offset = 0): Promise<void> {
      const path = routePath('blob', { sha256: ref.sha256 });
      const put = async (start: number, part: Buffer) => {
        const range =
          ref.size === 0 ? 'bytes */0' : `bytes ${start}-${start + part.length - 1}/${ref.size}`;
        const res = await client.request('PUT', path, {
          body: part,
          headers: { 'content-type': 'application/octet-stream', 'content-range': range },
        });
        if (res.status < 200 || res.status >= 300) throw errorFor(res, 'Sending a file');
      };
      if (ref.size === 0) {
        await put(0, Buffer.alloc(0));
        return;
      }
      let at = offset;
      for await (const part of chunked(data, partBytes)) {
        await put(at, part);
        at += part.length;
      }
      if (at !== ref.size) {
        throw new TeamServerError(
          'conflict',
          `The file ended after ${at} of ${ref.size} bytes; the upload can resume later.`,
        );
      }
    },

    async getBlob(sha256: string, range?: ByteRange) {
      const headers: Record<string, string> = range
        ? { range: `bytes=${range.start}-${range.end - 1}` }
        : {};
      const res = await client.stream('GET', routePath('blob', { sha256 }), { headers });
      if (res.status === 404) {
        res.body.resume();
        return null;
      }
      if (res.status !== 200 && res.status !== 206) {
        const chunks: Buffer[] = [];
        for await (const c of res.body as AsyncIterable<Buffer>) chunks.push(c);
        throw errorFor({ status: res.status, body: Buffer.concat(chunks) }, 'Fetching a file');
      }
      return res.body as AsyncIterable<Uint8Array>;
    },

    async members(): Promise<Member[]> {
      const res = await ok('GET', routePath('members', project), 'Reading the members');
      return parse(MembersResponse, res.body).members;
    },
  };
}
