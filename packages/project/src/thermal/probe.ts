/**
 * Which decoder family could read a photo, from its first bytes alone (thermal analysis). A FLIR
 * radiometric JPEG carries an APP1 segment headed `FLIR\0`; a DJI R-JPEG carries thermal APP3
 * segments and names a camera model the DJI Thermal SDK supports. The pipeline decoders
 * (`python/src/aio_pipelines/thermal`) make the same call on the same bytes; a test pins the DJI
 * model list to the Python one.
 */
import type { ThermalFamily } from '@aio/schema';

/** How many bytes of a photo the probe reads: the metadata segments all sit in the head. */
export const THERMAL_PROBE_BYTES = 256 * 1024;

/** Camera models of the DJI Thermal SDK (mirror of `TSDK_MODELS` in `dji_tsdk.py`). */
export const TSDK_MODELS: ReadonlySet<string> = new Set([
  'H20T',
  'H20N',
  'H30T',
  'M30T',
  'M2EA',
  'M3T',
  'M3TD',
  'M4T',
  'M4TD',
  'M5T',
  'XTS',
  'ZH20T',
  'ZH20N',
  'ZH30T',
]);

export interface ThermalProbe {
  family: ThermalFamily;
  make: string;
  model: string;
}

const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/';
const FLIR_HEAD = [0x46, 0x4c, 0x49, 0x52, 0x00]; // "FLIR\0"
const EXIF_HEAD = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function startsWith(b: Uint8Array, start: number, head: readonly number[]): boolean {
  return head.every((v, i) => b[start + i] === v);
}

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

/** An IFD0 ASCII tag (Make 0x010F, Model 0x0110) of an Exif APP1 payload starting at `start`. */
function exifText(b: Uint8Array, start: number, end: number, tagWanted: number): string | null {
  if (!startsWith(b, start, EXIF_HEAD) || end - start < 14) return null;
  const t = start + 6;
  const little = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!little && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  try {
    const ifd = t + u32(t + 4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + 12 * i;
      if (e + 12 > end) return null;
      if (u16(e) !== tagWanted || u16(e + 2) !== 2) continue;
      const count = u32(e + 4);
      const off = count <= 4 ? e + 8 : t + u32(e + 8);
      if (off + count > end) return null;
      return (
        ascii(b, off, off + count)
          .split('\0')[0]
          ?.trim() ?? null
      );
    }
  } catch {
    return null;
  }
  return null;
}

const MODEL_RE = /Model\s*=\s*"([^"]+)"|<[\w-]*:?Model>([^<]+)</i;

/**
 * The thermal family of a photo from its head (the first bytes), or null when it is not a
 * radiometric photo either decoder reads. DJI's model comes from the XMP `drone-dji` Model, else
 * the Exif Model; a DJI photo of a model the SDK does not list is null.
 */
export function thermalFamily(head: Uint8Array): ThermalProbe | null {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let pos = 2;
  let hasApp3 = false;
  let hasFlir = false;
  let xmp = '';
  let exifModel: string | null = null;
  let exifMake: string | null = null;
  while (pos + 4 <= head.length && head[pos] === 0xff) {
    const marker = head[pos + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    const length = ((head[pos + 2] ?? 0) << 8) | (head[pos + 3] ?? 0);
    if (length < 2) break;
    const start = pos + 4;
    const end = Math.min(pos + 2 + length, head.length);
    if (marker === 0xe3) hasApp3 = true;
    else if (marker === 0xe1) {
      if (startsWith(head, start, FLIR_HEAD)) hasFlir = true;
      else if (exifModel === null) {
        exifModel = exifText(head, start, end, 0x0110);
        exifMake = exifText(head, start, end, 0x010f);
      }
      if (ascii(head, start, start + XMP_HEAD.length) === XMP_HEAD) xmp += ascii(head, start, end);
    }
    pos += 2 + length;
  }
  if (hasFlir)
    return {
      family: 'flir',
      make: (exifMake === '' ? null : exifMake) ?? 'FLIR',
      model: exifModel ?? '',
    };
  if (!hasApp3) return null;
  const m = xmp.includes('drone-dji') ? MODEL_RE.exec(xmp) : null;
  const model = (m ? (m[1] ?? m[2] ?? '') : (exifModel ?? '')).trim().toUpperCase();
  return TSDK_MODELS.has(model) ? { family: 'dji-tsdk', make: 'DJI', model } : null;
}
