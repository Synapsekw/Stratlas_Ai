import { WALKS_DIR } from '@aio/schema';

/*
 * A walk's files live in `walks/<id>/` and nowhere else. Every main side reader, writer and
 * remover of a walk's files goes through `walkFolder`, so a record path in a manifest that was
 * edited by hand (`walks/../x/walk.json`, `../walk.json`) never reaches outside the project.
 */

/** A walk id: lowercase letters, digits and dashes, starting with a letter or digit. */
export const WALK_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `walks/<id>` of a record path that is exactly `walks/<id>/<file>` with a valid id and a plain
 * file name; null for any other shape (absolute, `..`, deeper, empty parts).
 */
export function walkFolder(recordPath: string): string | null {
  const parts = recordPath.replaceAll('\\', '/').split('/');
  if (parts.length !== 3) return null;
  const [dir, id, file] = parts;
  if (dir !== WALKS_DIR || id === undefined || !WALK_ID.test(id)) return null;
  if (file === undefined || file === '' || file === '.' || file === '..') return null;
  return `${WALKS_DIR}/${id}`;
}

/** The id in `walks/<id>/<file>`, or null (see `walkFolder`). */
export function walkIdOfRecord(recordPath: string): string | null {
  const folder = walkFolder(recordPath);
  return folder === null ? null : folder.slice(WALKS_DIR.length + 1);
}
