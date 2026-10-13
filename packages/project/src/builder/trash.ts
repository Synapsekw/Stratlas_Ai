import { lstat, mkdir, readdir, rm as fsRm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * The project trash (data-conventions section 33): one entry per removal, `<stamp>-<slug>`,
 * swept seven days later when the project opens, or all at once by Empty project trash.
 */

export const TRASH_DIR = '.trash';
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
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

const removeTree = (p: string) => fsRm(p, { recursive: true, force: true, maxRetries: 3 });

export async function pathBytes(abs: string): Promise<number> {
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(abs)) total += await pathBytes(join(abs, name));
  return total;
}

export async function freeTrashEntry(root: string, at: Date, slug: string): Promise<string> {
  const base = join(root, TRASH_DIR, `${stampOf(at)}-${slug}`);
  await mkdir(join(root, TRASH_DIR), { recursive: true });
  if (!(await exists(base))) return base;
  for (let n = 2; ; n++) {
    const name = `${base}-${String(n)}`;
    if (!(await exists(name))) return name;
  }
}

async function entries(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, TRASH_DIR));
  } catch {
    return [];
  }
}

export async function sweepTrash(
  root: string,
  now: () => Date = () => new Date(),
  keepMs: number = TRASH_KEEP_DAYS * DAY_MS,
  o: TrashOptions = {},
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await entries(root)) {
    const at = stampTime(name);
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

export async function trashSize(root: string): Promise<{ bytes: number; entries: number }> {
  const names = await entries(root);
  let bytes = 0;
  for (const name of names) bytes += await pathBytes(join(root, TRASH_DIR, name));
  return { bytes, entries: names.length };
}

export async function emptyTrash(
  root: string,
  o: TrashOptions = {},
): Promise<{ freed: number; removed: string[]; held: string[] }> {
  const removed: string[] = [];
  const held: string[] = [];
  let freed = 0;
  for (const name of await entries(root)) {
    const abs = join(root, TRASH_DIR, name);
    const bytes = await pathBytes(abs);
    try {
      await (o.rm ?? removeTree)(abs);
      removed.push(name);
      freed += bytes;
    } catch {
      held.push(name);
    }
  }
  return { freed, removed, held };
}
