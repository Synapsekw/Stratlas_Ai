// The client-data check on M11 survey files (check-m11.mjs, stream G13): LandXML, DXF, 12da,
// JobXML, .dc, CSV, aio.tin/1 and the survey JSON side files must keep every coordinate inside a
// fictional site and mark job names synthetic.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  M11_FICTIONAL_SITES,
  TM_CRS,
  csvXY,
  dcInfo,
  dxfXY,
  jobxmlInfo,
  landxmlInfo,
  lonLatIn,
  surveySite,
  tmInverse,
  twelveDaInfo,
} from './check-m11.mjs';
import { checkFolder, distanceKm, utmToLonLat } from './check-no-client-data.mjs';

// the fictional desert site of the survey demos (UTM 39N) and a real client site (HCl tank)
const SITE = [551200, 2331400];
/** A UTF-8 byte order mark at the start of a CSV. */
const BOM = String.fromCharCode(0xfeff);
const REAL = [216108, 3220019];

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'demo-check-m11-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const landxml = ({ epsg = 32639, project = 'Synthetic design (fictional)', pts = [SITE] } = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">',
    epsg ? `<CoordinateSystem name="x" epsgCode="${String(epsg)}"/>` : '',
    `<Project name="${project}"/>`,
    '<Surfaces><Surface name="S"><Definition surfType="TIN"><Pnts>',
    ...pts.map(([e, n], i) => `<P id="${String(i + 1)}">${String(n)} ${String(e)} 120</P>`),
    '</Pnts><Faces><F>1 1 1</F></Faces></Definition></Surface></Surfaces>',
    `<Alignments><Alignment name="A" length="10" staStart="0"><CoordGeom><Line><Start>${String(pts[0][1])} ${String(pts[0][0])}</Start><End>${String(pts[0][1] + 10)} ${String(pts[0][0])}</End></Line></CoordGeom></Alignment></Alignments>`,
    '</LandXML>',
  ].join('\n');

const dxf = (pts) =>
  [
    '  0',
    'SECTION',
    '  2',
    'ENTITIES',
    ...pts.flatMap(([e, n]) => [
      '  0',
      'POINT',
      '  8',
      'P',
      ' 10',
      String(e),
      ' 20',
      String(n),
      ' 30',
      '1',
    ]),
    '  0',
    'ENDSEC',
    '  0',
    'EOF',
  ].join('\n');

const twelveDa = (pts, project = 'Synthetic (fictional)') =>
  [
    `// project "${project}"`,
    'model "M"',
    'string super {',
    '  name "S"',
    '  data_3d {',
    ...pts.map(([e, n]) => `    ${String(e)} ${String(n)} 120.0`),
    '  }',
    '}',
    'string super {',
    `  data_3d { ${String(pts[0][0])} ${String(pts[0][1])} 120 }`,
    '}',
  ].join('\n');

const jobxml = ({
  job = 'SYNTHETIC-CAL-0001',
  lonLat = [51.4929, 21.0829],
  ne = [50000.5, 10000.5],
} = {}) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<JOBFile jobName="${job}" version="5.6">`,
    '<Environment><CoordinateSystem><Ellipsoid><EarthRadius>6378137</EarthRadius><Flattening>0.0033528106647474805</Flattening></Ellipsoid>',
    '<Projection><Type>TransverseMercatorProjection</Type><Scale>1</Scale><CentralMeridian>51.4929</CentralMeridian>',
    '<OriginLatitude>21.0829</OriginLatitude><FalseNorthing>50000</FalseNorthing><FalseEasting>10000</FalseEasting></Projection>',
    '</CoordinateSystem></Environment><FieldBook><PointRecord><Name>CAL1</Name>',
    `<WGS84><Latitude>${String(lonLat[1])}</Latitude><Longitude>${String(lonLat[0])}</Longitude><Height>120</Height></WGS84>`,
    `<Grid><North>${String(ne[0])}</North><East>${String(ne[1])}</East><Elevation>121</Elevation></Grid>`,
    '</PointRecord></FieldBook></JOBFile>',
  ].join('\n');

const f16 = (v) => String(v).padStart(16);
const dc = (job, ne) =>
  [
    '00NMSC V10-70 (synthetic)',
    `10NM${job.padEnd(16)}`,
    `08KI${f16('CAL1')}${f16(ne[0])}${f16(ne[1])}${f16(121)}${f16('CAL')}`,
  ].join('\r\n');

function tin(bounds, epsg = 32639) {
  const head = Buffer.from(
    JSON.stringify({
      schema: 'aio.tin/1',
      crs: { epsg },
      bounds,
      vertexCount: 0,
      triangleCount: 0,
    }),
  );
  const len = Buffer.alloc(4);
  len.writeUInt32LE(head.length);
  return Buffer.concat([len, head]);
}

/** A survey project at the fictional desert site with every M11 file kind. */
async function surveyProject(o = {}) {
  const root = join(dir, 'p');
  const sv = join(root, 'survey');
  await mkdir(join(sv, 'designs', 'd'), { recursive: true });
  await mkdir(join(sv, 'calibration'), { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      id: 'demo-p',
      name: 'Demo survey',
      crs: o.crs ?? { epsg: 32639 },
      origin: [...SITE, 120],
    }),
  );
  const pts = o.pts ?? [SITE, [SITE[0] + 100, SITE[1] - 50]];
  await writeFile(join(sv, 'designs', 'd', 'd.xml'), landxml({ pts, ...o.landxml }));
  await writeFile(join(sv, 'designs', 'd', 'pad.tin'), tin([...pts[0], 100, ...pts[1], 130]));
  await writeFile(join(sv, 'designs', 'd', 'd.dxf'), dxf(pts));
  await writeFile(join(sv, 'designs', 'd', 'd.12da'), twelveDa(pts));
  await writeFile(
    join(sv, 'points.csv'),
    `${BOM}name,easting,northing,elevation\n${pts.map(([e, n], i) => `P${String(i)},${String(e)},${String(n)},1`).join('\n')}\n`,
  );
  await writeFile(join(sv, 'calibration', 'c.jxl'), jobxml(o.jobxml));
  await writeFile(
    join(sv, 'calibration', 'c.dc'),
    dc(o.dcJob ?? 'SYNTHETIC-1', [50000.5, 10000.5]),
  );
  await writeFile(
    join(sv, 'measurements.json'),
    JSON.stringify({
      schema: 'aio.measurements/1',
      measurements: [{ id: 'm', points: pts.map((p) => [...p, 120]) }],
    }),
  );
  return root;
}

describe('check-m11: placing survey coordinates', () => {
  it('inverts the fixture transverse Mercator CRSs', () => {
    // NAD83(2011) / Nevada Central (ftUS) and British National Grid (OSGB36: within 200 m of WGS 84)
    const nv = lonLatIn({ epsg: 6519 }, 1673594.136, 21214048.017);
    expect(nv[0]).toBeCloseTo(-116.55, 5);
    expect(nv[1]).toBeCloseTo(38.95, 5);
    const bng = lonLatIn({ epsg: 27700 }, 234430.645, 750832.05);
    expect(distanceKm(bng, [-4.7, 56.62])).toBeLessThan(0.2);
    expect(lonLatIn({ epsg: 32639 }, ...SITE)).toEqual(utmToLonLat(32639, ...SITE));
    expect(lonLatIn({ epsg: 4326 }, 1, 2)).toEqual([1, 2]);
    expect(lonLatIn({ epsg: 2193 }, 1, 2)).toBeNull();
    expect(lonLatIn(null, 1, 2)).toBeNull();
    // a UTM zone as a plain TM agrees with the UTM inverse
    const tm = tmInverse(
      { a: 6378137, f: 1 / 298.257223563, lon0: 51, k0: 0.9996, fe: 500000 },
      ...SITE,
    );
    expect(distanceKm(tm, utmToLonLat(32639, ...SITE))).toBeLessThan(1e-6);
    expect(TM_CRS[6519].unit).toBe(1200 / 3937);
    for (const s of M11_FICTIONAL_SITES) expect(surveySite(s.ll)).not.toBeNull();
    expect(surveySite(utmToLonLat(32639, ...REAL))).toBeNull();
  });

  it('reads the formats', () => {
    const lx = landxmlInfo(landxml());
    expect(lx.crs).toEqual({ epsg: 32639 });
    expect(lx.xy[0]).toEqual(SITE);
    expect(lx.xy).toContainEqual([SITE[0], SITE[1] + 10]);
    expect(lx.names).toEqual(['Synthetic design (fictional)']);
    expect(dxfXY(dxf([SITE]))).toEqual([SITE]);
    expect(dxfXY('  0\nPOLYLINE\n 10\n0\n 20\n0\n')).toEqual([]);
    const td = twelveDaInfo(twelveDa([SITE, [SITE[0] + 1, SITE[1]]]));
    expect(td.xy).toHaveLength(3);
    expect(td.names).toEqual(['Synthetic (fictional)']);
    const jx = jobxmlInfo(jobxml());
    expect(jx.names).toEqual(['SYNTHETIC-CAL-0001']);
    expect(jx.lonLat).toEqual([[51.4929, 21.0829]]);
    expect(jx.xy).toEqual([[10000.5, 50000.5]]);
    expect(jx.tm).toMatchObject({ lon0: 51.4929, lat0: 21.0829, fe: 10000, fn: 50000, k0: 1 });
    expect(dcInfo(dc('SYNTHETIC-1', [50000.5, 10000.5]))).toEqual({
      names: ['SYNTHETIC-1'],
      xy: [[10000.5, 50000.5]],
    });
    expect(csvXY(`${BOM}name;x;y\nA;1;2\n`)).toEqual([[1, 2]]);
    expect(csvXY('date,lift,tonnes\n2026-01-31,1,100\n')).toEqual([]);
  });
});

describe('check-m11: in the client-data check', () => {
  it('passes a synthetic survey project with every file kind', async () => {
    await surveyProject();
    const r = checkFolder(dir);
    expect(r.findings).toEqual([]);
    // the origin, then every placed probe of the survey files
    expect(r.points).toBeGreaterThan(20);
  });

  it('fails on real coordinates in each survey format', async () => {
    await surveyProject({ pts: [REAL, [REAL[0] + 100, REAL[1]]] });
    const text = checkFolder(dir).findings.join('\n');
    for (const f of ['d.xml', 'pad.tin', 'd.dxf', 'd.12da', 'points.csv', 'measurements.json'])
      expect(text).toMatch(
        new RegExp(`${f.replace('.', '\\.')}: a survey coordinate at .* outside`),
      );
    expect(text).toContain('km from HCl tank');
  });

  it('fails on job names not marked synthetic and on real positions in controller files', async () => {
    await surveyProject({
      landxml: { project: 'Job 4711 Harbour Road' },
      jobxml: { job: 'J4711-CAL', lonLat: [48.08, 29.08] },
      dcJob: 'J4711',
    });
    const text = checkFolder(dir).findings.join('\n');
    expect(text).toContain(
      'd.xml: a job or project name that is not marked synthetic ("Job 4711 Harbour Road")',
    );
    expect(text).toContain(
      'c.jxl: a job or project name that is not marked synthetic ("J4711-CAL")',
    );
    expect(text).toContain('c.dc: a job or project name that is not marked synthetic ("J4711")');
    expect(text).toMatch(/c\.jxl: a survey coordinate at 29\.08.* outside/);
  });

  it('places a file in its own CRS, else the project, and refuses what it cannot place', async () => {
    // British National Grid coordinates of the fixture site, declared in the LandXML
    const bng = [
      [234430.645, 750832.05],
      [234500, 750900],
    ];
    const root = await surveyProject();
    await writeFile(
      join(root, 'survey', 'designs', 'd', 'bng.xml'),
      landxml({ epsg: 27700, pts: bng }),
    );
    expect(checkFolder(dir).findings).toEqual([]);
    // the same file in London is outside the fictional sites
    await writeFile(
      join(root, 'survey', 'designs', 'd', 'bng.xml'),
      landxml({ epsg: 27700, pts: [[530000, 180000]] }),
    );
    expect(checkFolder(dir).findings.join('\n')).toMatch(/bng\.xml: a survey coordinate at 51\.5/);
    // a project in a CRS the check cannot place
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    await surveyProject({ crs: { wkt: 'LOCAL_CS["site"]' } });
    const text = checkFolder(dir).findings.join('\n');
    expect(text).toContain('d.dxf: coordinates in a CRS this check cannot place');
    expect(text).toContain('d.12da: coordinates in a CRS this check cannot place');
  });

  it('leaves drawings outside survey/ in their local frame (M8)', async () => {
    const root = await surveyProject();
    await writeFile(join(root, 'plan.dxf'), dxf([[10, 20]]));
    expect(checkFolder(dir).findings).toEqual([]);
  });
});
