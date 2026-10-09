/**
 * Survey exports in the real app (M11 G7, SRV-9, DSN-5) on the synthetic earthworks demo: the
 * design surface as LandXML and DXF in the site grid, a prepared DSM as GeoTIFF in WGS 84 and the
 * measurements as CSV, each through **Export survey data**: the save dialog first (stubbed to a
 * folder), then `survey.export` writes there. The files carry the expected suffixes and parse
 * (the GeoTIFF read back by rasterio with its CRS), and nothing is left in the project.
 * Off-screen, zero network, pipeline Python needed.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectAccessible } from './a11y';
import { expect, hasPipelinePython, PIPELINE_ENV, test, VENV_PYTHON } from './fixtures';
import { openDemo, prepareSurveys } from './surveyJobs';

test.use({ appEnv: PIPELINE_ENV });
test.skip(!hasPipelinePython(), `no Python with aio_pipelines at ${VENV_PYTHON}`);

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'jobs') out.push(...(await listFiles(p)));
    } else out.push(p);
  }
  return out;
}

test('the design as LandXML and DXF, a DSM as GeoTIFF in WGS 84, measurements as CSV', async ({
  earthworksProject,
  app,
  win,
  dataRoot,
}) => {
  test.setTimeout(420_000);
  const root = earthworksProject.dir;
  await prepareSurveys(win, root);
  const survey = join(root, 'survey');
  const before = (await listFiles(survey)).sort();

  // the save dialog answers the offered name in our folder
  const out = join(dataRoot.base, 'exports');
  await mkdir(out, { recursive: true });
  await app.evaluate(
    ({ dialog }, folder) => {
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        return Promise.resolve({ canceled: false, filePath: `${folder}/${name}` });
      };
    },
    out.replace(/\\/g, '/'),
  );

  await openDemo(win, earthworksProject.name, earthworksProject.id);
  await win.getByRole('button', { name: 'Survey measurements' }).click();
  await win.getByTestId('survey-export-open').click();
  const dlg = win.getByTestId('survey-export-dialog');
  await expect(dlg).toBeVisible();
  await expectAccessible(win, 'Export survey data', {
    include: '[data-testid="survey-export-dialog"]',
  });

  const exportAs = async (suffix: string): Promise<string> => {
    const name = await dlg.getByTestId('survey-export-name').innerText();
    expect(name.endsWith(suffix)).toBe(true);
    await dlg.getByTestId('survey-export-run').click();
    await expect(dlg.getByTestId('survey-export-note')).toContainText('Saved', {
      timeout: 120_000,
    });
    return join(out, name);
  };

  // the pad design surface as LandXML in the site grid
  await dlg.getByTestId('survey-export-what').selectOption('surface');
  await dlg.getByTestId('survey-export-source').selectOption('layer:earthworks-design/pad');
  await dlg.getByTestId('survey-export-format').selectOption('landxml');
  await dlg.getByTestId('survey-export-crs').selectOption('site');
  await dlg.getByTestId('survey-export-units').selectOption('m');
  const xmlPath = await exportAs('_site-grid_m.xml');
  const xml = await readFile(xmlPath, 'utf8');
  expect(xml).toContain('<LandXML');
  expect(xml).toContain('epsgCode="32639"');
  expect(xml).toContain('<Surface name="Pad design">');
  expect(xml).toContain('Vertical datum: Project heights');
  expect((xml.match(/<F>/g) ?? []).length).toBe(18);

  // the same as DXF (3DFACE)
  await dlg.getByTestId('survey-export-format').selectOption('dxf');
  const dxfPath = await exportAs('_site-grid_m.dxf');
  const dxf = await readFile(dxfPath, 'utf8');
  expect(dxf).toContain('AC1024');
  expect((dxf.match(/\n3DFACE\n/g) ?? []).length).toBe(18);
  expect(dxf).toContain('Quadrion CRS');

  // the first survey's DSM as GeoTIFF in WGS 84
  await dlg.getByTestId('survey-export-source').selectOption('surface:dsm-d1');
  await dlg.getByTestId('survey-export-format').selectOption('geotiff');
  await dlg.getByTestId('survey-export-crs').selectOption('wgs84');
  const tifPath = await exportAs('_wgs84_m.tif');
  const read = spawnSync(
    VENV_PYTHON,
    [
      '-c',
      'import json,sys,rasterio\nwith rasterio.open(sys.argv[1]) as d:\n print(json.dumps({"epsg": d.crs.to_epsg(), "w": d.width, "b": list(d.bounds), "units": d.units[0], "tags": d.tags()}))',
      tifPath,
    ],
    { encoding: 'utf8' },
  );
  expect(read.stderr).toBe('');
  const tif = JSON.parse(read.stdout) as {
    epsg: number;
    w: number;
    b: number[];
    units: string;
    tags: Record<string, string>;
  };
  expect(tif.epsg).toBe(4326);
  expect(tif.w).toBeGreaterThan(10);
  expect(tif.b[0]).toBeGreaterThan(51);
  expect(tif.b[0]).toBeLessThan(52);
  expect(tif.units).toBe('metre');
  expect(tif.tags.QUADRION_VERTICAL_DATUM).toContain('Project heights');
  const note = await readFile(tifPath.replace(/\.tif$/, '.txt'), 'utf8');
  expect(note).toContain('Coordinate system: WGS 84');

  // every measurement as CSV points (PNEZD)
  await dlg.getByTestId('survey-export-what').selectOption('measurements');
  await dlg.getByTestId('survey-export-measurements').selectOption('all');
  await dlg.getByTestId('survey-export-format').selectOption('csv');
  await dlg.getByTestId('survey-export-crs').selectOption('site');
  const csvPath = await exportAs('_site-grid_m.csv');
  const rows = (await readFile(csvPath, 'utf8')).trim().split('\n');
  expect(rows.length).toBe(20); // five polygons of four vertices
  for (const r of rows) {
    const c = r.split(',');
    expect(c).toHaveLength(5);
    expect(Number.isFinite(Number(c[1])) && Number.isFinite(Number(c[2]))).toBe(true);
    expect(Number(c[1])).toBeGreaterThan(2_000_000); // northing first
  }

  // nothing was written into the project: survey/ is as it was, and no export is anywhere in it
  expect((await listFiles(survey)).sort()).toEqual(before);
  const all = await listFiles(root);
  expect(all.filter((f) => /_(site-grid|wgs84)_m\.(xml|dxf|tif|csv|txt)$/.test(f))).toEqual([]);
});
