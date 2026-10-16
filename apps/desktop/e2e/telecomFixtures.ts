/** Synthetic vertical antenna face, as a mesh or a dense PNG-packed cloud. */
import { ProjectManifest } from '@aio/schema';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { tinyManifest } from './fixtures';

export async function writeTelecomFace(dir: string, kind: 'mesh' | 'cloud'): Promise<void> {
  const manifest = tinyManifest();
  if (kind === 'mesh') {
    const layer = manifest.layers[0];
    if (layer?.kind !== 'mesh') throw new Error('expected tiny mesh fixture');
    layer.name = 'Synthetic antenna face';
    // Turn the existing unit ground quad upright, 8 m square, from y=1 to y=9.
    layer.transform = [8, 0, 0, 0, 0, 0, 8, 0, 0, -8, 0, 0, -4, 1, 0, 1];
  } else {
    const side = 81;
    const count = side * side;
    const stream = Buffer.alloc(9 * count);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const i = y * side + x;
        const qx = Math.round((x / (side - 1)) * 65535);
        const qy = Math.round((y / (side - 1)) * 65535);
        stream[i] = qx & 255;
        stream[count + i] = qx >> 8;
        stream[2 * count + i] = qy & 255;
        stream[3 * count + i] = qy >> 8;
        stream[6 * count + i] = 180;
        stream[7 * count + i] = 200;
        stream[8 * count + i] = 210;
      }
    }
    const width = 256;
    const height = Math.ceil(stream.length / (width * 3));
    const pixels = Buffer.alloc(width * height * 3);
    stream.copy(pixels);
    await mkdir(join(dir, 'cloud'), { recursive: true });
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(join(dir, 'cloud', 'face.png'));
    const bounds = { min: [-4, 1, 0], max: [4, 9, 0] };
    await writeFile(
      join(dir, 'cloud', 'index.json'),
      JSON.stringify({
        schema: 'aio.pngcloud/1',
        bounds,
        spacing: 0.1,
        chunks: [{ file: 'cloud/face.png', points: count, bounds, lod: 0 }],
      }),
    );
    manifest.layers = [
      {
        id: 'face-cloud',
        name: 'Synthetic antenna face',
        kind: 'pointcloud',
        visible: true,
        format: 'png-packed',
        src: { path: 'cloud/index.json' },
        pointCount: count,
      },
    ];
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
}
