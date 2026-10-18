/* global window */
/** Actual desktop screenshots and picking against a private generated benchmark.
 * node tools/agent/engineering-visual-proof.mjs <project> <build-directory> <output>
 * Launches a disposable profile. Source cloud files are linked read-only by convention; no
 * processing/editing tools are invoked and the original project/GLB is never modified.
 */
import { readFile, writeFile, mkdir, copyFile, cp, link } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { createDataRoot, launchApp } = await jiti.import('../../apps/desktop/e2e/fixtures.ts');
const { georefToLayerTransform } = await jiti.import('../../packages/geo/src/index.ts');
const { ProjectManifest, EngineerRun } = await jiti.import('../../packages/schema/src/index.ts');
const [inputArg, buildArg, outArg] = process.argv.slice(2);
if (!inputArg || !buildArg || !outArg) throw new Error('Expected project, build directory, output');
const input = resolve(inputArg),
  build = resolve(buildArg),
  out = resolve(outArg);
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const data = await createDataRoot();
const manifest = await json(join(input, 'manifest.json'));
const model = await json(join(build, 'model.procmodel.json'));
const dir = join(data.root, 'projects', manifest.id);
await mkdir(join(dir, 'models'), { recursive: true });
await mkdir(out, { recursive: true });
for (const layer of manifest.layers) {
  if (layer.kind !== 'pointcloud') continue;
  const relative = layer.src.path;
  await mkdir(dirname(join(dir, relative)), { recursive: true });
  await link(join(input, relative), join(dir, relative));
}
const layerId = `model-draft-${model.id}`;
await copyFile(join(build, 'model.glb'), join(dir, `models/draft-${model.id}.glb`));
await copyFile(join(build, 'model.procmodel.json'), join(dir, `models/${model.id}.procmodel.json`));
const runId = model.run.id;
await cp(join(input, 'engineering', runId), join(dir, 'engineering', runId), { recursive: true });
// Preserve a live run's real stages, proposal, approval and metered usage in the review proof.
// Only source-only builds without a run record receive the explicitly labelled fixture below.
let savedRun;
try {
  savedRun = EngineerRun.parse(await json(join(input, 'engineering', runId, 'run.json')));
  if (savedRun.id !== runId || savedRun.modelId !== model.id)
    throw new Error('The saved run does not belong to this generated model.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await writeFile(
  join(dir, 'engineering', runId, 'run.json'),
  JSON.stringify(
    savedRun ?? {
      schema: 'aio.engineer-run/1',
      id: runId,
      modelId: model.id,
      createdAt: new Date().toISOString(),
      setup: {
        sources: {
          clouds: manifest.layers
            .filter((l) => l.kind === 'pointcloud')
            .map((l) => ({ layer: l.id })),
          meshes: [],
          photos: [],
        },
        family: 'telecom-monopole',
        scope: 'asset-and-surroundings',
        detail: 'detailed',
        placement: 'from-source',
      },
      stages: Object.fromEntries(
        ['inspect', 'estimate', 'identify', 'generate', 'validate', 'review'].map((s) => [
          s,
          {
            status: s === 'identify' ? 'skipped' : 'done',
            ...(s === 'identify'
              ? { message: 'Measured-only production benchmark; no live AI call.' }
              : {}),
          },
        ]),
      ),
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    },
  ),
);
// A saved project may already contain this draft. Replace it only in the disposable copy.
manifest.layers = manifest.layers.filter((layer) => layer.id !== layerId);
manifest.layers.push({
  id: layerId,
  name: 'Generated benchmark',
  kind: 'mesh',
  src: { path: `models/draft-${model.id}.glb` },
  transform: georefToLayerTransform(model.georef, manifest).transform,
  georef: model.georef,
  placement: 'placed',
});
await writeFile(join(dir, 'manifest.json'), JSON.stringify(ProjectManifest.parse(manifest)));
await writeFile(join(dir, 'issues.json'), JSON.stringify({ schema: 'aio.issues/1', issues: [] }));
const app = await launchApp(data, {
  QUADRION_WINDOW_SIZE: '1600x1000',
  QUADRION_E2E_SCALE: '1',
  QUADRION_SHOW_GATE: '0',
});
const shots = [];
try {
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.locator('.nav-item', { hasText: 'Projects' }).first().click();
  await win.getByTestId('project-card').filter({ hasText: manifest.name }).first().click();
  await win.waitForFunction(
    (id) => window.__stratlas?.workspace.getState().project?.id === id,
    manifest.id,
  );
  await win.locator('.nav-item', { hasText: 'Scene' }).first().click();
  await win.waitForFunction(
    (id) => (window.__stratlas.stage()?.components(id).length ?? 0) > 0,
    layerId,
    { timeout: 60000 },
  );
  const sourceIds = manifest.layers.filter((l) => l.kind === 'pointcloud').map((l) => l.id);
  const look = async (p, distance, dir) => {
    await win.evaluate(
      ([p, distance, dir]) =>
        window.__stratlas.workspace.getState().flyTo({ kind: 'point', p, distance, dir }),
      [p, distance, dir],
    );
    await win.waitForTimeout(1800);
  };
  await win.evaluate(
    ([layer, clouds]) => window.__stratlas.workspace.getState().applyVisibility([layer], clouds),
    [layerId, sourceIds],
  );
  await look([0, 16, 0], 65, [1, 0.15, 1]);
  await win.screenshot({ path: join(out, 'app-full.png') });
  await look([0, 28, 0], 14, [1, 0.3, 1]);
  await win.screenshot({ path: join(out, 'app-crown.png') });
  const cloudRow = win.getByTestId(`tree-row-${sourceIds[0]}`);
  if (!(await cloudRow.isVisible())) await win.getByTestId('tree-group-toggle-pointclouds').click();
  await cloudRow.click({ button: 'right' });
  await win.getByTestId('menu-create-engineering').click();
  await win.getByTestId('eng-review').click();
  const review = win
    .locator('#wb-panel-review [data-testid="review-bench"]')
    .getByTestId('eng-model-review');
  await review.waitFor({ state: 'visible' });
  await win.locator('#wb-tab-review[aria-selected="true"]').waitFor({ state: 'visible' });
  const inventoryVisible = await review.getByTestId('component-tree').evaluate((tree) => {
    const r = tree.getBoundingClientRect();
    const viewport = tree.closest('.wb-scroll').getBoundingClientRect();
    return r.top >= viewport.top - 2 && r.top + 80 < viewport.bottom;
  });
  if (!inventoryVisible)
    throw new Error('Review notes push the component inventory outside the viewport');
  await look([0, 28, 0], 14, [1, 0.3, 1]);
  await win.screenshot({ path: join(out, 'app-review.png') });
  await review.getByRole('button', { name: 'Corrections', exact: true }).click();
  const corrections = review.getByRole('region', { name: 'Model corrections', exact: true });
  await corrections
    .getByRole('combobox', { name: 'Part to correct' })
    .waitFor({ state: 'visible' });
  await corrections
    .getByRole('textbox', { name: 'Describe the discrepancy' })
    .waitFor({ state: 'visible' });
  await win.screenshot({ path: join(out, 'app-corrections.png') });
  await review.getByRole('button', { name: 'Components', exact: true }).click();
  await review.getByTestId('component-tree').waitFor({ state: 'visible' });
  for (const kind of ['panel', 'rru']) {
    let picked = false;
    for (const part of model.assemblies.filter(
      (a) => a.kind === 'antenna' && a.params.kind === kind,
    )) {
      const az = (part.params.azimuthDeg * Math.PI) / 180,
        p = part.params.centre;
      await look(p, Math.max(3, part.params.size[1] * 2.3), [Math.sin(az), 0.12, -Math.cos(az)]);
      const hit = await win.evaluate((p) => {
        const s = window.__stratlas.stage(),
          V = s.camera.position.constructor,
          v = new V(...p).project(s.camera),
          r = s.canvas.getBoundingClientRect();
        return {
          id: s.pickAt(v.x, v.y)?.node,
          x: r.x + ((v.x + 1) * r.width) / 2,
          y: r.y + ((1 - v.y) * r.height) / 2,
        };
      }, p);
      if (hit.id !== part.id) continue;
      await win.mouse.click(hit.x, hit.y);
      await win.waitForFunction(
        (id) => window.__stratlas.workspace.getState().selection?.id === id,
        part.id,
      );
      await win.mouse.move(20, 20);
      await win.waitForTimeout(400);
      const cardVisible = await review.getByTestId('component-card').evaluate((card) => {
        const r = card.getBoundingClientRect();
        const viewport = card.closest('.wb-scroll').getBoundingClientRect();
        return r.top >= viewport.top - 2 && r.top + 80 < viewport.bottom;
      });
      if (!cardVisible) throw new Error(`Selected ${kind} details are outside the review viewport`);
      await win.screenshot({ path: join(out, `app-selected-${kind}.png`) });
      shots.push({ kind, component: part.id, picked: true });
      picked = true;
      break;
    }
    if (!picked) throw new Error(`No ${kind} could be picked from its measured front direction`);
  }
  // Exercise the refined removable hardware with real raycasts and mouse selection too.
  const details = [
    ['mount', (a) => a.kind === 'antennaMount' && a.params.kind === 'clamp'],
    ['cable', (a) => a.kind === 'pipeRun' && a.id.endsWith('-service-loop')],
    ['roof', (a) => a.kind === 'deck' && a.params.roofPanels?.length],
    ['climbing', (a) => a.kind === 'ladder' && a.params.style === 'step-bolts'],
  ];
  for (const [kind, accepts] of details) {
    const candidates = model.assemblies.filter(accepts);
    if (!candidates.length) continue; // Older benchmark models predate these supported details.
    let selected = false;
    for (const part of candidates.slice(0, 8)) {
      const g = part.params;
      let p,
        direction = [1, 0.4, 1],
        distance = 2;
      if (kind === 'roof') {
        p = g.roofPanels[0].reduce((s, v) => s.map((x, i) => x + v[i] / 4), [0, 0, 0]);
        direction = [0.3, 1, 0.4];
        distance = 6;
      } else if (kind === 'climbing') {
        p = g.steps[Math.floor(g.steps.length / 2)];
        direction = [g.outward[0], 0.15, g.outward[2]];
      } else if (kind === 'cable') {
        p = g.path[Math.floor(g.path.length / 3)];
        direction = [p[0], 0.1, p[2]];
      } else {
        p = g.centre.map((x, i) => (x + g.anchor[i]) / 2);
        const az = (g.azimuthDeg * Math.PI) / 180;
        direction = [Math.cos(az), 0.5, Math.sin(az)];
      }
      await look(p, distance, direction);
      const hit = await win.evaluate((id) => {
        const s = window.__stratlas.stage(),
          r = s.canvas.getBoundingClientRect();
        for (let y = -0.35; y <= 0.35; y += 0.014) {
          for (let x = -0.35; x <= 0.35; x += 0.014) {
            if (s.pickAt(x, y)?.node === id)
              return { x: r.x + ((x + 1) * r.width) / 2, y: r.y + ((1 - y) * r.height) / 2 };
          }
        }
        return null;
      }, part.id);
      if (!hit) continue;
      await win.mouse.click(hit.x, hit.y);
      await win.waitForFunction(
        (id) => window.__stratlas.workspace.getState().selection?.id === id,
        part.id,
      );
      await win.mouse.move(20, 20);
      await win.waitForTimeout(400);
      await win.screenshot({ path: join(out, `app-selected-${kind}.png`) });
      shots.push({ kind, component: part.id, picked: true });
      selected = true;
      break;
    }
    if (!selected) throw new Error(`No ${kind} detail could be selected by scene raycast`);
  }
  await win.keyboard.press('Escape');
  await look([0, 28, 0], 14, [1, 0.3, 1]);
  await win.evaluate(
    (ids) => window.__stratlas.workspace.getState().applyVisibility(ids, []),
    sourceIds,
  );
  await win.waitForTimeout(6000);
  await win.screenshot({ path: join(out, 'app-cloud-overlay.png') });
  await look([0, 3, 0], 22, [1, 0.4, 1]);
  await win.screenshot({ path: join(out, 'app-base-overlay.png') });
  const components = await win.evaluate(
    (id) =>
      window.__stratlas
        .stage()
        .components(id)
        .map((c) => c.id),
    layerId,
  );
  if (new Set(components).size !== model.assemblies.length)
    throw new Error('App component inventory does not match generated assemblies');
  await writeFile(
    join(out, 'app-proof.json'),
    JSON.stringify(
      { profile: data.base, components: components.length, inventoryVisible, selections: shots },
      null,
      2,
    ),
  );
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: join(out, 'app-failure.png') });
  throw error;
} finally {
  await app.close();
}
