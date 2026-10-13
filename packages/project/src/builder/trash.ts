import { PHOTO_DIR, PhotoRunId, TrashRecord, type ProjectManifest } from '@aio/schema';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename as fsRename,
  rm as fsRm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { readManifestFile } from './manifestFile';

/*
 * The project trash (data-conventions section 33): one entry per removal, `<stamp>-<slug>`,
 * swept seven days later when the project opens, or all at once by Empty project trash.
 */

export const TRASH_DIR = '.trash';
/**
 * A removal works in `held-<stamp>-<slug>` and renames it to `<stamp>-<slug>` once the manifest is
 * saved. An entry still named so is not trash until the trash reads it and finds the removal took
 * effect (`removed.json` there, and none of its layers, dates or runs still in the project); then it
 * gets its stamped name. Otherwise (a failed removal whose files could not come back, no record)
 * the sweep, the size and Empty project trash pass it by: the person moves its files back by hand.
 */
export const HELD_PREFIX = 'held-';
/** Written into a held entry by a removal that failed: it never took effect, whatever the manifest says. */
export const HELD_NOTE = 'not-removed.txt';
/** How long removed files are kept. */
export const TRASH_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-|$)/;

export function stampOf(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export function stampTime(name: string): number | null {
  const m = STAMP.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, se ?? 0);
}

export interface TrashOptions {
  rm?: (path: string) => Promise<void>;
  /** The rename giving a held entry its stamped name (tests hand in one that fails). */
  rename?: (from: string, to: string) => Promise<void>;
  /** The project's manifest; read from `root` when not given. */
  manifest?: ProjectManifest;
}

interface Entry {
  name: string;
  /** From the stamped name, also for a held entry that took effect but kept its name. */
  at: number | null;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const removeTree = (p: string) => fsRm(p, { recursive: true, force: true, maxRetries: 3 });

export async function pathBytes(
  abs: string,
  readDir: (path: string) => Promise<string[]> = readdir,
): Promise<number> {
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  let names: string[];
  try {
    names = await readDir(abs);
  } catch {
    return 0; // vanished or refused: counts as nothing
  }
  for (const name of names) total += await pathBytes(join(abs, name), readDir);
  return total;
}

export async function freeTrashEntry(root: string, at: Date, slug: string): Promise<string> {
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw new Error(`"${slug}" cannot name a trash entry.`);
  }
  const base = join(root, TRASH_DIR, `${stampOf(at)}-${slug}`);
  await mkdir(join(root, TRASH_DIR), { recursive: true });
  if (!(await exists(base))) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${String(n)}`;
    if (!(await exists(name))) return name;
  }
}

/** A held entry whose removal took effect: a valid record, and nothing it removed is still here. */
async function tookEffect(root: string, dir: string, m: ProjectManifest): Promise<boolean> {
  if (await exists(join(dir, HELD_NOTE))) return false;
  let rec;
  try {
    rec = TrashRecord.safeParse(JSON.parse(await readFile(join(dir, 'removed.json'), 'utf8')));
  } catch {
    return false;
  }
  if (!rec.success) return false;
  const { plan } = rec.data;
  if (plan.layers.length + plan.captures.length + plan.runs.length === 0) return false;
  if (plan.layers.some((l) => m.layers.some((x) => x.id === l.id))) return false;
  if (plan.captures.some((c) => m.captures.some((x) => x.id === c))) return false;
  for (const r of plan.runs) {
    if (!PhotoRunId.safeParse(r.id).success) return false;
    if (await exists(join(root, PHOTO_DIR, r.id))) return false;
  }
  return true;
}

async function entries(root: string, o: TrashOptions = {}): Promise<Entry[]> {
  const dir = join(root, TRASH_DIR);
  let names: string[];
  try {
    // a link or a plain file named .trash is never followed: nothing is read or deleted through it
    if (!(await lstat(dir)).isDirectory()) return [];
    names = await readdir(dir);
  } catch {
    return [];
  }
  let manifest: ProjectManifest | null | undefined = o.manifest;
  const out: Entry[] = [];
  for (const name of names) {
    if (!name.startsWith(HELD_PREFIX)) {
      out.push({ name, at: stampTime(name) });
      continue;
    }
    if (manifest === undefined) manifest = await readManifestFile(root).catch(() => null);
    if (manifest === null || !(await tookEffect(root, join(dir, name), manifest))) continue;
    const stamped = name.slice(HELD_PREFIX.length);
    if (!(await exists(join(dir, stamped))))
      try {
        await (o.rename ?? fsRename)(join(dir, name), join(dir, stamped));
        out.push({ name: stamped, at: stampTime(stamped) });
        continue;
      } catch {
        // held open for now: trash under its held name until a later read renames it
      }
    out.push({ name, at: stampTime(stamped) });
  }
  return out;
}

export async function sweepTrash(
  root: string,
  now: () => Date = () => new Date(),
  keepMs: number = TRASH_KEEP_DAYS * DAY_MS,
  o: TrashOptions = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const { name, at } of await entries(root, o)) {
    if (at === null || now().getTime() - at <= keepMs) continue;
    try {
      await (o.rm ?? removeTree)(join(root, TRASH_DIR, name));
      removed.push(name);
    } catch {
      // held open for now: the next open tries again
    }
  }
  return removed;
}

export async function trashSize(
  root: string,
  o: TrashOptions = {},
): Promise<{ bytes: number; entries: number }> {
  const list = await entries(root, o);
  let bytes = 0;
  for (const { name } of list) bytes += await pathBytes(join(root, TRASH_DIR, name));
  return { bytes, entries: list.length };
}

export async function emptyTrash(
  root: string,
  o: TrashOptions = {},
): Promise<{ freed: number; removed: string[]; held: string[] }> {
  const removed: string[] = [];
  const held: string[] = [];
  let freed = 0;
  for (const { name } of await entries(root, o)) {
    const abs = join(root, TRASH_DIR, name);
    try {
      const bytes = await pathBytes(abs);
      await (o.rm ?? removeTree)(abs);
      removed.push(name);
      freed += bytes;
    } catch {
      held.push(name);
    }
  }
  return { freed, removed, held };
}
