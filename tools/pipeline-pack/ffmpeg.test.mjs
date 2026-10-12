import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkFfmpegTool,
  FFMPEG_LOCK,
  FFMPEG_PLATFORMS,
  FFMPEG_SPEC,
  ffmpegExe,
  ffmpegProblems,
  peImports,
  windowsKeep,
} from './ffmpeg.mjs';
import { lockedPackages, PLATFORMS } from './pdal.mjs';

/** A minimal PE32+ file whose import table (and delay-load table) names `dlls`. */
function fakePe(dlls, delayed = []) {
  const buf = Buffer.alloc(0x800);
  buf.write('MZ', 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'latin1');
  const coff = 0x84;
  buf.writeUInt16LE(0x8664, coff);
  buf.writeUInt16LE(1, coff + 2); // one section
  buf.writeUInt16LE(240, coff + 16); // size of the optional header (PE32+)
  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt);
  buf.writeUInt32LE(16, opt + 108); // number of data directories
  const dirs = opt + 112;
  const sect = opt + 240;
  // .idata: virtual address 0x1000 at file offset 0x200
  buf.write('.idata', sect, 'latin1');
  buf.writeUInt32LE(0x600, sect + 8);
  buf.writeUInt32LE(0x1000, sect + 12);
  buf.writeUInt32LE(0x600, sect + 16);
  buf.writeUInt32LE(0x200, sect + 20);
  const rva = (off) => off - 0x200 + 0x1000;
  let names = 0x500;
  const name = (s) => {
    const at = names;
    buf.write(`${s}\0`, at, 'latin1');
    names += s.length + 1;
    return rva(at);
  };
  // import descriptors (20 bytes, name RVA at +12), zero-terminated
  dlls.forEach((d, i) => buf.writeUInt32LE(name(d), 0x200 + i * 20 + 12));
  buf.writeUInt32LE(rva(0x200), dirs + 8);
  // delay-load descriptors (32 bytes, name RVA at +4)
  delayed.forEach((d, i) => {
    buf.writeUInt32LE(1, 0x380 + i * 32);
    buf.writeUInt32LE(name(d), 0x380 + i * 32 + 4);
  });
  if (delayed.length > 0) buf.writeUInt32LE(rva(0x380), dirs + 13 * 8);
  return buf;
}

describe('the ffmpeg lock', () => {
  it("has every pack platform, each with conda-forge's GPL ffmpeg pinned by SHA-256", () => {
    expect(FFMPEG_PLATFORMS).toEqual(Object.keys(PLATFORMS));
    for (const platform of FFMPEG_PLATFORMS) {
      const pkgs = lockedPackages(platform, FFMPEG_LOCK, 'ffmpeg-lock.json');
      const ffmpeg = pkgs.find((p) => p.name === 'ffmpeg');
      expect(ffmpeg.build, platform).toMatch(/^gpl_/);
      expect(ffmpeg.version).toBe(FFMPEG_SPEC.split('=')[1]);
      expect(pkgs.map((p) => p.name)).toContain('x264');
      for (const p of pkgs) {
        expect(p.url).toMatch(/^https:\/\/conda\.anaconda\.org\/conda-forge\//);
        expect(p.url).toMatch(new RegExp(`/(${PLATFORMS[platform].subdir}|noarch)/`));
        expect(p.sha256, p.name).toMatch(/^[a-f0-9]{64}$/);
        expect(p.license, p.name).toBeTruthy();
      }
    }
  });

  it("keeps the solver's install order, so a post-link script finds its libraries", () => {
    for (const platform of FFMPEG_PLATFORMS) {
      const names = lockedPackages(platform, FFMPEG_LOCK, 'ffmpeg-lock.json').map((p) => p.name);
      expect(names.at(-1), platform).toBe('ffmpeg');
      // gdk-pixbuf's post-link script runs a program that loads GLib
      expect(names.indexOf('libglib')).toBeLessThan(names.indexOf('gdk-pixbuf'));
    }
  });
});

describe('what of the ffmpeg environment goes into the pack', () => {
  it('keeps ffmpeg, ffprobe and the DLLs they load, under Library/bin', () => {
    const loaded = new Set(['avcodec-61.dll', 'libx264-164.dll', 'vcruntime140.dll']);
    expect(windowsKeep('Library/bin/ffmpeg.exe', loaded)).toBe('Library/bin/ffmpeg.exe');
    expect(windowsKeep('Library/bin/ffprobe.exe', loaded)).toBe('Library/bin/ffprobe.exe');
    expect(windowsKeep('Library/bin/avcodec-61.dll', loaded)).toBe('Library/bin/avcodec-61.dll');
    expect(windowsKeep('Library/bin/libx264-164.dll', loaded)).toBe('Library/bin/libx264-164.dll');
    expect(windowsKeep('vcruntime140.dll', loaded)).toBe('Library/bin/vcruntime140.dll');
  });

  it('leaves out ffplay, unloaded DLLs, headers, static and import libraries', () => {
    const loaded = new Set(['avcodec-61.dll']);
    for (const rel of [
      'Library/bin/ffplay.exe',
      'Library/bin/SDL2.dll',
      'Library/include/libavcodec/avcodec.h',
      'Library/lib/avcodec.lib',
      'Library/lib/libx264.a',
      'Library/lib/pkgconfig/libavcodec.pc',
      'Library/share/doc/ffmpeg/LICENSE.md',
      'conda-meta/ffmpeg-7.1.1.json',
    ])
      expect(windowsKeep(rel, loaded), rel).toBeNull();
  });

  it('reads the DLLs a Windows program imports, delay-loaded ones too', () => {
    expect(peImports(fakePe(['avcodec-61.dll', 'KERNEL32.dll'], ['avdevice-61.dll']))).toEqual([
      'avcodec-61.dll',
      'KERNEL32.dll',
      'avdevice-61.dll',
    ]);
    expect(peImports(Buffer.from('not a program'))).toEqual([]);
  });

  it('finds the program inside the installed folder', () => {
    expect(ffmpegExe('/p', 'win32-x64')).toBe(join('/p', 'Library', 'bin', 'ffmpeg.exe'));
    expect(ffmpegExe('/p', 'darwin-arm64')).toBe(join('/p', 'bin', 'ffmpeg'));
    expect(ffmpegExe('/p', 'win32-x64', 'ffprobe')).toBe(
      join('/p', 'Library', 'bin', 'ffprobe.exe'),
    );
  });
});

describe('the ffmpeg check', () => {
  const filters = [
    'Filters:',
    '  T.. = Timeline support',
    ' ... v360              V->V       Convert 360 projection of video.',
    ' TSC scale             V->V       Scale the input video size.',
  ].join('\n');
  const encoders = [
    'Encoders:',
    ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
    ' V....D mpeg4                MPEG-4 part 2',
  ].join('\n');
  const decoders = [
    'Decoders:',
    ' VFS..D hevc                 HEVC (High Efficiency Video Coding)',
    ' VFS..D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
  ].join('\n');

  it('passes an ffmpeg with v360, libx264 and the HEVC decoder', () => {
    expect(ffmpegProblems({ filters, encoders, decoders })).toEqual([]);
  });

  it("reads ffmpeg 9's two-column filter flags too", () => {
    const nine = ' .S v360              V->V       Convert 360 projection of video.';
    expect(ffmpegProblems({ filters: nine, encoders, decoders })).toEqual([]);
  });

  it('names what is missing', () => {
    expect(
      ffmpegProblems({
        filters: filters.replace('v360', 'v361'),
        encoders: encoders.replace(/libx264/g, 'libopenh264'),
        decoders: decoders.replace('hevc ', 'hevc_qsv '),
      }),
    ).toEqual(['v360 filter', 'libx264 encoder', 'hevc decoder']);
  });
});

describe('checkFfmpegTool', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-check-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a folder without ffmpeg as missing it', () => {
    writeFileSync(join(dir, 'readme.txt'), 'x');
    expect(checkFfmpegTool(dir, 'win32-x64')).toEqual({ version: '', missing: ['ffmpeg'] });
  });
});
