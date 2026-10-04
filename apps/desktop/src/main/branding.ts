/**
 * The person's report logo: copied into userData `branding/` (never into a project folder) and
 * served as `aio://branding/<file>` to the app and to the report window.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
/** Logo file names main writes; anything else under `aio://branding/` is refused. */
export const LOGO_NAME = /^logo-[a-z0-9]{6,64}\.(png|jpg|svg)$/;

type Kind = 'png' | 'jpg' | 'svg';

/** What the bytes are (by signature, not by name), or null when not a PNG, JPEG or SVG. */
export function sniffLogo(data: Uint8Array): Kind | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  let head = Buffer.from(data.subarray(0, 4096)).toString('utf8');
  // a UTF-8 byte order mark before the markup
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head))
    return 'svg';
  return null;
}

const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.svg']);

export type LogoImport = { ok: true; file: string } | { ok: false; error: string };

/** Copy a picked logo into `dir` under a content-hash name. */
export async function importLogo(src: string, dir: string): Promise<LogoImport> {
  if (!ALLOWED_EXT.has(extname(src).toLowerCase()))
    return { ok: false, error: 'Pick a PNG, JPG or SVG image for the logo.' };
  let size: number;
  try {
    const s = await stat(src);
    if (!s.isFile()) return { ok: false, error: 'The logo is not a file.' };
    size = s.size;
  } catch {
    return { ok: false, error: 'The logo file could not be read.' };
  }
  if (size === 0) return { ok: false, error: 'The logo file is empty.' };
  if (size > MAX_LOGO_BYTES) return { ok: false, error: 'The logo is larger than 5 MB.' };
  const data = await readFile(src);
  const kind = sniffLogo(data);
  if (!kind) return { ok: false, error: 'The file is not a PNG, JPG or SVG image.' };
  const file = `logo-${createHash('sha256').update(data).digest('hex').slice(0, 16)}.${kind}`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), data);
  return { ok: true, file };
}

/** Delete a logo copy main wrote earlier; other names are ignored. */
export async function removeLogo(dir: string, file: string | undefined): Promise<void> {
  if (!file || !LOGO_NAME.test(file)) return;
  await rm(join(dir, file), { force: true });
}
