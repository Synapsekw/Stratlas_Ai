/**
 * LAS 1.4 extra-bytes dimensions (R15 section 2.5, VLR `LASF_Spec` record 4): the per-point values a
 * COPC carries after its base record. The viewer draws one float scalar of them (M8 cloud change:
 * `Distance`, metres, written by the `change.cloud` pipeline); other layouts are refused with a
 * message and the cloud is drawn without it. Pure: no I/O.
 */

export const EXTRA_BYTES_USER = 'LASF_Spec';
export const EXTRA_BYTES_RECORD_ID = 4;
/** Bytes per descriptor. */
export const EXTRA_BYTES_RECORD = 192;
/** Base record length per point data record format (LAS 1.4 R15). */
export const BASE_RECORD_LENGTH: Readonly<Record<number, number>> = { 6: 30, 7: 36, 8: 38 };
/** Bytes per value of data types 1 to 10 (unsigned char ... double). */
const TYPE_SIZE: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 2,
  4: 2,
  5: 4,
  6: 4,
  7: 8,
  8: 8,
  9: 4,
  10: 8,
};
const TYPE_NAME: Readonly<Record<number, string>> = {
  0: 'raw bytes',
  1: 'unsigned 8-bit integers',
  2: '8-bit integers',
  3: 'unsigned 16-bit integers',
  4: '16-bit integers',
  5: 'unsigned 32-bit integers',
  6: '32-bit integers',
  7: 'unsigned 64-bit integers',
  8: '64-bit integers',
};

export interface ExtraBytesDim {
  name: string;
  /** 0 (raw bytes, `options` long) or 1 to 10. */
  dataType: number;
  options: number;
  /** Bytes per point. */
  size: number;
  description: string;
  min?: number;
  max?: number;
  scale?: number;
  offset?: number;
}

/** Where a float scalar sits in each point record. */
export interface ScalarField {
  name: string;
  byteOffset: number;
  type: 'f32' | 'f64';
  scale?: number;
  offset?: number;
}

const text = (b: Uint8Array, from: number, len: number): string => {
  let s = '';
  for (let i = from; i < from + len; i++) {
    const c = b[i] ?? 0;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

/** The descriptors of an extra-bytes VLR payload. */
export function parseExtraBytes(payload: Uint8Array): ExtraBytesDim[] {
  if (payload.byteLength % EXTRA_BYTES_RECORD !== 0) {
    throw new Error(
      `An extra-bytes record is ${String(EXTRA_BYTES_RECORD)} bytes; this one has ${String(payload.byteLength)}`,
    );
  }
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const dims: ExtraBytesDim[] = [];
  for (let at = 0; at < payload.byteLength; at += EXTRA_BYTES_RECORD) {
    const dataType = payload[at + 2] ?? 0;
    const options = payload[at + 3] ?? 0;
    const d: ExtraBytesDim = {
      name: text(payload, at + 4, 32),
      dataType,
      options,
      size: dataType === 0 ? options : (TYPE_SIZE[dataType] ?? 0),
      description: text(payload, at + 160, 32),
    };
    // no_data at 40, min 64, max 88, scale 112, offset 136 (as doubles for float types)
    if (options & 2) d.min = v.getFloat64(at + 64, true);
    if (options & 4) d.max = v.getFloat64(at + 88, true);
    if (options & 8) d.scale = v.getFloat64(at + 112, true);
    if (options & 16) d.offset = v.getFloat64(at + 136, true);
    dims.push(d);
  }
  return dims;
}

/**
 * Where the float dimension `name` sits in a record of `layout`; null when the file has none; an
 * error sentence when it is there but not drawable (integers, arrays, a record too short).
 */
export function scalarField(
  dims: readonly ExtraBytesDim[],
  layout: { pointDataRecordFormat: number; pointDataRecordLength: number },
  name = 'Distance',
): ScalarField | { error: string } | null {
  const i = dims.findIndex((d) => d.name === name);
  if (i < 0) return null;
  const base = BASE_RECORD_LENGTH[layout.pointDataRecordFormat];
  if (base === undefined) {
    return {
      error: `The ${name} field of a point format ${String(layout.pointDataRecordFormat)} cloud is not shown (formats 6 to 8 only)`,
    };
  }
  const d = dims[i];
  if (!d || (d.dataType !== 9 && d.dataType !== 10)) {
    const kind = d ? (TYPE_NAME[d.dataType] ?? `type ${String(d.dataType)}`) : 'unknown';
    return { error: `The ${name} field holds ${kind}; only float values are shown` };
  }
  let byteOffset = base;
  for (const e of dims.slice(0, i)) byteOffset += e.size;
  if (byteOffset + d.size > layout.pointDataRecordLength) {
    return { error: `The ${name} field does not fit the point record; the file is not valid` };
  }
  const f: ScalarField = { name, byteOffset, type: d.dataType === 9 ? 'f32' : 'f64' };
  if (d.scale !== undefined) f.scale = d.scale;
  if (d.offset !== undefined) f.offset = d.offset;
  return f;
}

/** The scalar of the record starting at `recordOffset`. */
export function readScalar(view: DataView, recordOffset: number, f: ScalarField): number {
  const at = recordOffset + f.byteOffset;
  const raw = f.type === 'f32' ? view.getFloat32(at, true) : view.getFloat64(at, true);
  return raw * (f.scale ?? 1) + (f.offset ?? 0);
}
