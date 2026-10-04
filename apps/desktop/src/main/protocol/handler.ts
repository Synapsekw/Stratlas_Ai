import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LEGACY_CSP, isLegacyDocument, prepareLegacyHtml } from './legacy';
import { mimeFor } from './mime';
import { resolveInside } from './paths';
import { parseRange } from './range';

export interface AioRoots {
  /** Root folder of an opened project, or undefined when the id is not registered. */
  projectRoot(id: string): string | undefined;
  /** Folder that holds `<id>.pmtiles` map packs. */
  packsDir(): string;
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

/** Serve one file with HTTP Range support and a streamed body. */
export async function serveFile(file: string, req: Request): Promise<Response> {
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

/**
 * Serve a legacy viewer document: shims injected, remote links removed, legacy CSP. The page
 * is small and rewritten, so it is always a whole 200 response.
 */
async function serveLegacyDocument(file: string, projectId: string, req: Request) {
  let html: string;
  try {
    html = prepareLegacyHtml(await readFile(file, 'utf8'), projectId);
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
 * - `aio://project/<id>/<path>` serves a file inside the registered project root.
 * - `aio://project/<id>/legacy/<...>.html` serves a legacy viewer with its shims (legacy.ts).
 * - `aio://packs/<id>.pmtiles` serves a map pack from the packs folder.
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
      const root = roots.projectRoot(id);
      if (root === undefined) return status(404);
      const resolved = await resolveInside(root, rest.join('/'));
      if (!resolved.ok) return status(resolved.status);
      if (isLegacyDocument(rest)) return serveLegacyDocument(resolved.path, id, req);
      return serveFile(resolved.path, req);
    }

    if (url.host === 'packs') {
      const [name, ...rest] = segments;
      if (name === undefined || rest.length > 0 || !PACK.test(name)) return status(404);
      return serveFile(join(roots.packsDir(), name), req);
    }

    return status(404);
  };
}
