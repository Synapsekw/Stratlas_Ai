import { georefToLayerTransform, type ProjectGeo } from '@aio/geo';
import { readGlbGeoref, type Georef, type Mat4, type Placement } from '@aio/schema';
import { open } from 'node:fs/promises';

/**
 * Placing an imported GLB from the georeference it carries (engineering model spec section 5.6).
 * Only the GLB's JSON chunk is read (never the whole file); the vertices are never rewritten, so
 * the layer transform computed here is the one and only place the record is applied, and importing
 * the same file again gives the same transform.
 */

const MAGIC = 0x46546c67; // glTF
const JSON_CHUNK = 0x4e4f534a; // JSON
/** A JSON chunk larger than this is not read (no GLB we place has one anywhere near it). */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** What a GLB without a georeference has always been told on import. */
const PLAIN_MESSAGE = 'Place it with Align, Georeference model.';
const OLDER_SCHEMA = 'chimney.georeference/1';

/** The JSON chunk length the 20-byte header announces, or null when the header is not GLB 2. */
function jsonLengthOf(head: Uint8Array): { jsonLen: number; total: number } | null {
  if (head.byteLength < 20) return null;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 2) return null;
  const total = dv.getUint32(8, true);
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== JSON_CHUNK) return null;
  if (jsonLen === 0 || jsonLen > MAX_JSON_BYTES || 20 + jsonLen > total) return null;
  return { jsonLen, total };
}

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The JSON chunk of GLB bytes that hold at least the 12-byte header, the chunk header and the
 * whole JSON chunk; null when they are not a well-formed GLB 2 whose first chunk is JSON.
 */
export function readGlbJsonChunk(head: Uint8Array): Record<string, unknown> | null {
  const h = jsonLengthOf(head);
  if (!h || head.byteLength < 20 + h.jsonLen) return null;
  return parseObject(head.subarray(20, 20 + h.jsonLen));
}

/**
 * The JSON chunk of a GLB file: reads the 20 header bytes, checks them against the file size, then
 * reads exactly the JSON chunk. Null when the file is not a well-formed GLB 2.
 */
export async function readGlbJsonFromFile(path: string): Promise<Record<string, unknown> | null> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = new Uint8Array(20);
    if ((await fh.read(head, 0, 20, 0)).bytesRead < 20) return null;
    const h = jsonLengthOf(head);
    if (!h || h.total > size || 20 + h.jsonLen > size) return null;
    const body = new Uint8Array(h.jsonLen);
    if ((await fh.read(body, 0, h.jsonLen, 20)).bytesRead < h.jsonLen) return null;
    return parseObject(body);
  } finally {
    await fh.close();
  }
}

export interface ImportedPlacement {
  transform: Mat4;
  georef?: Georef;
  placement?: Placement;
  message: string;
}

/**
 * The layer transform, georeference and placement of an imported GLB in a project. A file without
 * a georeference (or with `asset.extras` of another tool's own) is imported as it always was:
 * identity, no placement. Ours or the older structure is placed through `georefToLayerTransform`;
 * a record that cannot be used, or that cannot be placed here, leaves the model at identity (or on
 * the ground only, when just the height cannot be placed) with placement needed and the reason.
 */
export function placeImportedGlb(
  json: Record<string, unknown> | null,
  project: ProjectGeo,
): ImportedPlacement {
  const plain: ImportedPlacement = { transform: [...IDENTITY], message: PLAIN_MESSAGE };
  const asset = json?.asset;
  if (typeof asset !== 'object' || asset === null) return plain;
  const extras = (asset as Record<string, unknown>).extras;
  if (typeof extras !== 'object' || extras === null) return plain;
  const e = extras as Record<string, unknown>;
  // `georeference` is a common key: only the older structure of ours is read from it
  if (e.aioGeoref === undefined) {
    const old = e.georeference;
    if (
      typeof old !== 'object' ||
      old === null ||
      (old as Record<string, unknown>).schema !== OLDER_SCHEMA
    )
      return plain;
  }
  const read = readGlbGeoref(extras);
  if (read.kind === 'absent') return plain;
  if (read.kind === 'invalid')
    return {
      transform: [...IDENTITY],
      placement: 'needed',
      message: `The georeference in the file cannot be used (${read.reason}). Place it with Place model.`,
    };
  const r = georefToLayerTransform(read.georef, project);
  if (r.kind === 'needed') {
    if (r.horizontalOnly)
      return {
        transform: r.horizontalOnly,
        georef: read.georef,
        placement: 'needed',
        message: `Placed on the ground from the georeference in the file, but not in height. ${r.reason}`,
      };
    return {
      transform: [...IDENTITY],
      georef: read.georef,
      placement: 'needed',
      message: `${r.reason} Place it with Place model.`,
    };
  }
  return {
    transform: r.transform,
    georef: read.georef,
    placement: 'placed',
    message: ['Placed from the georeference in the file.', r.scaleNote, r.approxNote, r.heightNote]
      .filter((s): s is string => typeof s === 'string')
      .join(' '),
  };
}
