import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadVerified } from './download';

const body = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 251));
const sha = createHash('sha256').update(body).digest('hex');

let server: Server;
let url: string;
let dir: string;
let ranges: (string | undefined)[];
let honourRange: boolean;

beforeEach(async () => {
  ranges = [];
  honourRange = true;
  server = createServer((req, res) => {
    ranges.push(req.headers.range);
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m && honourRange) {
      const start = Number(m[1]);
      res.statusCode = 206;
      res.setHeader(
        'content-range',
        `bytes ${String(start)}-${String(body.length - 1)}/${String(body.length)}`,
      );
      res.end(body.subarray(start));
      return;
    }
    res.end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/setup.exe`;
  dir = await mkdtemp(join(tmpdir(), 'download-'));
});

afterEach(async () => {
  await new Promise<void>((ok) => {
    server.close(() => {
      ok();
    });
  });
  await rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<Parameters<typeof downloadVerified>[0]> = {}) => ({
  url,
  sha256: sha,
  size: body.length,
  dest: join(dir, 'setup.exe'),
  fetch: (u: string, init?: { headers?: Record<string, string> }) => fetch(u, init),
  ...over,
});

describe('verified download', () => {
  it('writes the file only when size and hash match', async () => {
    await downloadVerified(request());
    expect(await readFile(join(dir, 'setup.exe'))).toEqual(body);
    expect(existsSync(join(dir, 'setup.exe.partial'))).toBe(false);
  });

  it('continues an interrupted download with a range request', async () => {
    await writeFile(join(dir, 'setup.exe.partial'), body.subarray(0, 20_000));
    await downloadVerified(request());
    expect(ranges).toEqual(['bytes=20000-']);
    expect(await readFile(join(dir, 'setup.exe'))).toEqual(body);
  });

  it('starts over when the server ignores the range', async () => {
    honourRange = false;
    await writeFile(join(dir, 'setup.exe.partial'), Buffer.alloc(20_000, 7));
    await downloadVerified(request());
    expect(await readFile(join(dir, 'setup.exe'))).toEqual(body);
  });

  it('deletes a file with the wrong hash and never names it as the installer', async () => {
    await expect(downloadVerified(request({ sha256: 'a'.repeat(64) }))).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(dir, 'setup.exe'))).toBe(false);
    expect(existsSync(join(dir, 'setup.exe.partial'))).toBe(false);
  });

  it('refuses more bytes than the feed says', async () => {
    await expect(downloadVerified(request({ size: 1000 }))).rejects.toThrow(/larger/);
    expect(existsSync(join(dir, 'setup.exe'))).toBe(false);
  });

  it('keeps a short download for later and says so', async () => {
    await expect(downloadVerified(request({ size: body.length + 10 }))).rejects.toThrow(
      /stopped at 50000 of 50010/,
    );
    expect(existsSync(join(dir, 'setup.exe.partial'))).toBe(true);
  });

  it('skips the download when the verified file is already there', async () => {
    await writeFile(join(dir, 'setup.exe'), body);
    await downloadVerified(request());
    expect(ranges).toEqual([]);
  });
});
