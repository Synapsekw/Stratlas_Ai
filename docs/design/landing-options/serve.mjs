import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
};
const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') pathname = '/landing-options/index.html';
    let file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    let info = await stat(file);
    if (info.isDirectory()) {
      file = path.join(file, 'index.html');
      info = await stat(file);
    }
    const headers = {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    // Compressed copies retain the original URL and decode transparently in fetch/GLTFLoader.
    // Byte ranges are kept on the original representation (in particular for video).
    if (!req.headers.range && /\bbr\b/.test(req.headers['accept-encoding'] || '')) {
      const compressed = await stat(file + '.br').catch(() => null);
      if (compressed && compressed.mtimeMs >= info.mtimeMs) {
        file += '.br';
        info = compressed;
        headers['Content-Encoding'] = 'br';
        headers['Vary'] = 'Accept-Encoding';
      }
    }
    let start = 0,
      end = info.size - 1,
      status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        res.writeHead(416).end();
        return;
      }
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), end) : end;
      if (start > end || start >= info.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});
const port = Number(process.env.QUADRION_PREVIEW_PORT || 8766);
server.listen(port, '127.0.0.1', () =>
  console.log(`Quadrion AI preview: http://127.0.0.1:${port}/landing-options/atlas.html`),
);
