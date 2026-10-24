import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which URLs the app's pages may load, and which page may call main. Pure, so it is tested
 * without Electron (index.ts wires it into `onBeforeRequest` and `handle`).
 */

/** The dev server's origin, or undefined when there is none (any packaged build). */
function originOf(devUrl: string | undefined): string | undefined {
  if (!devUrl) return undefined;
  try {
    return new URL(devUrl).origin;
  } catch {
    return undefined;
  }
}

/**
 * Offline by construction: the renderer may reach only the app (file:// on this computer),
 * aio:// and, in dev, the dev server (and its hot-reload socket). A `file:` URL with a host (`file://server/share/...`) would
 * reach another computer over SMB, so it is refused like http.
 */
export function rendererUrlAllowed(url: string, devUrl?: string): boolean {
  const dev = originOf(devUrl);
  if (dev && (url === dev || url.startsWith(`${dev}/`))) return true;
  // Vite's hot-reload socket on the same host and port
  const devSocket = dev?.replace(/^http/, 'ws');
  if (devSocket && (url === devSocket || url.startsWith(`${devSocket}/`))) return true;
  const proto = url.slice(0, url.indexOf(':') + 1).toLowerCase();
  if (['http:', 'https:', 'ws:', 'wss:', 'ftp:'].includes(proto)) return false;
  if (proto === 'file:') {
    try {
      const host = new URL(url).host;
      if (host !== '' && host.toLowerCase() !== 'localhost') return false;
    } catch {
      return false;
    }
    // `file:////server/share` and `file:\\server` spell a share without a host
    if (/^file:[\\/]{2}[^\\/]*[\\/]{2}/i.test(url) || /^file:[\\/]*\\\\/i.test(url)) return false;
  }
  return true;
}

const norm = (p: string) => resolve(p).toLowerCase();

/**
 * Whether an IPC call comes from the app's own page: the top frame (no frame inside it) of the
 * main window's renderer, at its own file or, in dev, on the dev server.
 */
export function isAppSender(
  frame: { url: string; top: boolean } | null | undefined,
  o: { indexFile: string; devUrl?: string | undefined },
): boolean {
  if (!frame?.top) return false;
  let u: URL;
  try {
    u = new URL(frame.url);
  } catch {
    return false;
  }
  const dev = originOf(o.devUrl);
  if (dev) return u.origin === dev;
  if (u.protocol !== 'file:' || u.host !== '') return false;
  try {
    return norm(fileURLToPath(`file://${u.pathname}`)) === norm(o.indexFile);
  } catch {
    return false;
  }
}
