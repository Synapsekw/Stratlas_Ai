/**
 * Synthetic panoramas of three survey dates (timeline T3) and the split picker helper the compare
 * specs share. Synthetic only: no real project, no network.
 */
import { ProjectManifest, SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import { expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { tinyGlb, type DataRoot } from './fixtures';

export const PANO_DATE_PROJECT_ID = 'e2e-pano-dates';
export const PANO_DATE_PROJECT_NAME = 'E2E panorama dates';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A solid colour RGB PNG of `width` x `height` pixels. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The survey dates of the panorama project, oldest first, with the x of each panorama. */
export const PANO_DATES = [
  { id: 'sep', date: '2024-09-04', xs: [0, 10, 20], rgb: [200, 60, 60] },
  { id: 'oct', date: '2024-10-02', xs: [0, 10, 20], rgb: [60, 160, 60] },
  { id: 'nov', date: '2024-11-06', xs: [2, 11, 60], rgb: [60, 80, 200] },
] as const;

/**
 * Write `projects/e2e-pano-dates/` into `dataRoot`: three surveys (4 Sep, 2 Oct and 6 Nov 2024;
 * captures `sep`, `oct`, `nov`), each with a model (`quad-<id>`) and a "Panoramas" layer
 * (`pano-<id>`, panoramas `p1` to `p3` on the ground at the date's x, z = 0, heading 0). Every
 * panorama is a 64 x 32 equirect PNG of one colour per date, so a screenshot tells them apart.
 */
export async function createPanoDateProject(dataRoot: DataRoot): Promise<{ id: string }> {
  const id = PANO_DATE_PROJECT_ID;
  const dir = join(dataRoot.root, 'projects', id);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'panoramas'), { recursive: true });
  await writeFile(join(dir, 'models', 'quad.glb'), tinyGlb());
  for (const d of PANO_DATES) {
    const png = solidPng(64, 32, [...d.rgb]);
    for (let i = 0; i < d.xs.length; i++)
      await writeFile(join(dir, 'panoramas', `${d.id}-p${String(i + 1)}.png`), png);
  }
  const input: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id,
    name: PANO_DATE_PROJECT_NAME,
    customer: 'E2E',
    site: 'Synthetic site, panoramas of 3 dates',
    crs: { epsg: 32639 },
    origin: [500000, 3200000, 0],
    captures: PANO_DATES.map((d) => ({ id: d.id, label: d.date, date: d.date })),
    layers: PANO_DATES.flatMap((d) => [
      {
        kind: 'mesh' as const,
        id: `quad-${d.id}`,
        name: `Quad ${d.date}`,
        capture: d.id,
        src: { path: 'models/quad.glb' },
        transform: IDENTITY,
      },
      {
        kind: 'panoramas' as const,
        id: `pano-${d.id}`,
        name: 'Panoramas',
        capture: d.id,
        items: d.xs.map((x, i) => ({
          id: `p${String(i + 1)}`,
          src: { path: `panoramas/${d.id}-p${String(i + 1)}.png` },
          pos: [x, 0, 0] as [number, number, number],
          headingDeg: 0,
        })),
      },
    ]),
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(ProjectManifest.parse(input), null, 2),
  );
  return { id };
}

/**
 * Pick what one side of the split shows from its picker: `kind` (a pane of any date, or every
 * pane of a project with fewer than two dates) or `kind` on survey date `capture`.
 */
export async function choosePane(
  win: Page,
  side: 'left' | 'right',
  kind: string,
  capture?: string,
): Promise<void> {
  const value = capture ? `${kind}@${capture}` : kind;
  const select = win.getByTestId(`pane-select-${side}`);
  await select.selectOption(value);
  await expect(select).toHaveValue(value);
}
