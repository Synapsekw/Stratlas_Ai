import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lasHeaderDay, zpcHeaderDay } from './zpc';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-zpc-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A LAS 1.2 header (227 bytes) with the file creation day and year set. */
function lasHeader(day: number, year: number, signature = 'LASF'): Buffer {
  const h = Buffer.alloc(227);
  h.write(signature, 0, 'latin1');
  h.writeUInt16LE(day, 90);
  h.writeUInt16LE(year, 92);
  return h;
}

interface Member {
  name: string;
  data: Buffer;
  method?: 0 | 8;
}

/** A ZIP built by hand (CRC left at 0: the reader never checks it). */
function zip(members: Member[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const method = m.method ?? 0;
    const body = method === 8 ? deflateRawSync(m.data) : m.data;
    const name = Buffer.from(m.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(m.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(m.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

async function zpcOf(members: Member[]): Promise<string> {
  const file = join(dir, 'cloud.zpc');
  await writeFile(file, zip(members));
  return file;
}

describe('lasHeaderDay', () => {
  it('reads day 285 of 2026 as 2026-10-12', () => {
    expect(lasHeaderDay(lasHeader(285, 2026))).toBe('2026-10-12');
  });

  it('refuses year 0, day 0, a day past the year, a short header and a wrong signature', () => {
    expect(lasHeaderDay(lasHeader(285, 0))).toBeNull();
    expect(lasHeaderDay(lasHeader(0, 2026))).toBeNull();
    expect(lasHeaderDay(lasHeader(366, 2025))).toBeNull();
    expect(lasHeaderDay(lasHeader(366, 2024))).toBe('2024-12-31');
    expect(lasHeaderDay(lasHeader(285, 1989))).toBeNull();
    expect(lasHeaderDay(lasHeader(285, new Date().getUTCFullYear() + 2))).toBeNull();
    expect(lasHeaderDay(lasHeader(285, 2026).subarray(0, 93))).toBeNull();
    expect(lasHeaderDay(lasHeader(285, 2026, 'XXXX'))).toBeNull();
  });
});

describe('zpcHeaderDay', () => {
  it('reads a stored tile', async () => {
    const file = await zpcOf([{ name: 'a.las', data: lasHeader(285, 2026) }]);
    expect(await zpcHeaderDay(file)).toBe('2026-10-12');
  });

  it('reads a deflated tile, however large its body', async () => {
    const body = Buffer.alloc(300_000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 2654435761) >>> 24;
    const data = Buffer.concat([lasHeader(285, 2026), body]);
    const file = await zpcOf([{ name: 'tiles/a.laz', data, method: 8 }]);
    expect(await zpcHeaderDay(file)).toBe('2026-10-12');
  });

  it('is null for a year 0 or day 0 tile', async () => {
    const year0 = await zpcOf([{ name: 'a.las', data: lasHeader(285, 0) }]);
    expect(await zpcHeaderDay(year0)).toBeNull();
    const day0 = await zpcOf([{ name: 'a.las', data: lasHeader(0, 2026) }]);
    expect(await zpcHeaderDay(day0)).toBeNull();
  });

  it('is null for day 366 of 2025', async () => {
    const file = await zpcOf([{ name: 'a.las', data: lasHeader(366, 2025) }]);
    expect(await zpcHeaderDay(file)).toBeNull();
  });

  it('is null for a file that is not a ZIP, a missing file and a ZIP without tiles', async () => {
    const text = join(dir, 'not.zpc');
    await writeFile(text, 'definitely not a zip file at all');
    expect(await zpcHeaderDay(text)).toBeNull();
    expect(await zpcHeaderDay(join(dir, 'missing.zpc'))).toBeNull();
    const none = await zpcOf([{ name: 'readme.txt', data: Buffer.from('hello') }]);
    expect(await zpcHeaderDay(none)).toBeNull();
  });

  it('takes the most frequent day of several tiles, a tie to the earlier', async () => {
    const three = await zpcOf([
      { name: 'a.las', data: lasHeader(285, 2026) },
      { name: 'b.las', data: lasHeader(280, 2026), method: 8 },
      { name: 'c.laz', data: lasHeader(285, 2026) },
    ]);
    expect(await zpcHeaderDay(three)).toBe('2026-10-12');
    const tie = await zpcOf([
      { name: 'a.las', data: lasHeader(285, 2026) },
      { name: 'b.las', data: lasHeader(280, 2026) },
    ]);
    expect(await zpcHeaderDay(tie)).toBe('2026-10-07');
  });
});
