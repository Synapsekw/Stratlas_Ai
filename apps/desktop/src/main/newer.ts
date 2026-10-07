/**
 * The "saved by a newer version" guard of the main-process readers and writers
 * (docs/release/UPGRADE-POLICY.md, rule 3): a file written by a newer Stratlas is refused with the
 * update message, and nothing here ever writes over one.
 */
import { brand } from '@aio/brand';
import { readVersioned } from '@aio/schema';
import { readFile } from 'node:fs/promises';

/** Accepts anything: only the version check of `readVersioned` is wanted here. */
const anyValue = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };

/**
 * The update message when `raw` declares a newer version of `family` than this build reads, else
 * null (current, older, unversioned, other families and invalid files are the reader's own call).
 */
export function newerThanThisBuild(raw: unknown, family: string, what: string): string | null {
  const r = readVersioned(raw, { family, schema: anyValue, appName: brand.productName, what });
  return !r.ok && r.reason === 'newer' ? r.error : null;
}

/** JSON text to a value, without a leading byte order mark; undefined when it is not JSON. */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The update message when the file at `path` (about to be replaced) was saved by a newer build;
 * null when it is missing, unreadable, not JSON or not newer.
 */
export async function newerOnDisk(
  path: string,
  family: string,
  what: string,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  return newerThanThisBuild(parseJsonText(text), family, what);
}
