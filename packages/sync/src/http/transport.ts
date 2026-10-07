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
} from '@aio/schema';
import type { SyncTransport } from '../transport';
import { errorFor, TeamServerError, type HttpClient } from './client';
import { routePath } from './routes';
import { encodeSince } from './since';

/** Blob parts are uploaded and resumed in 8 MB pieces (data-conventions section 20). */
export const BLOB_PART_BYTES = 8 * 1024 * 1024;
/** Ops per push request (the protocol allows up to 5000). */
export const PUSH_BATCH = 1000;

export interface HttpTransportOptions {
  client: HttpClient;
  teamProjectId: string;
  /** Ops per pull page (1 to 5000). */
  pageSize?: number;
  partBytes?: number;
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

function parse<T>(schema: { parse(v: unknown): T }, body: Buffer): T {
  try {
    return schema.parse(JSON.parse(body.toString('utf8')));
  } catch {
    throw new TeamServerError('protocol', 'The team server sent an answer this app cannot read.');
  }
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
}: HttpTransportOptions): HttpTransport {
  const project = { id: teamProjectId };

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
      for (let i = 0; i < ops.length; i += PUSH_BATCH) {
        const batch = ops.slice(i, i + PUSH_BATCH);
        const res = await ok('POST', routePath('ops', project), 'Sending changes', { ops: batch });
        const r = parse(PushOpsResponse, res.body);
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
