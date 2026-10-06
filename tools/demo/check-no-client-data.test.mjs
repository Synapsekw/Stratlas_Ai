import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFolder, distanceKm, utmToLonLat } from './check-no-client-data.mjs';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'demo-check-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A clean project in open desert (UTM 31N), as the demo builder writes it. */
async function cleanProject(root = join(dir, 'demo', 'p')) {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      id: 'p',
      name: 'Demo tank farm',
      crs: { epsg: 32631 },
      origin: [316542, 2589075, 386],
    }),
  );
  await writeFile(
    join(root, 'issues.json'),
    JSON.stringify({ schema: 'aio.issues/1', issues: [] }),
  );
  return root;
}

/** A minimal JPEG: SOI, an APP1 segment with the given payload, EOI. */
function jpeg(app1) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    len,
    app1,
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('check-no-client-data', () => {
  it('converts UTM to lon/lat', () => {
    const [lon, lat] = utmToLonLat(32639, 216108, 3220019);
    expect(lon).toBeCloseTo(48.08, 1);
    expect(lat).toBeCloseTo(29.08, 1);
    expect(utmToLonLat(4326, 1, 2)).toBeNull();
    expect(distanceKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });

  it('passes a clean synthetic project', async () => {
    await cleanProject();
    const r = checkFolder(join(dir, 'demo'), { maxMb: 150 });
    expect(r.findings).toEqual([]);
    expect(r.points).toBe(1);
  });

  it('fails on client names in text, file names and GLB node names', async () => {
    const root = await cleanProject();
    await writeFile(join(root, 'road.json'), JSON.stringify({ name: '1st Ring Road km 3' }));
    await writeFile(join(root, 'notes-masafi.txt'), 'nothing');
    const json = Buffer.from(JSON.stringify({ nodes: [{ name: 'Tank 710-D-130335' }] }));
    const glb = Buffer.alloc(20);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(json.length, 12);
    await writeFile(join(root, 'm.glb'), Buffer.concat([glb, json]));
    const text = checkFolder(join(dir, 'demo')).findings.join('\n');
    expect(text).toContain('Ring Road');
    expect(text).toContain('Masafi');
    expect(text).toContain('710-D-130335');
  });

  it('does not read words into base64 payloads', async () => {
    const root = await cleanProject();
    await writeFile(
      join(root, 'grid.js'),
      `window.VS_X="${'A'.repeat(200)}/HCl+${'B'.repeat(200)}";`,
    );
    expect(checkFolder(join(dir, 'demo')).findings).toEqual([]);
  });

  it('fails on coordinates near a real site and on camera metadata', async () => {
    const root = await cleanProject();
    await writeFile(
      join(root, 'centreline.geojson'),
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [47.98, 29.36],
                [47.99, 29.36],
              ],
            },
          },
        ],
      }),
    );
    await writeFile(join(root, 'p1.jpg'), jpeg(Buffer.from('Exif\0\0MM\0*GPS')));
    const text = checkFolder(join(dir, 'demo')).findings.join('\n');
    expect(text).toMatch(/km from 1st Ring Road/);
    expect(text).toContain('EXIF metadata');
  });

  it('takes reference sites and names from the project manifests, but not a copy of the demo', async () => {
    const refs = join(dir, 'projects');
    await mkdir(join(refs, 'client-x'), { recursive: true });
    await writeFile(
      join(refs, 'client-x', 'manifest.json'),
      JSON.stringify({
        name: 'Northgate Refinery',
        customer: 'Acme Petroleum',
        crs: { epsg: 32631 },
        origin: [316600, 2589100, 0],
      }),
    );
    await cleanProject(join(refs, 'demo-copy'));
    const root = await cleanProject();
    await writeFile(join(root, 'readme.txt'), 'made for Acme Petroleum');
    const text = checkFolder(join(dir, 'demo'), { projectsDir: refs }).findings.join('\n');
    expect(text).toContain('Acme Petroleum');
    expect(text).toMatch(/km from project client-x/);
    expect(text).not.toContain('demo-copy');
  });

  it('fails on paths of the build machine and on size', async () => {
    const root = await cleanProject();
    await writeFile(
      join(root, 'job.json'),
      JSON.stringify({ dsm: 'C:\\Users\\someone\\AppData\\x.tif' }),
    );
    const r = checkFolder(join(dir, 'demo'), { maxMb: 0.000001 });
    expect(r.findings.join('\n')).toContain('path of the build machine');
    expect(r.findings.join('\n')).toContain('total size');
  });
});
