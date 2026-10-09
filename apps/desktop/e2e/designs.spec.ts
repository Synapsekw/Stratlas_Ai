/**
 * Designs in the site view (M11 G6): a small LandXML design (a 3 x 3 pad surface with a breakline
 * and boundary, two points, and an alignment with a line, a clothoid, an arc and a station
 * equation, all synthetic at the tiny project's site) is imported through the Designs panel with
 * `design.import` (development pipeline Python), through the options step (detected format, units
 * and layers). It shows in the panel with its layers and counts, and is drawn in the 3D view (its
 * surface, points and alignment objects) and on the map (the designs source and layers, with
 * station labels); hiding a layer takes it out of the view. Activating the alignment makes the
 * cursor readout show station and offset. Zero network, as every test (the fixture asserts it).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, hasPipelinePython, PIPELINE_ENV, test } from './fixtures';

test.use({ appEnv: PIPELINE_ENV });
test.setTimeout(180_000);

// the tiny project's origin (fixtures.ts tinyManifest)
const OE = 500000;
const ON = 3200000;

interface Element {
  type: 'line' | 'spiral' | 'arc';
  start: [number, number];
  end: [number, number];
  center?: [number, number];
}

/** The shared G6 alignment fixture, moved so that it starts at the project origin heading north. */
function shiftedAlignment(): { elements: Element[]; pi: [number, number] } {
  const f = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../packages/survey/src/designs/__fixtures__/alignment-clothoid.json',
      ),
      'utf8',
    ),
  ) as { alignment: { elements: Element[] }; spiralPI: [number, number] };
  const [e0, n0] = f.alignment.elements[0]?.start ?? [0, 0];
  const mv = (p: [number, number]): [number, number] => [p[0] - e0 + OE, p[1] - n0 + ON];
  return {
    elements: f.alignment.elements.map((el) => ({
      ...el,
      start: mv(el.start),
      end: mv(el.end),
      ...(el.center ? { center: mv(el.center) } : {}),
    })),
    pi: mv(f.spiralPI),
  };
}

function landXml(): string {
  const ne = (p: [number, number]) => `${p[1].toFixed(6)} ${p[0].toFixed(6)}`;
  const pts: string[] = [];
  let k = 1;
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++)
      pts.push(
        `<P id="${String(k++)}">${String(ON + 10 + 10 * j)} ${String(OE + 10 + 10 * i)} ${String(100 + 0.5 * i + 0.25 * j)}</P>`,
      );
  const faces: string[] = [];
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const a = j * 3 + i + 1;
      faces.push(
        `<F>${String(a)} ${String(a + 1)} ${String(a + 4)}</F>`,
        `<F>${String(a)} ${String(a + 4)} ${String(a + 3)}</F>`,
      );
    }
  const { elements, pi } = shiftedAlignment();
  const [line, spi, arc] = elements;
  if (!line || !spi || !arc?.center) throw new Error('fixture');
  return `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
  <Units><Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" angularUnit="radians"/></Units>
  <CgPoints name="Control"><CgPoint name="CP1">${String(ON + 5)} ${String(OE + 5)} 99.5</CgPoint></CgPoints>
  <Surfaces><Surface name="Pad design"><Definition surfType="TIN">
    <Pnts>${pts.join('')}</Pnts><Faces>${faces.join('')}</Faces>
  </Definition></Surface></Surfaces>
  <Alignments><Alignment name="CL1" staStart="1000"><CoordGeom>
    <Line><Start>${ne(line.start)}</Start><End>${ne(line.end)}</End></Line>
    <Spiral length="60" radiusStart="INF" radiusEnd="200" rot="cw" spiType="clothoid"><Start>${ne(spi.start)}</Start><PI>${ne(pi)}</PI><End>${ne(spi.end)}</End></Spiral>
    <Curve rot="cw" radius="200"><Start>${ne(arc.start)}</Start><Center>${ne(arc.center)}</Center><End>${ne(arc.end)}</End></Curve>
  </CoordGeom><StaEquation staBack="1150" staAhead="2000" staInternal="1150"/></Alignment></Alignments>
</LandXML>
`;
}

/** The design layer of every object in the 3D view's designs group (in the page). */
function designObjects(): string[] {
  const g = (
    window as unknown as {
      __stratlas: {
        stage(): {
          scene: {
            getObjectByName(
              n: string,
            ): { children: { userData: { designRef?: string } }[] } | undefined;
          };
        } | null;
      };
    }
  ).__stratlas
    .stage()
    ?.scene.getObjectByName('aio-designs');
  return (g?.children ?? []).map((c) => c.userData.designRef ?? '');
}

/** The layer and kind of every feature in the map's designs source, once its layers are on. */
function mapDesignFeatures(): string[] {
  const el = [...document.querySelectorAll('*')].find((e) => '__aioMap' in e) as
    | (Element & {
        __aioMap: {
          getLayer(id: string): unknown;
          querySourceFeatures(id: string): { properties: { ref?: string; kind?: string } }[];
        };
      })
    | undefined;
  const m = el?.__aioMap;
  if (!m?.getLayer('aio-designs-line') || !m.getLayer('aio-designs-label')) return [];
  const keys = m
    .querySourceFeatures('aio-designs')
    .map((f) => (f.properties.ref ?? '') + ' ' + (f.properties.kind ?? ''));
  return [...new Set(keys)].sort();
}

async function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
  }, path);
}

/**
 * The Designs button is in the Survey measurements popover, whose tool sits on the toolbar, or
 * under More tools when the toolbar is narrow.
 */
async function openDesigns(win: Page): Promise<void> {
  const survey = win.getByRole('button', { name: 'Survey measurements', exact: true });
  if (!(await survey.isVisible())) await win.getByRole('button', { name: 'More tools' }).click();
  await survey.click();
  await win.getByRole('button', { name: 'Designs', exact: true }).click();
  await expect(win.getByTestId('designs-panel')).toBeVisible();
}

test('a LandXML design imports, shows in the Designs panel and its alignment gives station and offset', async ({
  app,
  win,
  dataRoot,
}) => {
  test.skip(!hasPipelinePython(), 'no development pipeline Python (python/.venv)');
  const src = join(dataRoot.base, 'Pad design.xml');
  await writeFile(src, landXml());

  await win.getByTestId('project-card').filter({ hasText: 'E2E tiny project' }).click();
  await expect(win.locator('[data-scene-view] canvas')).toBeVisible();

  await openDesigns(win);
  await expect(win.getByText('No designs yet.', { exact: false })).toBeVisible();
  await answerOpenDialog(app, src);
  await win.getByRole('button', { name: 'Import design' }).click();

  // the options step: what a quick look at the file found, every layer ticked
  const options = win.getByTestId('design-import');
  await expect(options).toBeVisible();
  await expect(options.getByTestId('design-import-format')).toContainText('Automatic (LandXML)');
  await expect(options.getByTestId('design-import-units')).toContainText('metres');
  const layerList = options.getByTestId('design-import-layers');
  for (const name of ['Control', 'Pad design', 'CL1'])
    await expect(layerList.getByRole('checkbox', { name })).toBeChecked();
  await options.getByTestId('design-import-start').click();
  await expect(options).toHaveCount(0);

  // the job runs, then the panel reloads with the design and its four layers
  const design = win.getByTestId('design-Pad-design');
  await expect(design).toBeVisible({ timeout: 120_000 });
  await expect(win.getByTestId('design-layer-Pad-design')).toContainText('8 triangles, 9 vertices');
  await expect(win.getByTestId('design-layer-CL1')).toContainText('Alignment');
  await expect(win.getByTestId('design-layer-Control')).toContainText('1 point');

  // drawn in the 3D view: the surface (mesh and outline), the points and the alignment (line and
  // station ticks), each tagged with its layer
  const drawn = () => win.evaluate(designObjects);
  await expect
    .poll(async () => [...new Set(await drawn())].sort(), { timeout: 20_000 })
    .toEqual(['Pad-design/CL1', 'Pad-design/Control', 'Pad-design/Pad-design']);
  expect((await drawn()).filter((r) => r === 'Pad-design/Pad-design')).toHaveLength(2);
  await expect(win.locator('.dsn-station').first()).toBeAttached();

  // hiding a layer takes it out of the view
  await win
    .getByTestId('design-layer-Control')
    .getByRole('checkbox', { name: 'Show Control' })
    .click();
  await expect.poll(async () => (await drawn()).includes('Pad-design/Control')).toBe(false);

  // activate the alignment: the panel says so and designs.json records it
  await win
    .getByTestId('alignment-CL1')
    .getByRole('button', { name: 'Activate alignment' })
    .click();
  await expect(win.getByTestId('active-alignment')).toContainText('CL1');
  const saved = (await win.evaluate(async () => {
    const w = window as unknown as {
      aio: { invoke(c: string, r: unknown): Promise<unknown> };
      __stratlas: { workspace: { getState(): { project: { id: string } | null } } };
    };
    return w.aio.invoke('survey:readDesigns', {
      projectId: w.__stratlas.workspace.getState().project?.id,
    });
  })) as { ok: boolean; file: { activeAlignment?: string } };
  expect(saved.file.activeAlignment).toBe('Pad-design/CL1');

  // close the panel (and the Survey measurements popover around it), look straight down at the
  // origin: the cursor readout gains station and offset
  await win.keyboard.press('Escape');
  await win.keyboard.press('Escape');
  await win.evaluate(() =>
    (
      window as unknown as { __stratlas: { stage(): { setViewPreset(p: string): void } | null } }
    ).__stratlas
      .stage()
      ?.setViewPreset('top'),
  );
  const canvas = win.locator('[data-scene-view] canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  await expect
    .poll(
      async () => {
        await win.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
        await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        return (await win.locator('.cursor-ro').first().textContent()) ?? '';
      },
      { timeout: 20_000 },
    )
    .toMatch(/Sta \d+\+\d{3}\.\d{3} {2}Off \d+\.\d{3}/);

  // on the map: the designs source with the pad outline, the alignment and its station labels
  const bar = win.getByRole('toolbar', { name: 'Stage tools' });
  await bar.getByRole('button', { name: 'Map' }).click();
  await expect(win.locator('.maplibregl-canvas').first()).toBeVisible();
  await expect
    .poll(() => win.evaluate(mapDesignFeatures), { timeout: 30_000 })
    .toEqual([
      'Pad-design/CL1 alignment',
      'Pad-design/CL1 station',
      'Pad-design/Pad-design surface',
    ]);
});
