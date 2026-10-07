import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { sha256Hex } from '@aio/journal';
import type { Op } from '@aio/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainOps, patches, testDevice } from '../testkit';
import {
  EXCHANGE_MAX_BYTES,
  ExchangeError,
  exchangeMembers,
  headsOf,
  openExchange,
  opsSince,
  planIngest,
  previewExchange,
  writeExchange,
  writeExchangeZip,
  type LocalView,
} from './index';

const TEAM = 't_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const FAST = { N: 1024, r: 8, p: 1 };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aio-exchange-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rana = testDevice('Rana Example', 'RE');
const omar = testDevice('Omar Sample', 'OS');
const from = (d = rana) => ({
  actor: d.actor,
  device: d.signer.device,
  name: d.name,
  app: { name: 'test-app', version: '0.9.0' },
});
let n = 0;
const out = () => join(dir, `x${++n}.aiosync`);

async function write(ops: Op[], extra: Partial<Parameters<typeof writeExchange>[0]> = {}) {
  const file = out();
  await writeExchange({
    out: file,
    kind: 'patch',
    teamProjectId: TEAM,
    from: from(),
    signer: rana.signer,
    since: { all: true },
    heads: headsOf(ops),
    ops,
    devices: [rana.record, omar.record],
    scrypt: FAST,
    ...extra,
  });
  return file;
}

const local = (over: Partial<LocalView> = {}): LocalView => ({
  heads: {},
  held: [],
  ops: [],
  hasBlob: () => false,
  imported: new Set(),
  ...over,
});

describe('exchange files', () => {
  it('writes a signed patch that opens with every op, device and a valid signature', async () => {
    const ops = [...patches(rana, 3), ...patches(omar, 2)];
    const file = await write(ops);
    const x = await openExchange(file, { tmpDir: dir });
    expect(x.signature).toBe('valid');
    expect(x.ops.map((o) => o.id)).toEqual(
      [...ops].sort((a, b) => (a.chain < b.chain ? -1 : 1)).map((o) => o.id),
    );
    expect(x.devices.map((d) => d.id).sort()).toEqual(
      [rana.signer.device, omar.signer.device].sort(),
    );
    expect(x.header.counts).toMatchObject({ ops: 5, devices: 2, blobs: 0 });
    expect(x.header.chains).toHaveLength(2);
  });

  it('a patch carries only the ops after the peer heads', () => {
    const ops = patches(rana, 5);
    const peer = headsOf(ops.slice(0, 3));
    expect(opsSince(ops, peer).map((o) => o.seq)).toEqual([4, 5]);
  });

  it('a bundle carries the blobs, and each copies out checked against its hash', async () => {
    const data = Buffer.from('photo bytes '.repeat(1000));
    const src = join(dir, 'photo.jpg');
    await writeFile(src, data);
    const sha = sha256Hex(data);
    const file = await write(patches(rana, 1), {
      kind: 'bundle',
      blobs: [{ sha256: sha, size: data.length, file: src }],
    });
    const x = await openExchange(file, { tmpDir: dir });
    expect(x.header.blobs).toEqual([{ sha256: sha, size: data.length }]);
    const preview = previewExchange(x, local({ hasBlob: () => false }));
    expect(preview.blobs).toEqual({ count: 1, bytes: data.length, missing: 1 });
    const dest = join(dir, 'copied.jpg');
    expect(await x.copyBlob(sha, dest)).toBe(true);
    expect(await readFile(dest)).toEqual(data);
  });

  it('refuses a bundle whose file changed after it was registered', async () => {
    const src = join(dir, 'changed.bin');
    await writeFile(src, 'now');
    await expect(
      write(patches(rana, 1), {
        kind: 'bundle',
        blobs: [{ sha256: 'a'.repeat(64), size: 3, file: src }],
      }),
    ).rejects.toThrow(/changed after it was registered/);
  });

  it('import is idempotent: a second plan has only duplicates and says already applied', async () => {
    const ops = patches(rana, 4);
    const x = await openExchange(await write(ops), { tmpDir: dir });
    const first = previewExchange(x, local());
    expect(first).toMatchObject({ newOps: 4, alreadyHave: 0, alreadyApplied: false });
    expect(first.byKind).toEqual({ 'issue.patch': 4 });
    const after = local({ heads: headsOf(ops), ops });
    const again = previewExchange(x, after);
    expect(again).toMatchObject({ newOps: 0, alreadyHave: 4, alreadyApplied: true });
  });

  it('holds ops after a gap, then releases them when the gap fills', () => {
    const ops = patches(omar, 6);
    const plan = planIngest({ heads: headsOf(ops.slice(0, 1)) }, ops.slice(3));
    expect(plan.apply).toHaveLength(0);
    expect(plan.held.map((o) => o.seq)).toEqual([4, 5, 6]);
    expect(plan.gaps).toEqual([{ chain: omar.chain, device: omar.signer.device, upTo: 3 }]);
    const filled = planIngest({ heads: headsOf(ops.slice(0, 1)) }, [
      ...plan.held,
      ...ops.slice(1, 3),
    ]);
    expect(filled.apply.map((o) => o.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(filled.held).toHaveLength(0);
  });

  it('refuses a fork: an op that does not link to the head this copy holds', () => {
    const mine = patches(rana, 2);
    const other = chainOps(rana, [{ payload: { set: { title: 'fork' } } }], mine[0] ?? null);
    const plan = planIngest({ heads: headsOf(mine) }, other);
    expect(plan.forks).toHaveLength(1);
    expect(plan.apply).toHaveLength(0);
  });

  it('a header signed by another key is invalid; an unknown sender is unknown', async () => {
    const ops = patches(rana, 1);
    const file = await write(ops, { devices: [rana.record] });
    // re-sign the header with Omar's key while it still claims to be Rana's device
    const x = await openExchange(file, { tmpDir: dir });
    const forged = { ...x.header, sig: omar.signer.sign('aio.exchange/1', 'f'.repeat(64)) };
    const forgedFile = out();
    await writeExchangeZip(forgedFile, [
      { name: exchangeMembers.header, data: Buffer.from(JSON.stringify(forged)) },
      {
        name: exchangeMembers.device(rana.signer.device),
        data: Buffer.from(JSON.stringify(rana.record)),
      },
      { name: x.header.chains[0]?.member ?? '', data: Buffer.from(`${JSON.stringify(ops[0])}\n`) },
    ]);
    expect((await openExchange(forgedFile, { tmpDir: dir })).signature).toBe('invalid');

    const noDevice = out();
    await writeExchangeZip(noDevice, [
      {
        name: exchangeMembers.header,
        data: Buffer.from(
          JSON.stringify({ ...x.header, counts: { ...x.header.counts, devices: 0 } }),
        ),
      },
      { name: x.header.chains[0]?.member ?? '', data: Buffer.from(`${JSON.stringify(ops[0])}\n`) },
    ]);
    expect((await openExchange(noDevice, { tmpDir: dir })).signature).toBe('unknown-device');
  });

  it('refuses an op edited after it was made, naming the change', async () => {
    const ops = patches(rana, 2);
    const file = await write(ops);
    const x = await openExchange(file, { tmpDir: dir });
    const edited = { ...ops[1], payload: { set: { title: 'quietly changed' } } };
    const bad = out();
    await writeExchangeZip(bad, [
      { name: exchangeMembers.header, data: Buffer.from(JSON.stringify(x.header)) },
      {
        name: exchangeMembers.device(rana.signer.device),
        data: Buffer.from(JSON.stringify(rana.record)),
      },
      {
        name: exchangeMembers.device(omar.signer.device),
        data: Buffer.from(JSON.stringify(omar.record)),
      },
      {
        name: x.header.chains[0]?.member ?? '',
        data: Buffer.from(`${JSON.stringify(ops[0])}\n${JSON.stringify(edited)}\n`),
      },
    ]);
    await expect(openExchange(bad, { tmpDir: dir })).rejects.toThrow(
      /change #2 .* was edited after it was made/,
    );
  });

  it('encrypts with a passphrase (AES-256-GCM, scrypt) and opens only with it', async () => {
    const ops = patches(rana, 3);
    const file = await write(ops, { passphrase: 'correct horse battery' });
    const head = (await readFile(file)).subarray(0, 40).toString('utf8');
    expect(head).toContain('aio.exchange-enc/1');
    expect((await readFile(file)).includes(Buffer.from(rana.name))).toBe(false);
    await expect(openExchange(file, { tmpDir: dir })).rejects.toMatchObject({
      code: 'needs-passphrase',
    });
    await expect(
      openExchange(file, { tmpDir: dir, passphrase: 'wrong one' }),
    ).rejects.toMatchObject({
      code: 'passphrase',
    });
    const x = await openExchange(file, { tmpDir: dir, passphrase: 'correct horse battery' });
    expect(x.header.encrypted).toBe(true);
    expect(x.ops).toHaveLength(3);
    await x.close();
    // cut short: refused as damaged, never opened
    const whole = await readFile(file);
    const cutFile = out();
    await writeFile(cutFile, whole.subarray(0, whole.length - 5));
    await expect(
      openExchange(cutFile, { tmpDir: dir, passphrase: 'correct horse battery' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/damaged|passphrase/) as unknown });
  });

  it('refuses an exchange file over 2 GB with a clear message, before and on import', async () => {
    const ops = patches(rana, 1);
    await expect(
      write(ops, {
        kind: 'bundle',
        blobs: [{ sha256: 'b'.repeat(64), size: EXCHANGE_MAX_BYTES, file: join(dir, 'none') }],
      }),
    ).rejects.toThrow(/limited to 2 GB/);
    const big = out();
    const fh = await open(big, 'w');
    await fh.truncate(EXCHANGE_MAX_BYTES + 1);
    await fh.close();
    await expect(openExchange(big, { tmpDir: dir })).rejects.toMatchObject({ code: 'too-large' });
    await rm(big);
  });
});

// ---- hostile archives, written byte by byte ----

interface RawMember {
  name: string;
  data?: Buffer;
  /** Central directory overrides. */
  declared?: number;
  link?: boolean;
  offset?: number;
}

function rawZip(members: RawMember[], opts: { cutDirectory?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let pos = 0;
  for (const m of members) {
    const name = Buffer.from(m.name);
    const data = m.data ?? Buffer.from('{}');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data) >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const offset = m.offset ?? pos;
    parts.push(local, name, data);
    pos += 30 + name.length + data.length;
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(m.link ? (3 << 8) | 20 : 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc32(data) >>> 0, 16);
    c.writeUInt32LE(m.declared ?? data.length, 20);
    c.writeUInt32LE(m.declared ?? data.length, 24);
    c.writeUInt16LE(name.length, 28);
    if (m.link) c.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(opts.cutDirectory ? cd.length + 500 : cd.length, 12);
  eocd.writeUInt32LE(pos, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

describe('hostile exchange files', () => {
  const header = exchangeMembers.header;
  const cases: [string, Buffer, RegExp][] = [
    [
      'a ../ member',
      rawZip([{ name: header }, { name: '../evil.txt' }]),
      /points outside the file/,
    ],
    [
      'an absolute path',
      rawZip([{ name: header }, { name: '/etc/passwd' }]),
      /points outside the file/,
    ],
    [
      'a drive path',
      rawZip([{ name: header }, { name: 'C:/Windows/x' }]),
      /points outside the file/,
    ],
    ['a duplicate name', rawZip([{ name: header }, { name: header }]), /appears twice/],
    ['a link', rawZip([{ name: header, link: true }]), /is a link/],
    [
      'an unknown member',
      rawZip([{ name: header }, { name: 'payload.exe' }]),
      /not a member an exchange file may carry/,
    ],
    [
      'a declared size larger than the file',
      rawZip([{ name: header, declared: 50_000_000 }]),
      /declares more bytes than the file holds/,
    ],
    [
      'a truncated central directory',
      rawZip([{ name: header }], { cutDirectory: true }),
      /central directory is cut short/,
    ],
    [
      'overlapping members (a zip bomb)',
      rawZip([
        { name: header, data: Buffer.alloc(200, 32) },
        { name: exchangeMembers.blob('c'.repeat(64)), data: Buffer.alloc(10, 1), offset: 0 },
      ]),
      /overlap|different local name/,
    ],
  ];
  for (const [what, bytes, message] of cases) {
    it(`refuses ${what} with an exact error`, async () => {
      const file = out();
      await writeFile(file, bytes);
      const e = await openExchange(file, { tmpDir: dir }).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(ExchangeError);
      expect((e as Error).message).toMatch(message);
    });
  }

  it('refuses a file that is not an exchange file at all', async () => {
    const file = out();
    await writeFile(file, 'hello, not a zip');
    await expect(openExchange(file, { tmpDir: dir })).rejects.toMatchObject({
      code: 'not-exchange',
    });
  });

  it('fuzzed bytes always give an ExchangeError, never a crash', async () => {
    const good = await readFile(await write(patches(rana, 3)));
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 150; i++) {
      const bytes = Buffer.from(good);
      const flips = 1 + Math.floor(rand() * 8);
      for (let f = 0; f < flips; f++)
        bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
      const cut = rand() < 0.2 ? Math.floor(rand() * bytes.length) : bytes.length;
      const file = join(dir, 'fuzz.aiosync');
      await writeFile(file, bytes.subarray(0, cut));
      const r = await openExchange(file, { tmpDir: dir }).then(
        () => null,
        (err: unknown) => err,
      );
      if (r !== null) expect(r).toBeInstanceOf(ExchangeError);
    }
    // 150 open attempts on disk: seconds on a loaded Windows machine.
  }, 30_000);
});
