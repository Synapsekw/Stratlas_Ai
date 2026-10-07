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

  describe('M10: synthetic photos, OPF, tilesets, packs and positions', () => {
    // the photo demo site (python/tests/photo_synth.py) and a place in no fictional site
    const SITE = [51.4813, 21.0703];
    const ELSEWHERE = [10.0, 35.0];

    /** A JPEG with an EXIF payload (Make, optional serial, artist and GPS) and optional XMP. */
    function cameraJpeg({
      make = 'Stratlas Synthetic',
      serial,
      artist,
      ll = SITE,
      xmp,
      children = '',
    } = {}) {
      const ascii = (s) => Buffer.from(`${s}\0`, 'latin1');
      const ifd0 = [[0x010f, 2, ascii(make)]];
      if (artist) ifd0.push([0x013b, 2, ascii(artist)]);
      const exif = serial ? [[0xa431, 2, ascii(serial)]] : [];
      const dms = (deg) => {
        const d = Math.floor(deg);
        const m = Math.floor((deg - d) * 60);
        const s = Math.round((deg - d - m / 60) * 3600 * 1000);
        const b = Buffer.alloc(24);
        [d, 1, m, 1, s, 1000].forEach((v, i) => b.writeUInt32LE(v, i * 4));
        return b;
      };
      const gps = ll
        ? [
            [1, 2, ascii(ll[1] >= 0 ? 'N' : 'S')],
            [2, 5, dms(Math.abs(ll[1]))],
            [3, 2, ascii(ll[0] >= 0 ? 'E' : 'W')],
            [4, 5, dms(Math.abs(ll[0]))],
          ]
        : [];
      const ifds = [ifd0, exif, gps];
      if (exif.length) ifd0.push([0x8769, 4, null]);
      if (gps.length) ifd0.push([0x8825, 4, null]);
      ifd0.sort((a, b) => a[0] - b[0]);
      const size = (e) => 2 + 12 * e.length + 4;
      const at = [8];
      at.push(at[0] + size(ifd0), at[0] + size(ifd0) + (exif.length ? size(exif) : 0));
      let data = at[2] + (gps.length ? size(gps) : 0);
      const parts = [Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0])];
      const tail = [];
      ifds.forEach((entries) => {
        if (!entries.length) return;
        const b = Buffer.alloc(size(entries));
        b.writeUInt16LE(entries.length, 0);
        entries.forEach(([tag, type, value], i) => {
          const e = 2 + 12 * i;
          b.writeUInt16LE(tag, e);
          b.writeUInt16LE(type, e + 2);
          if (value === null) {
            b.writeUInt32LE(1, e + 4);
            b.writeUInt32LE(tag === 0x8769 ? at[1] : at[2], e + 8);
            return;
          }
          b.writeUInt32LE(type === 5 ? value.length / 8 : value.length, e + 4);
          if (value.length <= 4) value.copy(b, e + 8);
          else {
            b.writeUInt32LE(data, e + 8);
            tail.push(value);
            data += value.length;
          }
        });
        parts.push(b);
      });
      const tiff = Buffer.concat([...parts, ...tail]);
      const seg = (payload) => {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(payload.length + 2);
        return Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]);
      };
      const segs = [seg(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]))];
      if (xmp || children)
        segs.push(
          seg(
            Buffer.from(
              `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:RDF><rdf:Description tiff:Make="${make}" ${xmp ?? ''}>${children}</rdf:Description></rdf:RDF></x:xmpmeta>`,
            ),
          ),
        );
      return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segs, Buffer.from([0xff, 0xd9])]);
    }

    it('passes photos of the synthetic camera at the fictional site', async () => {
      const root = await cleanProject();
      await writeFile(
        join(root, 'SYN_0001.JPG'),
        cameraJpeg({ xmp: 'drone-dji:AbsoluteAltitude="+201.5" drone-dji:RtkFlag="50"' }),
      );
      const r = checkFolder(join(dir, 'demo'));
      expect(r.findings).toEqual([]);
      expect(r.points).toBe(2);
    });

    it('finds a planted camera serial, a coordinate outside the fictional site and a name in XMP', async () => {
      const root = await cleanProject();
      await writeFile(join(root, 'a.jpg'), cameraJpeg({ serial: '1ZNBJ7R00C0123' }));
      await writeFile(
        join(root, 'b.jpg'),
        cameraJpeg({ xmp: 'drone-dji:CameraSerialNumber="53HQN4T0300987"' }),
      );
      await writeFile(join(root, 'c.jpg'), cameraJpeg({ ll: ELSEWHERE }));
      await writeFile(
        join(root, 'd.jpg'),
        cameraJpeg({
          children: '<dc:creator><rdf:Seq><rdf:li>Jane Example</rdf:li></rdf:Seq></dc:creator>',
        }),
      );
      await writeFile(join(root, 'e.jpg'), cameraJpeg({ artist: 'John Pilot' }));
      // a real camera's metadata is refused as before, whatever it says
      await writeFile(join(root, 'f.jpg'), cameraJpeg({ make: 'Acme Drones' }));
      const text = checkFolder(join(dir, 'demo')).findings.join('\n');
      expect(text).toContain(
        'a.jpg: a camera serial number in EXIF (BodySerialNumber "1ZNBJ7R00C0123")',
      );
      expect(text).toContain('b.jpg: a camera serial number in XMP (drone-dji:CameraSerialNumber');
      expect(text).toMatch(
        /c\.jpg EXIF GPS: the camera at 35\.0000, 10\.0000 is outside the fictional sites/,
      );
      expect(text).toContain('d.jpg: a personal name in XMP (dc:creator "Jane Example")');
      expect(text).toContain('e.jpg: a personal name in EXIF (Artist "John Pilot")');
      expect(text).toContain('f.jpg: EXIF metadata (camera, GPS) in a demo photo');
    });

    it('places OPF geolocations, tilesets, raster packs and position files', async () => {
      const root = await cleanProject();
      // OPF: EPSG:4326 lists latitude first
      await writeFile(
        join(root, 'input_cameras.json'),
        JSON.stringify({
          format: 'application/opf-input-cameras+json',
          captures: [
            { geolocation: { crs: { definition: 'EPSG:4326+5773' }, coordinates: [35, 10, 50] } },
          ],
        }),
      );
      // a tileset placed (root transform in ECEF) at the Masafi yard of KNOWN_SITES
      const [lon, lat] = utmToLonLat(32639, 212624, 3201610);
      const r = Math.PI / 180;
      const N = 6378137 / Math.sqrt(1 - 0.00669438 * Math.sin(lat * r) ** 2);
      const ecef = [
        N * Math.cos(lat * r) * Math.cos(lon * r),
        N * Math.cos(lat * r) * Math.sin(lon * r),
        N * (1 - 0.00669438) * Math.sin(lat * r),
      ];
      await mkdir(join(root, 'tiles', 'm'), { recursive: true });
      await writeFile(
        join(root, 'tiles', 'm', 'tileset.json'),
        JSON.stringify({
          asset: { version: '1.1' },
          geometricError: 10,
          root: {
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...ecef, 1],
            boundingVolume: { sphere: [0, 0, 0, 50] },
            geometricError: 0,
          },
        }),
      );
      await writeFile(
        join(root, 'site.json'),
        JSON.stringify({
          schema: 'aio.raster-pack/1',
          id: 'site',
          kind: 'imagery',
          licence: '',
          attribution: 'x',
          customerLicence: true,
          bbox: [51.4, 21.0, 51.5, 21.1],
        }),
      );
      await writeFile(join(root, 'ppk.csv'), `image,lat,lon,h\nSYN_0001.JPG,35,10,200\n`);
      await writeFile(
        join(root, 'gcp_list.txt'),
        'EPSG:32639\n550000 2330000 140 10 10 a.jpg G1\n',
      );
      const text = checkFolder(join(dir, 'demo')).findings.join('\n');
      expect(text).toMatch(/input_cameras\.json OPF geolocation: a position at 35\.0000, 10\.0000/);
      expect(text).toMatch(/tileset\.json tileset: .* km from Masafi yard/);
      expect(text).toMatch(
        /tileset\.json tileset: the tileset at .* is outside the fictional sites/,
      );
      expect(text).toContain('site.json: customer imagery (customerLicence)');
      expect(text).toContain('site.json: a raster pack without a licence');
      expect(text).toMatch(/ppk\.csv row: a position at 35\.0000, 10\.0000 is outside/);
      expect(text).not.toContain('gcp_list.txt');
    });

    it('refuses GeoTIFFs in a demo and places them in a fixture folder', async () => {
      const root = await cleanProject();
      // a GeoTIFF header: tie point 550000 E 2330000 N, ProjectedCSTypeGeoKey 32639
      const b = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 48 + 16);
      b.write('II', 0, 'latin1');
      b.writeUInt16LE(42, 2);
      b.writeUInt32LE(8, 4);
      b.writeUInt16LE(2, 8);
      const data = 8 + 2 + 24 + 4;
      b.writeUInt16LE(33922, 10);
      b.writeUInt16LE(12, 12);
      b.writeUInt32LE(6, 14);
      b.writeUInt32LE(data, 18);
      b.writeUInt16LE(34735, 22);
      b.writeUInt16LE(3, 24);
      b.writeUInt32LE(8, 26);
      b.writeUInt32LE(data + 48, 30);
      [0, 0, 0, 550000, 2330000, 0].forEach((v, i) => b.writeDoubleLE(v, data + 8 * i));
      [1, 1, 0, 1, 3072, 0, 1, 32639].forEach((v, i) => b.writeUInt16LE(v, data + 48 + 2 * i));
      await writeFile(join(root, 'imagery.tif'), b);
      expect(checkFolder(join(dir, 'demo')).findings.join('\n')).toContain(
        'raw GeoTIFF in the demo',
      );
      const r = checkFolder(join(dir, 'demo'), { fixtures: true });
      expect(r.findings).toEqual([]);
      expect(r.points).toBe(2);
    });
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
