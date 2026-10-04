import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeTiff } from './testing';
import {
  decodeTiff,
  epsgFromPrj,
  parseWorldFile,
  rasterToRgba,
  readTiffHeader,
  tiffCorners,
} from './tiff';

const deflate = (b: Uint8Array) => new Uint8Array(deflateSync(b));

const rgb = (w: number, h: number) =>
  Array.from({ length: w * h * 3 }, (_, i) => (i * 37 + Math.floor(i / 3) * 11) % 256);

describe('decodeTiff', () => {
  for (const [name, compression, predictor] of [
    ['uncompressed', 1, 1],
    ['LZW with predictor', 5, 2],
    ['Deflate', 8, 1],
  ] as const) {
    it(`reads an ${name} RGB GeoTIFF in several strips`, () => {
      const values = rgb(7, 5);
      const t = decodeTiff(
        makeTiff(
          {
            width: 7,
            height: 5,
            samples: 3,
            bits: 8,
            values,
            compression,
            predictor,
            rowsPerStrip: 2,
            epsg: 32639,
            pixelScale: [0.5, 0.5],
            tiepoint: [221000, 3214500],
          },
          deflate,
        ),
      );
      expect([t.width, t.height, t.samples, t.bits]).toEqual([7, 5, 3, 8]);
      expect([...t.data]).toEqual(values);
      expect(t.geo.epsg).toBe(32639);
    });
  }

  it('reads a float DSM with its no-data value', () => {
    const t = decodeTiff(
      makeTiff(
        {
          width: 2,
          height: 2,
          samples: 1,
          bits: 32,
          format: 'float',
          values: [1.5, 2.5, -9999, 4],
          nodata: '-9999',
        },
        deflate,
      ),
    );
    expect(t.format).toBe('float');
    expect([...t.data]).toEqual([1.5, 2.5, -9999, 4]);
    expect(t.nodata).toBe(-9999);
  });

  it('reports the size without decoding', () => {
    const b = makeTiff(
      { width: 3, height: 2, samples: 1, bits: 16, values: [1, 2, 3, 4, 5, 6] },
      deflate,
    );
    expect(readTiffHeader(b)).toMatchObject({ width: 3, height: 2, bits: 16, bigTiff: false });
    expect([...decodeTiff(b).data]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects files that are not TIFF', () => {
    expect(() => decodeTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/TIFF/);
  });
});

describe('georeference', () => {
  it('gives the outer corners from the tiepoint and pixel size', () => {
    const c = tiffCorners({
      width: 100,
      height: 50,
      geo: { pixelScale: [0.5, 0.5], tiepoint: [0, 0, 1000, 2000], pixelIsPoint: false },
    });
    expect(c).toEqual({ tl: [1000, 2000], tr: [1050, 2000], bl: [1000, 1975] });
  });

  it('reads a world file (centre of the first pixel) the same way', () => {
    const wf = parseWorldFile('0.5\n0\n0\n-0.5\n1000.25\n1999.75\n');
    const c = tiffCorners({ width: 100, height: 50, geo: { pixelIsPoint: false } }, wf);
    expect(c.tl).toEqual([1000, 2000]);
    expect(c.bl).toEqual([1000, 1975]);
  });

  it('finds the EPSG code of a .prj', () => {
    expect(
      epsgFromPrj(
        'PROJCS["WGS 84 / UTM zone 39N",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],AUTHORITY["EPSG","32639"]]',
      ),
    ).toBe(32639);
    expect(epsgFromPrj('PROJCS["WGS_1984_UTM_Zone_39N",GEOGCS["GCS_WGS_1984"]]')).toBe(32639);
  });
});

describe('rasterToRgba', () => {
  it('downsamples an ortho and keeps no-data transparent', () => {
    const t = decodeTiff(
      makeTiff({ width: 4, height: 2, samples: 3, bits: 8, values: rgb(4, 2) }, deflate),
    );
    const img = rasterToRgba(t, 'ortho', 2);
    expect([img.width, img.height]).toEqual([2, 1]);
    expect(img.data[3]).toBe(255);
  });

  it('shades a DSM and reports its height range', () => {
    const t = decodeTiff(
      makeTiff(
        {
          width: 3,
          height: 3,
          samples: 1,
          bits: 32,
          format: 'float',
          values: [10, 11, 12, 10, 11, 12, -9999, 11, 12],
          nodata: '-9999',
          pixelScale: [1, 1],
        },
        deflate,
      ),
    );
    const img = rasterToRgba(t, 'dsm');
    expect(img.range).toEqual([10, 12]);
    expect(img.data[6 * 4 + 3]).toBe(0);
    expect(img.data[3]).toBe(255);
  });
});
