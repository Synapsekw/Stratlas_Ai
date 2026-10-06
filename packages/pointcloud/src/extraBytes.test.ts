import { describe, expect, it } from 'vitest';
import {
  EXTRA_BYTES_RECORD,
  parseExtraBytes,
  readScalar,
  scalarField,
  type ExtraBytesDim,
} from './extraBytes';

/** One 192-byte extra-bytes descriptor (LAS 1.4 R15, table 24). */
function descriptor(
  name: string,
  dataType: number,
  o: { min?: number; max?: number; scale?: number; offset?: number; size?: number } = {},
): Uint8Array {
  const b = new Uint8Array(EXTRA_BYTES_RECORD);
  const v = new DataView(b.buffer);
  let options = 0;
  b[2] = dataType;
  for (let i = 0; i < name.length; i++) b[4 + i] = name.charCodeAt(i);
  // no_data at 40, min 64, max 88, scale 112, offset 136, description 160
  if (o.min !== undefined) {
    options |= 2;
    v.setFloat64(64, o.min, true);
  }
  if (o.max !== undefined) {
    options |= 4;
    v.setFloat64(88, o.max, true);
  }
  if (o.scale !== undefined) {
    options |= 8;
    v.setFloat64(112, o.scale, true);
  }
  if (o.offset !== undefined) {
    options |= 16;
    v.setFloat64(136, o.offset, true);
  }
  if (dataType === 0) options = o.size ?? 0;
  b[3] = options;
  return b;
}

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('extra-bytes VLR', () => {
  it('parses the name, type, size and range of each dimension', () => {
    const dims = parseExtraBytes(
      join(descriptor('Amplitude', 3), descriptor('Distance', 9, { min: -0.4, max: 2.5 })),
    );
    expect(dims.map((d) => [d.name, d.dataType, d.size])).toEqual([
      ['Amplitude', 3, 2],
      ['Distance', 9, 4],
    ]);
    expect(dims[1]).toMatchObject({ min: -0.4, max: 2.5 });
    expect(dims[0]?.min).toBeUndefined();
  });

  it('refuses a payload that is not whole descriptors', () => {
    expect(() => parseExtraBytes(new Uint8Array(100))).toThrow(/192/);
  });
});

describe('the scalar field of a record', () => {
  const layout = { pointDataRecordFormat: 6, pointDataRecordLength: 30 + 2 + 4 };
  const dims: ExtraBytesDim[] = parseExtraBytes(
    join(descriptor('Amplitude', 3), descriptor('Distance', 9)),
  );

  it('sits after the base record and the dimensions before it', () => {
    expect(scalarField(dims, layout)).toEqual({ name: 'Distance', byteOffset: 32, type: 'f32' });
    expect(scalarField(dims, layout, 'Missing')).toBeNull();
    expect(scalarField([], layout)).toBeNull();
  });

  it('refuses layouts it does not draw, with a message', () => {
    const errorOf = (r: ReturnType<typeof scalarField>) => (r && 'error' in r ? r.error : '');
    const ints = parseExtraBytes(descriptor('Distance', 6));
    expect(
      errorOf(scalarField(ints, { pointDataRecordFormat: 7, pointDataRecordLength: 40 })),
    ).toMatch(/float/);
    expect(
      errorOf(scalarField(dims, { pointDataRecordFormat: 6, pointDataRecordLength: 33 })),
    ).toMatch(/record/);
    expect(
      errorOf(scalarField(dims, { pointDataRecordFormat: 3, pointDataRecordLength: 40 })),
    ).toMatch(/format 3/);
  });

  it('reads float32 and float64 values from records', () => {
    const rec = new Uint8Array(2 * 40);
    const v = new DataView(rec.buffer);
    v.setFloat32(32, 0.25, true);
    v.setFloat32(40 + 32, -1.5, true);
    const f = { name: 'Distance', byteOffset: 32, type: 'f32' as const };
    expect(readScalar(v, 0, f)).toBeCloseTo(0.25);
    expect(readScalar(v, 40, f)).toBeCloseTo(-1.5);
    v.setFloat64(32, 3.125, true);
    expect(readScalar(v, 0, { ...f, type: 'f64' })).toBe(3.125);
  });
});
