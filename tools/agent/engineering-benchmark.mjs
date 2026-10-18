/** Assemble a private evidence run with the shipping assembler/mesher/placement functions.
 * Usage: node tools/agent/engineering-benchmark.mjs <project> <run-id> <output-directory>
 * No network, private fixture, or reference model is required. Reference comparisons are separate.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { assemble } = await jiti.import(
  '../../packages/modelling/src/engineer/assemble/assemble.ts',
);
const { buildEngineeringGlb } = await jiti.import(
  '../../packages/modelling/src/engineer/meshAssemblies.ts',
);
const { validateGlb } = await jiti.import('../../packages/modelling/src/engineer/validate.ts');
const { khronos } = await jiti.import('../../packages/modelling/src/engineer/testKhronos.ts');
const { georefFor } = await jiti.import('../../apps/desktop/src/renderer/engineer/georef.ts');
const { ProjectManifest, EvidencePack, EngineerSetup, ProcModel, DETAIL_BUDGETS } =
  await jiti.import('../../packages/schema/src/index.ts');
const { georefToLayerTransform, worldOfModelPoint } = await jiti.import(
  '../../packages/geo/src/index.ts',
);
const [rootArg, run, outArg] = process.argv.slice(2);
if (!rootArg || !run || !outArg) throw new Error('Expected project, run-id, output-directory');
const root = resolve(rootArg),
  out = resolve(outArg);
const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const project = ProjectManifest.parse(await read(join(root, 'manifest.json')));
const evidence = EvidencePack.parse(await read(join(root, 'engineering', run, 'evidence.json')));
const setup = EngineerSetup.parse({
  sources: {
    clouds: evidence.frame.sources
      .filter((s) => s.kind === 'cloud')
      .map((s) => ({ layer: s.layer })),
    meshes: [],
    photos: [],
  },
  family: 'telecom-monopole',
  scope: 'asset-and-surroundings',
  detail: 'detailed',
  placement: 'from-source',
});
const result = assemble({
  modelId: 'benchmark-model',
  runId: run,
  family: setup.family,
  scope: setup.scope,
  evidence,
  proposal: null,
  setup,
  user: { params: {}, counts: {}, levels: {}, removed: [], added: [] },
  previous: null,
  now: new Date().toISOString(),
});
result.model.georef = georefFor(result.model, setup, evidence, project);
ProcModel.parse(result.model);
const built = buildEngineeringGlb(result.model, {
  detail: setup.detail,
  drafts: true,
  generator: 'Quadrion production benchmark',
});
const checks = await validateGlb(built.glb, { budget: DETAIL_BUDGETS.detailed.triangles, khronos });
const alternate = {
  ...project,
  origin: [project.origin[0] + 1234, project.origin[1] - 789, project.origin[2] + 20],
};
const controlPoints = [evidence.base, ...evidence.observations.map((o) => o.centre)].filter(
  Boolean,
);
const transforms = [project, alternate].map((p) => georefToLayerTransform(result.model.georef, p));
const errors = controlPoints.map((v) => {
  const a = worldOfModelPoint(transforms[0].transform, project, v),
    b = worldOfModelPoint(transforms[1].transform, alternate, v);
  return Math.hypot(...a.map((x, i) => x - b[i]));
});
const report = {
  input: { run, signature: evidence.frame.signature },
  assemblies: result.model.assemblies.length,
  nodes: built.nodes.length,
  triangles: built.triangles,
  bytes: built.glb.length,
  failed: built.failed,
  overBudget: built.overBudget,
  unresolved: result.unresolved,
  checks,
  rebaseMaxErrorM: Math.max(...errors),
  observations: Object.fromEntries(
    [...new Set(evidence.observations.map((o) => o.kind))].map((k) => [
      k,
      evidence.observations.filter((o) => o.kind === k).length,
    ]),
  ),
};
await mkdir(out, { recursive: true });
await writeFile(join(out, 'model.glb'), built.glb);
await writeFile(join(out, 'model.procmodel.json'), JSON.stringify(result.model, null, 2));
await writeFile(join(out, 'model.georeference.json'), JSON.stringify(result.model.georef, null, 2));
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (
  built.failed.length ||
  built.overBudget ||
  checks.validatorErrors ||
  checks.duplicateTris ||
  checks.degenerate ||
  !checks.finite ||
  !checks.indicesValid ||
  !checks.normalsUnit ||
  Math.max(...errors) > 0.02
)
  process.exitCode = 1;
