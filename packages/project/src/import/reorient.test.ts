import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { matchTurn, orientationProbe } from './orientation';
import { reorientPhotos } from './reorient';

/** An asymmetric test picture, `seed` varies it. */
function picture(w: number, h: number, seed: number) {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const v = x < w / 3 && y < h / 3 ? 250 : Math.round((x / w) * 120 + (y / h) * 60);
      px[i] = v;
      px[i + 1] = (v + seed * 40) % 256;
      px[i + 2] = (x * 7 + y * 3 + seed) % 50;
    }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } });
}

describe('reorientPhotos', () => {
  let root = '';
  const project = () => join(root, 'project');
  const originals = () => join(root, 'nas');
  let upright = Buffer.alloc(0);
  const box = { type: 'box', x: 2, y: 3, w: 10, h: 6 };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aio-reorient-'));
    mkdirSync(join(project(), 'photos', 'thumbs'), { recursive: true });
    mkdirSync(join(originals(), '101-flight'), { recursive: true });
    upright = await picture(160, 120, 1).jpeg().toBuffer();
    const other = await picture(160, 120, 2).jpeg().toBuffer();
    // the camera stores its pixels upside down and tags Orientation 3 (Elios 3)
    await sharp(upright)
      .rotate(180)
      .withMetadata({ orientation: 3 })
      .jpeg()
      .toFile(join(originals(), '101-flight', 'A_0001.JPG'));
    await sharp(other)
      .rotate(180)
      .withMetadata({ orientation: 3 })
      .jpeg()
      .toFile(join(originals(), '101-flight', 'A_0002.JPG'));
    // A_0001 as the kit thumbnail: stored pixels, upside down; A_0002 a right copy
    await sharp(upright).rotate(180).resize(48).jpeg().toFile(join(project(), 'photos/A_0001.jpg'));
    await sharp(upright)
      .rotate(180)
      .resize(24)
      .jpeg()
      .toFile(join(project(), 'photos/thumbs/A_0001.jpg'));
    await sharp(other).resize(48).jpeg().toFile(join(project(), 'photos/A_0002.jpg'));
    await sharp(other)
      .rotate(180)
      .resize(24)
      .jpeg()
      .toFile(join(project(), 'photos/thumbs/A_0002.jpg'));
    await sharp(other).resize(48).jpeg().toFile(join(project(), 'photos/F_frame.jpg'));
    const item = (id: string) => ({ id, src: { path: `photos/${id}.jpg` }, pos: [0, 0, 0] });
    writeFileSync(
      join(project(), 'manifest.json'),
      JSON.stringify({
        layers: [
          {
            kind: 'photos',
            id: 'photos',
            items: [item('A_0001'), item('A_0002'), item('F_frame')],
          },
        ],
      }),
    );
    const at = '2026-10-04T03:01:49.936Z';
    const issue = (id: string, photo: string) => ({
      id,
      code: id,
      classId: 'c',
      severityModelId: 's',
      severity: 3,
      status: 'draft',
      title: 't',
      note: '',
      author: 'D',
      source: 'human',
      createdAt: at,
      updatedAt: at,
      sightings: [{ on: 'image', layer: 'photos', photo, geom: box }],
      futureField: { kept: true },
    });
    writeFileSync(
      join(project(), 'issues.json'),
      JSON.stringify(
        { schema: 'aio.issues/1', issues: [issue('F13', 'A_0001'), issue('F14', 'A_0002')] },
        null,
        2,
      ) + '\n',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('plans without writing', async () => {
    const before = readFileSync(join(project(), 'photos/A_0001.jpg'));
    const plan = await reorientPhotos({ project: project(), references: [originals()] });
    expect(plan.photosChecked).toBe(3);
    expect(plan.photos.map((p) => [p.id, p.turn])).toEqual([['A_0001', 2]]);
    expect(plan.thumbs).toEqual([
      { path: 'photos/thumbs/A_0001.jpg', turn: 2 },
      { path: 'photos/thumbs/A_0002.jpg', turn: 2 },
    ]);
    expect(plan.unmatched).toEqual([{ layer: 'photos', id: 'F_frame', reason: 'no original' }]);
    expect(plan.sightings.map((c) => [c.code, c.after])).toEqual([
      ['F13', { type: 'box', x: 36, y: 27, w: 10, h: 6 }],
    ]);
    expect(plan.backupDir).toBeUndefined();
    expect(readFileSync(join(project(), 'photos/A_0001.jpg')).equals(before)).toBe(true);
  });

  it('turns the photos, thumbnails and shapes, with a backup first', async () => {
    const issuesBefore = readFileSync(join(project(), 'issues.json'), 'utf8');
    const photoBefore = readFileSync(join(project(), 'photos/A_0001.jpg'));
    const plan = await reorientPhotos({
      project: project(),
      references: [originals()],
      apply: true,
    });
    const backup = plan.backupDir ?? '';
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(join(backup, 'issues.json'), 'utf8')).toBe(issuesBefore);
    expect(readFileSync(join(backup, 'photos/A_0001.jpg')).equals(photoBefore)).toBe(true);
    expect(existsSync(join(backup, 'photos/thumbs/A_0002.jpg'))).toBe(true);
    expect(existsSync(join(backup, 'report.json'))).toBe(true);

    const ref = await orientationProbe(upright);
    for (const f of ['photos/A_0001.jpg', 'photos/thumbs/A_0001.jpg'])
      expect(matchTurn(await orientationProbe(join(project(), f)), ref).turn).toBe(0);
    const issues = JSON.parse(readFileSync(join(project(), 'issues.json'), 'utf8')) as {
      issues: { code: string; sightings: { geom: unknown }[]; futureField?: unknown }[];
    };
    expect(issues.issues[0]?.sightings[0]?.geom).toEqual({
      type: 'box',
      x: 36,
      y: 27,
      w: 10,
      h: 6,
    });
    expect(issues.issues[1]?.sightings[0]?.geom).toEqual(box);
    expect(issues.issues[0]?.futureField).toEqual({ kept: true });
    expect(existsSync(join(project(), 'photos/A_0001.jpg.partial'))).toBe(false);
  });

  it('finds nothing to do the second time', async () => {
    const plan = await reorientPhotos({
      project: project(),
      references: [originals()],
      apply: true,
    });
    expect(plan.photos).toEqual([]);
    expect(plan.thumbs).toEqual([]);
    expect(plan.backupDir).toBeUndefined();
  });
});
