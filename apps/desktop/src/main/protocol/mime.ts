import { extname } from 'node:path';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pmtiles': 'application/vnd.pmtiles',
  '.pdf': 'application/pdf',
  '.bin': 'application/octet-stream',
  '.laz': 'application/octet-stream',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Content-Type for a file name, by extension; unknown types are opaque bytes. */
export function mimeFor(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
