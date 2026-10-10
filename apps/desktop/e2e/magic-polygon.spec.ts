/**
 * Suggest boundaries in the real app (M11 G12, ADR 0011): with a pipeline pack that carries a
 * boundary model, a click on a stockpile in the ortho gives a draft outline; U and I change its
 * buffer, J thins it, Enter accepts it as an area measurement, and the saved polygon hugs the
 * pile. Without a pack the button says what it needs.
 *
 * Synthetic only: a 60 m ortho (PNG) of sand with one grey pile of 12 m radius at the project
 * origin, a ground mesh for picking, and the plain-operator colour segmenter from
 * `src/main/inference/fixtures/colourSegmenter.ts` as the pack's model (no trained weights).
 * Off-screen, zero network.
 */
import { SCHEMA_VERSION, type ProjectManifestInput } from '@aio/schema';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { colourSegmenterOnnx } from '../src/main/inference/fixtures/colourSegmenter';
import { encodePng } from '../src/main/inference/fixtures/markerDetector';
import { expectAccessible } from './a11y';
import { expect, launchApp, openProject, test, type DataRoot } from './fixtures';

const ID = 'e2e-magic-polygon';
const ORIGIN: [number, number, number] = [500_000, 3_200_000, 0];
const HALF = 30;
const PX = 600;
const PILE_R = 12;

/** A flat square ground of 2 HALF metres (glTF, Y up) so the 3D view has something to pick. */
function groundGlb(): Buffer {
  const h = HALF;
  const positions = new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = {
    asset: { version: '2.0', generator: 'aio e2e magic polygon' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'ground' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: indices.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [-h, 0, -h],
        max: [h, 0, h],
      },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
  const body = pad(bin, 0);
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const chunks = Buffer.concat([chunk(json, 0x4e4f534a), chunk(body, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.length, 8);
  return Buffer.concat([header, chunks]);
}

/** The ortho: sand with a little texture and a shaded grey pile at the centre. */
function orthoPng(): Buffer {
  const rgba = new Uint8Array(PX * PX * 4);
  const m = (2 * HALF) / PX;
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const e = -HALF + (x + 0.5) * m;
      const s = -HALF + (y + 0.5) * m; // metres south of the origin
      const tex = 1 + 0.04 * Math.sin(x * 1.7 + y * 0.9);
      let c = [214 * tex, 190 * tex, 150 * tex];
      const d = Math.hypot(e, s);
      if (d <= PILE_R) {
        const shade = 0.65 + 0.45 * ((e - s) / (2 * PILE_R) + 0.5);
        c = [120 * shade, 120 * shade, 126 * shade];
      }
      rgba.set([...c.map((v) => Math.max(0, Math.min(255, Math.round(v)))), 255], (y * PX + x) * 4);
    }
  }
  return encodePng(PX, PX, rgba);
}

async function createMagicProject(dataRoot: DataRoot): Promise<string> {
  const dir = join(dataRoot.root, 'projects', ID);
  await mkdir(join(dir, 'models'), { recursive: true });
  await mkdir(join(dir, 'rasters'), { recursive: true });
  await writeFile(join(dir, 'models', 'ground.glb'), groundGlb());
  await writeFile(join(dir, 'rasters', 'ortho.png'), orthoPng());
  const manifest: ProjectManifestInput = {
    schema: SCHEMA_VERSION,
    id: ID,
    name: 'E2E magic polygon',
    customer: 'E2E',
    site: 'Synthetic stockpile yard',
    crs: { epsg: 32639 },
    origin: ORIGIN,
    captures: [{ id: 'c1', label: 'Synthetic survey', date: '2026-03-31' }],
    layers: [
      {
        kind: 'mesh',
        id: 'ground',
        name: 'Ground',
        src: { path: 'models/ground.glb' },
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
      {
        kind: 'raster',
        id: 'ortho',
        name: 'Ortho 31 Mar 2026',
        role: 'ortho',
        format: 'image',
        src: { path: 'rasters/ortho.png' },
        corners: { tl: [-HALF, 0, -HALF], tr: [HALF, 0, -HALF], bl: [-HALF, 0, HALF] },
      },
    ],
    severityModels: [],
    classCatalogues: [],
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
  return dir;
}

/** A stand-in pipeline pack (QUADRION_PIPELINE_PYTHON's folder) carrying the test model. */
async function createPack(dataRoot: DataRoot): Promise<string> {
  const dir = join(dataRoot.base, 'pack');
  const sam = join(dir, 'models', 'sam');
  await mkdir(sam, { recursive: true });
  const model = colourSegmenterOnnx();
  await writeFile(join(sam, 'encoder.onnx'), model.encoder);
  await writeFile(join(sam, 'decoder.onnx'), model.decoder);
  await writeFile(join(sam, 'model.json'), JSON.stringify(model.card));
  const python = join(dir, process.platform === 'win32' ? 'python.exe' : 'python');
  await writeFile(python, '');
  return python;
}

interface Saved {
  measurements: { tool: string; points: [number, number, number][] }[];
}

const ringArea = (pts: readonly [number, number, number][]) =>
  Math.abs(
    pts.reduce((s, p, i) => {
      const q = pts[(i + 1) % pts.length] ?? p;
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2,
  );

test.describe('Suggest boundaries', () => {
  test('a click on a pile gives a draft outline; buffer, vertices and Enter make the polygon', async ({
    dataRoot,
    network,
  }) => {
    test.setTimeout(120_000);
    const root = await createMagicProject(dataRoot);
    const python = await createPack(dataRoot);
    const app = await launchApp(dataRoot, {
      QUADRION_PIPELINE_PYTHON: python,
      QUADRION_PIPELINE_PACK: '',
    });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win
        .getByTestId('project-card')
        .filter({ hasText: 'E2E magic polygon' })
        .first()
        .click();
      const canvas = win.locator('[data-scene-view] canvas').first();
      await expect(canvas).toBeVisible();
      await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(ID);
      const box = await canvas.boundingBox();
      if (!box) throw new Error('no 3D view');

      await win.getByRole('button', { name: 'Survey measurements' }).click();
      await win.getByTestId('survey-tool-area').click();
      const bar = win.getByTestId('survey-drawbar');
      await expect(bar).toBeVisible();
      const magic = bar.getByTestId('survey-magic');
      await magic.click();
      await expect(magic).toHaveAttribute('aria-pressed', 'true');

      // the view frames the site: its centre is on the pile
      await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(win.getByTestId('survey-magic-score')).toContainText('90%', { timeout: 30_000 });
      const points = async () =>
        Number(/(\d+) points?/.exec((await bar.textContent()) ?? '')?.[1] ?? 0);
      await expect.poll(points).toBeGreaterThan(8);
      await expectAccessible(win, 'Suggest boundaries', { include: '.sv-magic' });

      // I twice grows the buffer by 4 crop pixels; J thins the outline
      await win.keyboard.press('i');
      await win.keyboard.press('i');
      await expect(win.locator('.sv-magic')).toContainText('+4 px');
      const before = await points();
      await win.keyboard.press('j');
      await expect.poll(points).toBeLessThan(before);

      // Remove area: the next click steers the same draft instead of starting a new one
      await win.getByTestId('survey-magic-mode-remove').click();
      await expect(win.getByTestId('survey-magic-mode-remove')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await win.mouse.click(box.x + box.width / 2 + 4, box.y + box.height / 2 + 4);
      await expect(win.getByTestId('survey-magic-score')).toContainText('90%');
      await expect(win.locator('.sv-magic')).toContainText('+4 px');

      // Enter accepts the draft as the area measurement
      await win.keyboard.press('Enter');
      await expect(win.getByTestId('survey-item')).toHaveCount(1);
      await win.keyboard.press('Escape');
      await win.getByTestId('survey-list-save').click();
      await expect(win.getByTestId('survey-list')).toContainText('Measurements saved.');
      const saved = JSON.parse(
        await readFile(join(root, 'survey', 'measurements.json'), 'utf8'),
      ) as Saved;
      const [area] = saved.measurements;
      expect(area?.tool).toBe('area');
      const pts = area?.points ?? [];
      // the pile is 452 m2; the buffer adds about 4 x 60 / 1024 m around it
      const truth = Math.PI * PILE_R * PILE_R;
      expect(ringArea(pts) / truth).toBeGreaterThan(0.92);
      expect(ringArea(pts) / truth).toBeLessThan(1.15);
      // the polygon's centroid (area weighted) is the pile's centre
      let ax = 0;
      let ay = 0;
      let a2 = 0;
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length] ?? p;
        const cross =
          (p[0] - ORIGIN[0]) * (q[1] - ORIGIN[1]) - (q[0] - ORIGIN[0]) * (p[1] - ORIGIN[1]);
        a2 += cross;
        ax += (p[0] - ORIGIN[0] + q[0] - ORIGIN[0]) * cross;
        ay += (p[1] - ORIGIN[1] + q[1] - ORIGIN[1]) * cross;
      });
      expect(Math.hypot(ax / (3 * a2), ay / (3 * a2))).toBeLessThan(0.3);
      for (const p of pts)
        expect(Math.hypot(p[0] - ORIGIN[0], p[1] - ORIGIN[1])).toBeLessThan(PILE_R + 1);
    } finally {
      await app.close();
    }
  });

  test('without a pipeline pack the button says what it needs', async ({ dataRoot, network }) => {
    await createMagicProject(dataRoot);
    const app = await launchApp(dataRoot, {
      QUADRION_PIPELINE_PYTHON: '',
      QUADRION_PIPELINE_PACK: '',
    });
    await network.attach(app);
    try {
      const win = await app.firstWindow();
      await win
        .getByTestId('project-card')
        .filter({ hasText: 'E2E magic polygon' })
        .first()
        .click();
      await expect.poll(async () => (await openProject(win)).id, { timeout: 30_000 }).toBe(ID);
      await win.getByRole('button', { name: 'Survey measurements' }).click();
      await win.getByTestId('survey-tool-area').click();
      const magic = win.getByTestId('survey-magic');
      await magic.click();
      await expect(magic).toHaveAttribute('aria-pressed', 'false');
      await expect(win.getByTestId('survey-magic-status')).toContainText('needs the pipeline pack');
    } finally {
      await app.close();
    }
  });
});
