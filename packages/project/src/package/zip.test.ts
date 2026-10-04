import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aesCtrXor, deriveAesKeys } from './aes';
import { openZip, ZipError } from './reader';
import { writeZip, type ZipMember, type ZipProgress } from './writer';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-zip-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

async function fileMember(name: string, data: Buffer): Promise<ZipMember> {
  const file = join(dir, name.replace(/\//g, '_'));
  await writeFile(file, data);
  return { name, file, size: data.length };
}

describe('store-mode zip', () => {
  it('round-trips files and in-memory members byte for byte', async () => {
    const video = randomBytes(300_000);
    const members = [
      { name: 'manifest.json', data: Buffer.from('{"a":1}') },
      await fileMember('video/v101_00.mp4', video),
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];
    const out = join(dir, 'p.aio');
    await writeZip(out, members);
    const zip = await openZip(out);
    expect([...zip.entries.keys()]).toEqual(['manifest.json', 'video/v101_00.mp4', 'empty.txt']);
    expect((await zip.read('manifest.json')).toString()).toBe('{"a":1}');
    expect((await zip.read('video/v101_00.mp4')).equals(video)).toBe(true);
    expect((await zip.read('empty.txt')).length).toBe(0);
    expect(zip.entries.get('video/v101_00.mp4')?.size).toBe(video.length);
    expect(zip.encrypted).toBe(false);
  });

  it('stores members uncompressed so a byte range reads in place', async () => {
    const video = randomBytes(100_000);
    const out = join(dir, 'p.aio');
    await writeZip(out, [await fileMember('v.mp4', video)]);
    const zip = await openZip(out);
    const part = await collect(await zip.stream('v.mp4', 4_000, 4_099));
    expect(part.equals(video.subarray(4_000, 4_100))).toBe(true);
    // The member's bytes sit verbatim inside the archive file.
    const whole = await readFile(out);
    const at = await zip.dataOffset('v.mp4');
    expect(whole.subarray(at, at + video.length).equals(video)).toBe(true);
  });

  it('writes CRC-32 values a standard reader verifies', async () => {
    const data = Buffer.from('hello package');
    const out = join(dir, 'p.aio');
    await writeZip(out, [{ name: 'a.txt', data }]);
    const zip = await openZip(out);
    // zlib.crc32('hello package')
    const { crc32 } = await import('node:zlib');
    expect(zip.entries.get('a.txt')?.crc32).toBe(crc32(data));
  });

  it('writes and reads the ZIP64 end records', async () => {
    const out = join(dir, 'p.aio');
    await writeZip(out, [{ name: 'a.txt', data: Buffer.from('abc') }], { forceZip64: true });
    const whole = await readFile(out);
    expect(whole.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
    expect(whole.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBe(true);
    const zip = await openZip(out);
    expect((await zip.read('a.txt')).toString()).toBe('abc');
  });

  it('reports progress up to the total and keeps no partial file after cancel', async () => {
    const members = [
      await fileMember('a.bin', randomBytes(2_000_000)),
      await fileMember('b.bin', randomBytes(2_000_000)),
    ];
    const out = join(dir, 'p.aio');
    const seen: ZipProgress[] = [];
    await writeZip(out, members, { onProgress: (p) => seen.push(p) });
    expect(seen.at(-1)).toMatchObject({ bytesDone: 4_000_000, bytesTotal: 4_000_000 });
    expect(seen.at(-1)?.filesDone).toBe(2);

    const out2 = join(dir, 'q.aio');
    const ac = new AbortController();
    const run = writeZip(out2, members, {
      signal: ac.signal,
      onProgress: (p) => {
        if (p.bytesDone > 0) ac.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(out2)).toBe(false);
    expect(existsSync(`${out2}.partial`)).toBe(false);
  });

  it('fails with a clear message when a source file changed size', async () => {
    const m = await fileMember('a.bin', randomBytes(1000));
    const out = join(dir, 'p.aio');
    await expect(writeZip(out, [{ ...m, size: 2000 }])).rejects.toThrow(/changed/);
    expect(existsSync(out)).toBe(false);
  });

  it('rejects a file that is not a zip archive', async () => {
    const bad = join(dir, 'bad.aio');
    await writeFile(bad, 'not a zip at all');
    await expect(openZip(bad)).rejects.toBeInstanceOf(ZipError);
  });

  it('reports a truncated archive as damaged', async () => {
    const out = join(dir, 'p.aio');
    await writeZip(out, [{ name: 'a.txt', data: Buffer.alloc(5000, 1) }]);
    const whole = await readFile(out);
    await writeFile(out, whole.subarray(0, whole.length - 30));
    await expect(openZip(out)).rejects.toThrow(/damaged|incomplete/i);
  });
});

describe('AES-256 (WinZip AE-2)', () => {
  it('derives the AES key, HMAC key and password check from PBKDF2-SHA1', () => {
    // WinZip AES test: 1000 iterations, 66 bytes split 32 / 32 / 2.
    const keys = deriveAesKeys('password', Buffer.alloc(16, 0));
    expect(keys.aesKey.length).toBe(32);
    expect(keys.hmacKey.length).toBe(32);
    expect(keys.check.length).toBe(2);
  });

  it('decrypts any byte range of the counter-mode stream', () => {
    const key = randomBytes(32);
    const plain = randomBytes(1000);
    const cipher = aesCtrXor(key, plain, 0);
    expect(cipher.equals(plain)).toBe(false);
    expect(aesCtrXor(key, cipher.subarray(37, 555), 37).equals(plain.subarray(37, 555))).toBe(true);
  });

  it('encrypts members that open only with the passphrase and stream from any offset', async () => {
    const video = randomBytes(200_003);
    const out = join(dir, 'p.aio');
    await writeZip(
      out,
      [
        { name: 'manifest.json', data: Buffer.from('{"secret":true}') },
        await fileMember('v.mp4', video),
      ],
      { passphrase: 'correct horse' },
    );
    const whole = await readFile(out);
    expect(whole.includes(Buffer.from('secret'))).toBe(false);

    const zip = await openZip(out);
    expect(zip.encrypted).toBe(true);
    await expect(zip.read('manifest.json')).rejects.toThrow(/passphrase/i);
    expect(await zip.unlock('wrong one')).toBe(false);
    expect(await zip.unlock('correct horse')).toBe(true);
    expect((await zip.read('manifest.json')).toString()).toBe('{"secret":true}');
    expect(zip.entries.get('v.mp4')?.size).toBe(video.length);
    const part = await collect(await zip.stream('v.mp4', 99_999, 150_000));
    expect(part.equals(video.subarray(99_999, 150_001))).toBe(true);
    expect((await zip.read('v.mp4')).equals(video)).toBe(true);
  });

  it('detects a tampered encrypted member on a whole read', async () => {
    const out = join(dir, 'p.aio');
    await writeZip(
      out,
      [
        { name: 'a.json', data: Buffer.from('{}') },
        { name: 'issues.json', data: Buffer.from('{"issues":[1,2,3]}') },
      ],
      { passphrase: 'correct horse' },
    );
    const zip = await openZip(out);
    await zip.unlock('correct horse');
    const at = await zip.dataOffset('issues.json');
    const whole = await readFile(out);
    whole[at + 3] = (whole[at + 3] ?? 0) ^ 0xff;
    await writeFile(out, whole);
    const again = await openZip(out);
    await again.unlock('correct horse');
    await expect(again.read('issues.json')).rejects.toThrow(/damaged|altered/i);
  });

  it('keeps the archive size at stored size plus 28 bytes per encrypted member', async () => {
    const out = join(dir, 'p.aio');
    await writeZip(out, [{ name: 'a', data: Buffer.alloc(1000) }], { passphrase: 'correct horse' });
    const zip = await openZip(out);
    expect(zip.entries.get('a')?.compressedSize).toBe(1028);
    expect((await stat(out)).size).toBeGreaterThan(1028);
  });
});
