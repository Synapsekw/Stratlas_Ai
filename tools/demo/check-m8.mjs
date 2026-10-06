// What the client-data check (check-no-client-data.mjs) reads from the M8 demo files: the text of
// DXF drawings (entity text, layer and block names), the text fields of ONNX models (names, doc
// strings, producer, metadata; never tensor bytes) and the lon/lat places listed in truth.json.
import { onnxStrings } from './onnx-test-model.mjs';

/** Text to scan for words in a file of an M8 kind, or null for other kinds. */
export function m8Text(ext, buf) {
  if (ext === '.dxf') return buf.toString('latin1');
  if (ext === '.onnx') return onnxStrings(buf).join('\n');
  return null;
}

const isLonLat = (p) =>
  Array.isArray(p) &&
  p.length === 2 &&
  typeof p[0] === 'number' &&
  typeof p[1] === 'number' &&
  Math.abs(p[0]) <= 180 &&
  Math.abs(p[1]) <= 90;

/** Every `lonLat` point and `outline` ring point in a truth.json, as [lon, lat]. */
export function truthCoords(j) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'lonLat' && isLonLat(x)) out.push(x);
      else if (k === 'outline' && Array.isArray(x)) out.push(...x.filter(isLonLat));
      else walk(x);
    }
  };
  walk(j);
  return out;
}
