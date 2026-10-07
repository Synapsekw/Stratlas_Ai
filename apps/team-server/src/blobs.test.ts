import { createHash, randomBytes } from 'node:crypto';
import {
  createHttpClient,
  createHttpTransport,
  enrolDevice,
  type HttpTransport,
} from '@aio/sync/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startLoopbackServer,
  TEST_TEAM,
  testPeople,
  type LoopbackServer,
  type Person,
} from './testkit';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function* parts(data: Buffer, size: number, stopAfter = Infinity) {
  let n = 0;
  for (let i = 0; i < data.length; i += size) {
    if (n++ >= stopAfter) throw new Error('connection lost');
    yield await Promise.resolve(data.subarray(i, i + size));
  }
}

async function collect(it: AsyncIterable<Uint8Array> | null): Promise<Buffer | null> {
  if (!it) return null;
  const out: Buffer[] = [];
  for await (const c of it) out.push(Buffer.from(c));
  return Buffer.concat(out);
}

describe('blobs by SHA-256 (resumable parts, ranges)', () => {
  const { rana, dana } = testPeople();
  let server: LoopbackServer;
  const data = randomBytes(5000);
  const ref = {
    sha256: sha(data),
    size: data.length,
    path: 'models/site.glb',
    role: 'source' as const,
  };

  const transport = (p: Person): HttpTransport =>
    createHttpTransport({
      client: createHttpClient({
        baseUrl: server.origin,
        fingerprint: server.fingerprint,
        signer: p.signer,
      }),
      teamProjectId: TEST_TEAM,
      partBytes: 1024,
    });

  beforeAll(async () => {
    server = await startLoopbackServer();
    for (const [p, role] of [
      [rana, 'reviewer'],
      [dana, 'client'],
    ] as const) {
      const client = createHttpClient({
        baseUrl: server.origin,
        fingerprint: server.fingerprint,
        signer: p.signer,
      });
      await enrolDevice(client, await server.invite(role), p.record);
    }
  });
  afterAll(() => server.close());

  it('resumes an interrupted upload where it stopped', async () => {
    const t = transport(rana);
    expect(await t.hasBlobs([ref.sha256])).toEqual(new Set());
    await expect(t.putBlob(ref, parts(data, 1024, 2))).rejects.toThrow('connection lost');
    expect(await t.blobReceived(ref.sha256)).toBe(2048);
    expect(await t.hasBlobs([ref.sha256])).toEqual(new Set());
    await t.putBlob(ref, parts(data.subarray(2048), 700), 2048);
    expect(await t.hasBlobs([ref.sha256])).toEqual(new Set([ref.sha256]));
    expect(await collect(await t.getBlob(ref.sha256))).toEqual(data);
  });

  it('serves byte ranges', async () => {
    const got = await collect(
      await transport(rana).getBlob(ref.sha256, { start: 1000, end: 1100 }),
    );
    expect(got).toEqual(data.subarray(1000, 1100));
    expect(await transport(rana).getBlob('f'.repeat(64))).toBeNull();
  });

  it('discards an upload that does not match its hash', async () => {
    const wrong = { ...ref, sha256: sha(Buffer.from('something else')) };
    await expect(transport(rana).putBlob(wrong, parts(data, 4096))).rejects.toMatchObject({
      status: 422,
    });
    expect(await transport(rana).blobReceived(wrong.sha256)).toBe(0);
  });

  it('refuses a part that does not continue the upload', async () => {
    const other = randomBytes(3000);
    const r = { ...ref, sha256: sha(other), size: other.length };
    await expect(
      transport(rana).putBlob(r, parts(other.subarray(1024), 1024), 1024),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('stores an empty file', async () => {
    const empty = { ...ref, sha256: sha(Buffer.alloc(0)), size: 0 };
    await transport(rana).putBlob(empty, parts(Buffer.alloc(0), 1024));
    expect(await transport(rana).hasBlobs([empty.sha256])).toEqual(new Set([empty.sha256]));
  });

  it('keeps project files from clients', async () => {
    await expect(transport(dana).hasBlobs([ref.sha256])).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
