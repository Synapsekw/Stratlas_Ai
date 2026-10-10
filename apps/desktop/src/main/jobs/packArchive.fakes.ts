/**
 * Tiny fake pipeline pack archives for the unit tests and the e2e spec of the pack installer
 * (packInstall.ts). The tar is written by hand, entry by entry and exactly as given, so a test
 * can hold what no archiver would write: an absolute path, a `..`, a link that leads out.
 * Never the real pack (400 MB).
 */
import { PIPELINES } from '@aio/schema';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export interface FakeTarEntry {
  path: string;
  /** `file` by default. */
  type?: 'file' | 'dir' | 'symlink' | 'link' | 'fifo';
  data?: string | Buffer;
  /** Target of a `symlink` or `link`. */
  linkpath?: string;
  mode?: number;
}

const TYPE_FLAG = { file: '0', link: '1', symlink: '2', dir: '5', fifo: '6' } as const;

function header(e: FakeTarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  const text = (value: string, at: number, length: number) => {
    const b = Buffer.from(value, 'utf8');
    if (b.length > length) throw new Error(`fake tar: "${value}" is longer than ${String(length)}`);
    b.copy(h, at);
  };
  const octal = (value: number, at: number, length: number) => {
    text(`${value.toString(8).padStart(length - 1, '0')}\0`, at, length);
  };
  const type = e.type ?? 'file';
  text(e.path, 0, 100);
  octal(e.mode ?? (type === 'dir' ? 0o755 : 0o644), 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(1_760_000_000, 136, 12);
  h.fill(' ', 148, 156); // the checksum is summed with its own field as spaces
  text(TYPE_FLAG[type], 156, 1);
  text(e.linkpath ?? '', 157, 100);
  text('ustar\0', 257, 6);
  text('00', 263, 2);
  let sum = 0;
  for (const byte of h) sum += byte;
  text(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** A ustar archive of `entries`, in their order, with the end-of-archive blocks. */
export function fakeTar(entries: readonly FakeTarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const isFile = (e.type ?? 'file') === 'file';
    const data = isFile ? Buffer.from(e.data ?? '') : Buffer.alloc(0);
    parts.push(header(e, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const fakeTarGz = (entries: readonly FakeTarEntry[]): Buffer => gzipSync(fakeTar(entries));

export interface FakePackOptions {
  platform?: string;
  appRange?: string;
  /** Pipeline names in the manifest; every pipeline the app knows by default (an up to date pack). */
  pipelines?: readonly string[];
  /** False leaves the Python out of the archive (the manifest still names it). */
  python?: boolean;
  /** The Python the manifest names; `python/python.exe` by default (a Windows pack). */
  executable?: string;
  /** The file written as the Python when `executable` is a link to it (`python/bin/python3.13`). */
  pythonFile?: string;
  /** More files of the pack, by path inside it. */
  files?: Record<string, string | Buffer>;
  /** The archive's top folder; `pipeline-pack-<version>` by default. */
  top?: string;
  /** Change the manifest before it is written (a wrong checksum, a file that is not there). */
  manifest?: (m: Record<string, unknown>) => void;
}

/** The manifest `fakePackEntries` writes: every file listed with its size and SHA-256. */
export function fakePackManifest(
  version: string,
  files: Record<string, string | Buffer>,
  o: FakePackOptions = {},
): Record<string, unknown> {
  const names = o.pipelines ?? PIPELINES.map((p) => p.name);
  const listed: Record<string, { size: number; sha256: string }> = {};
  for (const [name, data] of Object.entries(files)) {
    const b = Buffer.from(data);
    listed[name] = { size: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  }
  const m: Record<string, unknown> = {
    schema: 'aio.pipeline-pack/1',
    version,
    protocol: 'aio.pipelines/1',
    ...(o.appRange !== undefined ? { appRange: o.appRange } : {}),
    python: {
      version: '3.13.7',
      build: '20260924',
      executable: o.executable ?? 'python/python.exe',
    },
    platform: o.platform ?? 'win32-x64',
    createdAt: '2026-10-10T10:00:00Z',
    pipelines: names.map((name) => ({
      name,
      title: PIPELINES.find((p) => p.name === name)?.title ?? name,
    })),
    files: listed,
  };
  o.manifest?.(m);
  return m;
}

/** The files of a fake pack `version` (its Python is a few bytes of text), manifest first. */
export function fakePackFiles(
  version: string,
  o: FakePackOptions = {},
): Record<string, string | Buffer> {
  const python = o.pythonFile ?? o.executable ?? 'python/python.exe';
  const files: Record<string, string | Buffer> = {
    [python]: `fake python of pack ${version}`,
    ...o.files,
  };
  const manifest = JSON.stringify(fakePackManifest(version, files, o));
  if (o.python === false) Reflect.deleteProperty(files, python);
  return { 'manifest.json': manifest, ...files };
}

/** The tar entries of a fake pack archive: `pipeline-pack-<version>/` with `fakePackFiles`. */
export function fakePackEntries(version: string, o: FakePackOptions = {}): FakeTarEntry[] {
  const top = o.top ?? `pipeline-pack-${version}`;
  const entries: FakeTarEntry[] = [{ path: `${top}/`, type: 'dir' }];
  const dirs = new Set<string>();
  for (const [name, data] of Object.entries(fakePackFiles(version, o))) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      entries.push({ path: `${top}/${dir}/`, type: 'dir' });
    }
    entries.push({ path: `${top}/${name}`, data });
  }
  return entries;
}

/** A fake pack archive as CI names and builds it: `pipeline-pack-<version>-<arch>.tar.gz`. */
export const fakePackArchive = (version: string, o: FakePackOptions = {}): Buffer =>
  fakeTarGz(fakePackEntries(version, o));
