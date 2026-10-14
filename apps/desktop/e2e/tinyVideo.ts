import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A tiny real MP4 (two 32 x 32 frames) from the demo's own H.264 writer. */
export async function tinyMp4(): Promise<Buffer> {
  const url = pathToFileURL(join(import.meta.dirname, '../../../tools/demo/h264.mjs')).href;
  const h264 = (await import(url)) as {
    encodeH264Pcm(frames: Uint8Array[], w: number, h: number): unknown;
    muxMp4(enc: unknown, o: { fps: number }): Buffer;
  };
  const frame = () => new Uint8Array(32 * 32 * 3).fill(96);
  return h264.muxMp4(h264.encodeH264Pcm([frame(), frame()], 32, 32), { fps: 2 });
}
