import type { ZipArchive } from '@aio/project/package';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LOGO_NAME } from '../branding';
import { findThumb } from '../thumbs';
import { LEGACY_CSP, isLegacyDocument, prepareLegacyHtml } from './legacy';
import { mimeFor } from './mime';
import { resolveInside } from './paths';
import { parseRange } from './range';

export interface AioRoots {
  /** Root folder of an opened project, or undefined when the id is not registered. */
  projectRoot(id: string): string | undefined;
  /** Archive of a project opened from a `.aio` package, served in place. */
  projectPackage?(id: string): ZipArchive | undefined;
  /** Folder that holds `<id>.pmtiles` map packs. */
  packsDir(): string;
  /** userData folder of generated thumbnails (`aio://thumb/...`). */
  thumbsDir?(): string;
  /** userData folder of the report logo (`aio://branding/<file>`). */
  brandingDir?(): string;
  /** A map pack carried inside an open package (`packs/<id>.pmtiles`), served in place. */
  embeddedPack?(id: string): { archive: ZipArchive; member: string } | undefined;
}

const PACK = /^([a-z0-9-]+)\.pmtiles$/;

// Only the app itself can reach aio://, so a wildcard origin is safe and lets loaders that set
// crossOrigin (three.js, MapLibre, <video crossorigin>) read the bytes from the file:// page.
const COMMON = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };

function status(code: number): Response {
  const text = code === 403 ? 'Forbidden' : code === 405 ? 'Method not allowed' : 'Not found';
  return new Response(text, { status: code, headers: COMMON });
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/**
 * Thumbnails and the logo do not change under their URL (a new source image or logo gets a new
 * cache key or file name), so the renderer may keep them in its memory cache.
 */
const KEEP = { 'Cache-Control': 'max-age=3600' };

/** Serve one file with HTTP Range support and a streamed body. */
export async function serveFile(
  file: string,
  req: Request,
  extra: Record<string, string> = {},
): Promise<Response> {
  let size: number;
  try {
    const s = await stat(file);
    if (!s.isFile()) return status(404);
    size = s.size;
  } catch {
    return status(404);
  }
  const headers: Record<string, string> = {
    ...COMMON,
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    ...extra,
  };
  const range = parseRange(req.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  headers['Content-Length'] = String(length);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const code = range ? 206 : 200;

  if (req.method === 'HEAD' || length === 0) {
    return new Response(null, { status: code, headers });
  }
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: code, headers });
}

/** Serve one member of a store-mode package with HTTP Range support, read in place. */
export async function serveMember(
  archive: ZipArchive,
  name: string,
  req: Request,
  extra: Record<string, string> = {},
) {
  const entry = archive.entries.get(name);
  if (!entry) return status(404);
  const size = entry.size;
  const headers: Record<string, string> = {
    ...COMMON,
    'Content-Type': mimeFor(name),
    'Accept-Ranges': 'bytes',
    ...extra,
  };
  const range = parseRange(req.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${String(size)}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  headers['Content-Length'] = String(length);
  if (range) headers['Content-Range'] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
  const code = range ? 206 : 200;
  if (req.method === 'HEAD' || length === 0) return new Response(null, { status: code, headers });
  try {
    const stream = await archive.stream(name, start, end);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: code,
      headers,
    });
  } catch {
    return status(404);
  }
}

/**
 * Serve a legacy viewer document: shims injected, remote links removed, legacy CSP. The page
 * is small and rewritten, so it is always a whole 200 response.
 */
async function serveLegacyDocument(read: () => Promise<string>, projectId: string, req: Request) {
  let html: string;
  try {
    html = prepareLegacyHtml(await read(), projectId);
  } catch {
    return status(404);
  }
  const headers = {
    ...COMMON,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html)),
    'Content-Security-Policy': LEGACY_CSP,
  };
  return new Response(req.method === 'HEAD' ? null : html, { status: 200, headers });
}

/**
 * Handler for `protocol.handle('aio', ...)`:
 * - `aio://project/<id>/<path>` serves a file inside the registered project root, or a member
 *   of an opened `.aio` package (by offset, in place).
 * - `aio://project/<id>/legacy/<...>.html` serves a legacy viewer with its shims (legacy.ts).
 * - `aio://packs/<id>.pmtiles` serves a map pack from the packs folder, or one carried inside
 *   an open package (`roots.embeddedPack`).
 * - `aio://thumb/<id>/<path>` serves a small thumbnail of a project image, or 404 (thumbs.ts).
 * - `aio://branding/<logo>` serves the person's report logo from userData.
 */
export function createAioHandler(roots: AioRoots): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return status(405);
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return status(404);
    }
    const segments = decodeSegments(url.pathname);
    if (!segments) return status(404);

    if (url.host === 'project') {
      const [id, ...rest] = segments;
      if (id === undefined || rest.length === 0) return status(404);
      const archive = roots.projectPackage?.(id);
      if (archive) {
        if (rest.some((s) => s === '..' || s === '.' || s.includes('\\'))) return status(404);
        const name = rest.join('/');
        if (!archive.entries.has(name)) return status(404);
        if (isLegacyDocument(rest)) {
          return serveLegacyDocument(
            async () => (await archive.read(name)).toString('utf8'),
            id,
            req,
          );
        }
        return serveMember(archive, name, req);
      }
      const root = roots.projectRoot(id);
      if (root === undefined) return status(404);
      const resolved = await resolveInside(root, rest.join('/'));
      if (!resolved.ok) return status(resolved.status);
      if (isLegacyDocument(rest)) {
        return serveLegacyDocument(() => readFile(resolved.path, 'utf8'), id, req);
      }
      return serveFile(resolved.path, req);
    }

    if (url.host === 'thumb') {
      const [id, ...rest] = segments;
      const cacheDir = roots.thumbsDir?.();
      if (id === undefined || rest.length === 0 || cacheDir === undefined) return status(404);
      const archive = roots.projectPackage?.(id);
      const root = roots.projectRoot(id);
      const source = archive ? { archive } : root !== undefined ? { root } : null;
      if (!source) return status(404);
      const found = await findThumb(source, rest.join('/'), cacheDir);
      if (found.kind === 'file') return serveFile(found.path, req, KEEP);
      if (found.kind === 'member') return serveMember(found.archive, found.name, req, KEEP);
      return status(found.kind === 'forbidden' ? 403 : 404);
    }

    if (url.host === 'branding') {
      const [name, ...rest] = segments;
      const dir = roots.brandingDir?.();
      if (name === undefined || rest.length > 0 || !LOGO_NAME.test(name) || dir === undefined)
        return status(404);
      return serveFile(join(dir, name), req, KEEP);
    }

    if (url.host === 'packs') {
      const [name, ...rest] = segments;
      const m = name === undefined || rest.length > 0 ? null : PACK.exec(name);
      if (!m?.[1] || name === undefined) return status(404);
      const embedded = roots.embeddedPack?.(m[1]);
      if (embedded) return serveMember(embedded.archive, embedded.member, req);
      return serveFile(join(roots.packsDir(), name), req);
    }

    return status(404);
  };
}
