import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installThermalDataset,
  installThermalTools,
  readZip,
  THERMAL_LOCK,
} from './thermal-tools.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `{ name: text }` (folders implied); `deflate` names the entries to compress. */
function makeZip(files, deflate = []) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const packed = deflate.includes(name) ? deflateRawSync(raw) : raw;
    const method = deflate.includes(name) ? 8 : 0;
    const nm = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(method, 8);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nm.length, 26);
    local.push(head, nm, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nm.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nm);
    offset += 30 + nm.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

const ARCHIVE = makeZip(
  {
    'tool-1/tool(-k).exe': 'exe',
    'tool-1/tool_files/a.pl': 'perl source '.repeat(50),
    'tool-1/tool_files/lib/deep/b.pm': 'module',
    'tool-1/README.txt': 'not unpacked',
    'sdk/bin/x64/libdirp.dll': 'dll',
    'sdk/bin/x64/libv_dirp.dll': 'dll2',
    'sdk/bin/x86/libdirp.dll': 'wrong arch',
    'sdk/License.txt': 'licence text',
  },
  ['tool-1/tool_files/a.pl'],
);

const LOCK = {
  schema: 'thermal-tools-lock/1',
  tools: [
    {
      name: 'tool',
      version: '1',
      url: 'https://example.test/tool.zip',
      sha256: sha(ARCHIVE),
      dest: 'tools/tool',
      unpack: [
        { from: 'tool-1/tool(-k).exe', to: 'tool.exe' },
        { from: 'tool-1/tool_files/', to: 'tool_files/' },
      ],
      files: ['tool.exe', 'tool_files/a.pl', 'tool_files/lib/deep/b.pm'],
    },
    {
      name: 'sdk',
      version: '2',
      url: 'https://example.test/sdk.zip',
      sha256: sha(ARCHIVE),
      dest: 'tools/sdk',
      unpack: [
        { from: 'sdk/bin/x64/', to: '' },
        { from: 'sdk/License.txt', to: 'License.txt' },
      ],
      files: ['libdirp.dll', 'libv_dirp.dll', 'License.txt'],
    },
  ],
};

describe('the pack thermal tools', () => {
  const dirs = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'aio-thermal-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const serve = (body) => {
    const calls = [];
    const fetchImpl = (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new Uint8Array(body).buffer),
      });
    };
    return { calls, fetchImpl };
  };

  it('pins ExifTool and the DJI Thermal SDK with a url, a SHA-256 and the files it unpacks', () => {
    const [exif, dji] = THERMAL_LOCK.tools;
    expect(exif.name).toBe('exiftool');
    expect(exif.unpack).toContainEqual({
      from: expect.stringMatching(/\(-k\)\.exe$/),
      to: 'exiftool.exe',
    });
    expect(exif.files).toContain('exiftool.exe');
    expect(dji.name).toBe('dji-tsdk');
    expect(dji.dest).toBe('tools/dji-tsdk');
    expect(dji.files).toEqual(expect.arrayContaining(['libdirp.dll', 'License.txt']));
    for (const t of THERMAL_LOCK.tools) {
      expect(t.url).toMatch(/^https:\/\//);
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('reads stored and deflated zip entries', () => {
    const zip = readZip(ARCHIVE);
    expect(zip.map((e) => e.name)).toContain('tool-1/tool_files/a.pl');
    const perl = zip.find((e) => e.name === 'tool-1/tool_files/a.pl');
    expect(perl.read().toString()).toBe('perl source '.repeat(50));
    expect(
      zip
        .find((e) => e.name === 'sdk/License.txt')
        .read()
        .toString(),
    ).toBe('licence text');
  });

  it('unpacks the listed files of an archive whose SHA-256 matches, and no others', async () => {
    const { fetchImpl, calls } = serve(ARCHIVE);
    const pack = tmp();
    await installThermalTools(pack, { cache: tmp(), fetchImpl, lock: LOCK });
    expect(calls).toHaveLength(1); // both tools share the one archive: the second comes from the cache
    expect(readFileSync(join(pack, 'tools/tool/tool.exe'), 'utf8')).toBe('exe');
    expect(readFileSync(join(pack, 'tools/tool/tool_files/lib/deep/b.pm'), 'utf8')).toBe('module');
    expect(existsSync(join(pack, 'tools/tool/README.txt'))).toBe(false);
    expect(readFileSync(join(pack, 'tools/sdk/libdirp.dll'), 'utf8')).toBe('dll');
    expect(readFileSync(join(pack, 'tools/sdk/License.txt'), 'utf8')).toBe('licence text');
  });

  it('fails the build on an archive with another SHA-256 and unpacks nothing', async () => {
    const { fetchImpl } = serve(makeZip({ 'tool-1/tool(-k).exe': 'tampered' }));
    const pack = tmp();
    await expect(
      installThermalTools(pack, { cache: tmp(), fetchImpl, lock: LOCK }),
    ).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(pack, 'tools'))).toBe(false);
  });

  it('fails when a listed file is not in the archive', async () => {
    const { fetchImpl } = serve(ARCHIVE);
    const lock = {
      tools: [{ ...LOCK.tools[0], files: [...LOCK.tools[0].files, 'tool_files/missing.pl'] }],
    };
    await expect(installThermalTools(tmp(), { cache: tmp(), fetchImpl, lock })).rejects.toThrow(
      /missing\.pl/,
    );
  });

  it('offline uses the cache only and never downloads', async () => {
    const { fetchImpl, calls } = serve(ARCHIVE);
    const cache = tmp();
    await expect(
      installThermalTools(tmp(), { cache, fetchImpl, lock: LOCK, offline: true }),
    ).rejects.toThrow(/offline/);
    expect(calls).toHaveLength(0);
    await installThermalTools(tmp(), { cache, fetchImpl, lock: LOCK });
    const pack = tmp();
    await installThermalTools(pack, { cache, fetchImpl, lock: LOCK, offline: true });
    expect(calls).toHaveLength(1);
    expect(existsSync(join(pack, 'tools/tool/tool.exe'))).toBe(true);
  });

  it('extracts the dataset folder of an archive on its own, outside the pack', async () => {
    const zip = makeZip({ 'sdk/dataset/M3T/a_R.JPG': 'jpg', 'sdk/bin/x': 'b' });
    const lock = { tools: [{ ...LOCK.tools[1], sha256: sha(zip), dataset: 'sdk/dataset/' }] };
    const dest = join(tmp(), 'dataset');
    const n = await installThermalDataset(dest, {
      cache: tmp(),
      fetchImpl: serve(zip).fetchImpl,
      lock,
    });
    expect(n).toBe(1);
    expect(readFileSync(join(dest, 'M3T/a_R.JPG'), 'utf8')).toBe('jpg');
    expect(existsSync(join(dest, 'bin'))).toBe(false);
  });

  it('refuses an entry that would unpack outside its folder', async () => {
    const evil = makeZip({ '../evil.txt': 'x', 'ok/a': 'a' });
    const lock = {
      tools: [
        {
          name: 'evil',
          version: '1',
          url: 'https://example.test/e.zip',
          sha256: sha(evil),
          dest: 'tools/evil',
          unpack: [{ from: '../evil.txt', to: '../../evil.txt' }],
          files: [],
        },
      ],
    };
    const { fetchImpl } = serve(evil);
    await expect(installThermalTools(tmp(), { cache: tmp(), fetchImpl, lock })).rejects.toThrow(
      /outside/,
    );
  });
});
