// Node-only parts of the exports: PNG masks and a streaming ZIP writer.
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import type { ImageGeom } from '@aio/schema';
import { allClasses, photoSrc, rotboxCorners, sortByCode, type ExportContext } from './facts';

/* ------------------------------------------------------------------------------------------- */
/* PNG                                                                                          */
/* ------------------------------------------------------------------------------------------- */

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function encodePng(data: Uint8Array, width: number, height: number, channels: 1 | 4): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** 8-bit greyscale PNG (a class-index mask). */
export function encodeGrayPng(data: Uint8Array, width: number, height: number): Buffer {
  return encodePng(data, width, height, 1);
}

const OVERLAY_ALPHA = 140;

/** RGBA overlay of a class-index mask: value v gets `colors[v - 1]`, background transparent. */
export function overlayPng(
  mask: Uint8Array,
  width: number,
  height: number,
  colors: readonly string[],
): Buffer {
  const rgb = colors.map((c) => [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ]);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ?? 0;
    const c = v > 0 ? rgb[v - 1] : undefined;
    if (!c) continue;
    out[i * 4] = c[0] ?? 0;
    out[i * 4 + 1] = c[1] ?? 0;
    out[i * 4 + 2] = c[2] ?? 0;
    out[i * 4 + 3] = OVERLAY_ALPHA;
  }
  return encodePng(out, width, height, 4);
}

/* ------------------------------------------------------------------------------------------- */
/* Mask rasterisation                                                                           */
/* ------------------------------------------------------------------------------------------- */

export interface MaskShape {
  /** Class value written into the mask (1 based). */
  value: number;
  geom: ImageGeom;
}

function fillPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
  pts: readonly (readonly number[])[],
  value: number,
): void {
  const ys = pts.map((p) => p[1] ?? 0);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i] ?? [];
      const b = pts[(i + 1) % pts.length] ?? [];
      const [ax = 0, ay = 0] = a;
      const [bx = 0, by = 0] = b;
      if (ay <= yc === by <= yc) continue;
      xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] ?? 0) - 0.5));
      const to = Math.min(width - 1, Math.floor((xs[k + 1] ?? 0) - 0.5));
      for (let x = from; x <= to; x++) mask[y * width + x] = value;
    }
  }
}

/** Draw image geometry into a class-index mask (later shapes on top). Masks are skipped. */
export function rasterizeMask(
  shapes: readonly MaskShape[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const radius = Math.max(8, Math.round(Math.max(width, height) * 0.02));
  for (const { value, geom: g } of shapes) {
    switch (g.type) {
      case 'box':
        fillPolygon(
          mask,
          width,
          height,
          [
            [g.x, g.y],
            [g.x + g.w, g.y],
            [g.x + g.w, g.y + g.h],
            [g.x, g.y + g.h],
          ],
          value,
        );
        break;
      case 'rotbox':
        fillPolygon(mask, width, height, rotboxCorners(g.x, g.y, g.w, g.h, g.angleDeg), value);
        break;
      case 'polygon':
        fillPolygon(mask, width, height, g.points, value);
        break;
      case 'point': {
        const disc: [number, number][] = [];
        for (let i = 0; i < 32; i++) {
          const a = (i / 32) * Math.PI * 2;
          disc.push([g.x + Math.cos(a) * radius, g.y + Math.sin(a) * radius]);
        }
        fillPolygon(mask, width, height, disc, value);
        break;
      }
      case 'mask':
        break;
    }
  }
  return mask;
}

/* ------------------------------------------------------------------------------------------- */
/* Which masks a project has                                                                    */
/* ------------------------------------------------------------------------------------------- */

export type MaskPhoto =
  | {
      kind: 'kit';
      layer: string;
      photo: string;
      src: string | null;
      /** The kit class-index mask; overlays sit beside it. */
      mask: string;
      issues: string[];
    }
  | {
      kind: 'drawn';
      layer: string;
      photo: string;
      src: string | null;
      shapes: MaskShape[];
      issues: string[];
    };

export interface MaskPlan {
  classes: { value: number; id: string; label: string; color: string }[];
  photos: MaskPhoto[];
}

/**
 * Photo masks of the issues: the kit's own mask and overlays where the import brought them,
 * otherwise a mask drawn from the boxes, polygons and points (class values from the catalogue).
 */
export function maskPlan(ctx: ExportContext): MaskPlan {
  const m = ctx.manifest;
  const classes = allClasses(m)
    .slice(0, 255)
    .map((c, i) => ({ value: i + 1, id: c.id, label: c.label, color: c.color }));
  const valueOf = new Map(classes.map((c) => [c.id, c.value]));
  const byPhoto = new Map<
    string,
    { layer: string; photo: string; mask: string | null; shapes: MaskShape[]; issues: string[] }
  >();
  for (const issue of sortByCode(ctx.issues)) {
    for (const s of issue.sightings) {
      if (s.on !== 'image') continue;
      const key = `${s.layer}\u0000${s.photo}`;
      let entry = byPhoto.get(key);
      if (!entry) {
        entry = { layer: s.layer, photo: s.photo, mask: null, shapes: [], issues: [] };
        byPhoto.set(key, entry);
      }
      if (!entry.issues.includes(issue.code)) entry.issues.push(issue.code);
      if (s.geom.type === 'mask') {
        if ('path' in s.geom.src) entry.mask ??= s.geom.src.path;
      } else {
        const value = valueOf.get(issue.classId);
        if (value !== undefined) entry.shapes.push({ value, geom: s.geom });
      }
    }
  }
  const photos: MaskPhoto[] = [];
  for (const e of byPhoto.values()) {
    const src = photoSrc(m, e.layer, e.photo);
    if (e.mask)
      photos.push({
        kind: 'kit',
        layer: e.layer,
        photo: e.photo,
        src,
        mask: e.mask,
        issues: e.issues,
      });
    else if (e.shapes.length > 0)
      photos.push({
        kind: 'drawn',
        layer: e.layer,
        photo: e.photo,
        src,
        shapes: e.shapes,
        issues: e.issues,
      });
  }
  return { classes, photos };
}

/** Files beside a kit mask: `<id>_mask.png`, `_overlay.png`, `_uncertain_mask.png`, ... */
export function kitMaskSiblings(maskPath: string): string[] {
  const stem = maskPath.replace(/_mask\.png$/i, '');
  if (stem === maskPath) return [maskPath];
  return ['_mask.png', '_overlay.png', '_uncertain_mask.png', '_uncertain_overlay.png'].map(
    (s) => `${stem}${s}`,
  );
}

/* ------------------------------------------------------------------------------------------- */
/* ZIP (store mode, streamed to disk)                                                           */
/* ------------------------------------------------------------------------------------------- */

interface ZipEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * A ZIP written entry by entry (stored, no compression: PNG and JPEG are compressed already).
 * Archives stay under 4 GB; larger ones are refused rather than written corrupt.
 */
export class ZipWriter {
  private offset = 0;
  private readonly entries: ZipEntry[] = [];
  private readonly stamp = dosTime(new Date());

  private constructor(private readonly fh: FileHandle) {}

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await open(path, 'w'));
  }

  private async write(buf: Uint8Array): Promise<void> {
    await this.fh.write(buf);
    this.offset += buf.length;
    if (this.offset > 0xfffffff0) throw new Error('The ZIP would be larger than 4 GB.');
  }

  async add(name: string, data: Uint8Array): Promise<void> {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(0, 8); // stored
    head.writeUInt16LE(this.stamp.time, 10);
    head.writeUInt16LE(this.stamp.date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const offset = this.offset;
    await this.write(head);
    await this.write(nameBuf);
    await this.write(data);
    this.entries.push({ name: nameBuf, crc, size: data.length, offset });
  }

  /** Write the central directory and close; resolves to the archive size in bytes. */
  async finish(): Promise<number> {
    try {
      const start = this.offset;
      for (const e of this.entries) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(20, 6);
        h.writeUInt16LE(0x0800, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(this.stamp.time, 12);
        h.writeUInt16LE(this.stamp.date, 14);
        h.writeUInt32LE(e.crc, 16);
        h.writeUInt32LE(e.size, 20);
        h.writeUInt32LE(e.size, 24);
        h.writeUInt16LE(e.name.length, 28);
        h.writeUInt32LE(e.offset, 42);
        await this.write(h);
        await this.write(e.name);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(this.entries.length, 8);
      end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(this.offset - start, 12);
      end.writeUInt32LE(start, 16);
      await this.write(end);
      return this.offset;
    } finally {
      await this.fh.close();
    }
  }

  /** Close without finishing (cancel or error); the caller removes the file. */
  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }
}
