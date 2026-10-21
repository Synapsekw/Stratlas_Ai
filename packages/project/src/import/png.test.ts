import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './png';

/** A PNG whose IDAT is `idat` as given (no CRC check is made by the reader). */
function pngWith(width: number, height: number, idat: Buffer): Uint8Array {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('decodePng', () => {
  it('round trips a small image', () => {
    const img = {
      width: 2,
      height: 1,
      channels: 3 as const,
      data: new Uint8Array([1, 2, 3, 4, 5, 6]),
    };
    expect(decodePng(encodePng(img)).data).toEqual(img.data);
  });

  it('refuses image data that unpacks far beyond its declared size', () => {
    // 1 x 1 pixel declared, 32 MB of zeros packed into a few kilobytes
    const bomb = pngWith(1, 1, deflateSync(Buffer.alloc(32 << 20)));
    expect(() => decodePng(bomb)).toThrow(/unpacks to more than/);
  });
});
