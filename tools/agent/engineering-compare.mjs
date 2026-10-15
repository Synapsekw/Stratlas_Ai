#!/usr/bin/env node
/**
 * Compare an engineering model GLB with a reference GLB, on this computer only.
 *
 *   node tools/agent/engineering-compare.mjs <candidate.glb> <reference.glb>
 *     [--evidence <run folder or evidence.json>] [--out <folder outside the repository>] [--render]
 *
 * Prints, side by side, the component categories and roles of both models with their counts and
 * the categories one has and the other does not. With `--evidence` it adds the residuals and the
 * coverage the evidence pack measured (slices, taper, member groups). With `--out` it writes
 * `compare.json` and `compare.md` there; `--render` also saves full, rear, crown, base and light
 * detail views of both models (headless Chromium through Playwright, three.js; no app window).
 *
 * The reference is private: the tool takes its path as an argument, never writes it (the report
 * names it "reference"), never stores anything in the repository and refuses an `--out` inside
 * it. Nothing here names a site or a client.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');

/** The JSON chunk of a GLB (glTF 2.0 binary). */
export function readGlbJson(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 20 || b.toString('latin1', 0, 4) !== 'glTF' || b.readUInt32LE(4) !== 2) {
    throw new Error('This file is not a GLB (glTF 2.0 binary).');
  }
  const len = b.readUInt32LE(12);
  if (b.toString('latin1', 16, 20) !== 'JSON' || 20 + len > b.length) {
    throw new Error('This file is not a GLB: no JSON chunk.');
  }
  return JSON.parse(b.toString('utf8', 20, 20 + len));
}

const roleOf = (id) => id.replace(/-\d+$/, '');

/** Categories, roles and component ids of a glTF document (node extras when present). */
export function inventory(gltf) {
  const categories = {};
  const roles = {};
  const components = [];
  for (const n of gltf.nodes ?? []) {
    const extras = n.extras && typeof n.extras === 'object' ? n.extras : {};
    const id = typeof extras.component === 'string' ? extras.component : undefined;
    const category = typeof extras.category === 'string' ? extras.category : 'Uncategorised';
    categories[category] = (categories[category] ?? 0) + 1;
    if (id) {
      components.push(id);
      const role = roleOf(id);
      roles[role] = (roles[role] ?? 0) + 1;
    }
  }
  return { nodes: (gltf.nodes ?? []).length, categories, roles, components };
}

const sorted = (xs) => [...xs].sort((a, b) => a.localeCompare(b));

/** What the candidate has and lacks against the reference. */
export function compareInventories(candidate, reference) {
  const cats = sorted(
    new Set([...Object.keys(candidate.categories), ...Object.keys(reference.categories)]),
  );
  const roles = sorted(new Set([...Object.keys(candidate.roles), ...Object.keys(reference.roles)]));
  return {
    nodes: { candidate: candidate.nodes, reference: reference.nodes },
    missingCategories: cats.filter((c) => !(c in candidate.categories)),
    extraCategories: cats.filter((c) => !(c in reference.categories)),
    categoryCounts: cats.map((category) => ({
      category,
      candidate: candidate.categories[category] ?? 0,
      reference: reference.categories[category] ?? 0,
    })),
    roleCounts: roles.map((role) => ({
      role,
      candidate: candidate.roles[role] ?? 0,
      reference: reference.roles[role] ?? 0,
    })),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round = (x) => (x === null ? null : Math.round(x * 1e6) / 1e6);

/** Residuals and coverage the evidence pack measured. */
export function evidenceReport(pack) {
  const slices = pack.slices ?? [];
  return {
    slices: {
      count: slices.length,
      meanResidualM: round(mean(slices.map((s) => s.residualM))),
      meanCoverage: round(mean(slices.map((s) => s.coverage))),
    },
    taperResidualM: pack.taper ? pack.taper.residualM : null,
    members: (pack.members ?? []).map((g) => {
      const cov = g.items.map((i) => i.coverage).filter((c) => typeof c === 'number');
      return {
        kind: g.kind,
        items: g.items.length,
        residualM:
          g.metrics?.residualM ??
          round(mean(g.items.map((i) => i.residualM).filter((r) => typeof r === 'number'))),
        meanCoverage: round(mean(cov)),
        withCoverage: cov.length,
      };
    }),
  };
}

const under = (root, p) => {
  const r = relative(root, p);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !/^[A-Za-z]:/.test(r));
};

/** The repository's roots: this work tree and the main checkout (which holds every work tree). */
function repoRoots() {
  const g = spawnSync(
    'git',
    ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      encoding: 'utf8',
    },
  );
  const common = g.status === 0 ? g.stdout.trim() : '';
  return common ? [REPO, dirname(resolve(common))] : [REPO];
}

/** True when `path` is inside this repository (this work tree, the main checkout or its trees). */
export function insideRepo(path) {
  const p = resolve(path);
  return repoRoots().some((root) => under(root, p));
}

function markdown(diff, evidence) {
  const lines = [
    '# Engineering model comparison',
    '',
    `Nodes: candidate ${String(diff.nodes.candidate)}, reference ${String(diff.nodes.reference)}.`,
    '',
    `Missing categories: ${diff.missingCategories.join(', ') || 'none'}.`,
    `Extra categories: ${diff.extraCategories.join(', ') || 'none'}.`,
    '',
    '| Category | Candidate | Reference |',
    '| --- | --- | --- |',
    ...diff.categoryCounts.map(
      (c) => `| ${c.category} | ${String(c.candidate)} | ${String(c.reference)} |`,
    ),
    '',
    '| Role | Candidate | Reference |',
    '| --- | --- | --- |',
    ...diff.roleCounts.map(
      (c) => `| ${c.role} | ${String(c.candidate)} | ${String(c.reference)} |`,
    ),
  ];
  if (evidence) {
    lines.push(
      '',
      '## Evidence',
      '',
      `Slices: ${String(evidence.slices.count)}, mean residual ${String(evidence.slices.meanResidualM)} m, mean coverage ${String(evidence.slices.meanCoverage)}.`,
      `Taper residual: ${String(evidence.taperResidualM)} m.`,
      '',
      '| Group | Items | Residual (m) | Mean coverage |',
      '| --- | --- | --- | --- |',
      ...evidence.members.map(
        (m) =>
          `| ${m.kind} | ${String(m.items)} | ${String(m.residualM)} | ${String(m.meanCoverage)} |`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Views of both models, rendered headless (Playwright Chromium, three.js); PNGs into `out`. */
async function render(files, out) {
  const require = createRequire(join(REPO, 'package.json'));
  const pw = await import(pathToFileURL(require.resolve('playwright')).href);
  // a CommonJS package: its exports may come as the default
  const chromium = pw.chromium ?? pw.default?.chromium;
  // three's entry is build/three.cjs; its package folder is two up (no ./package.json export)
  const threeDir = dirname(dirname(require.resolve('three')));
  const page = `<!doctype html><html><body style="margin:0;background:#888">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setSize(900, 900); document.body.appendChild(r.domElement);
window.shoot = async (url, view) => {
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8a8f96);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(1, 2, 1); scene.add(sun);
  const g = await new GLTFLoader().loadAsync(url); scene.add(g.scene);
  const box = new THREE.Box3().setFromObject(g.scene); const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()); const H = Math.max(s.x, s.y, s.z);
  const cam = new THREE.PerspectiveCamera(30, 1, H / 1000, H * 20);
  const D = H * 1.45; // the whole height in a 30 degree view, with a margin
  const at = { full: [c.x + D, c.y, c.z + D, c.y], rear: [c.x - D, c.y, c.z - D, c.y],
    crown: [c.x + H * 0.25, box.max.y + H * 0.15, c.z + H * 0.25, box.max.y - H * 0.05],
    base: [c.x + H * 0.3, box.min.y + H * 0.05, c.z + H * 0.3, box.min.y + H * 0.08],
    lights: [c.x + H * 0.35, c.y + H * 0.2, c.z + H * 0.35, c.y + H * 0.2] }[view];
  cam.position.set(at[0], at[1], at[2]); cam.lookAt(c.x, at[3], c.z);
  r.render(scene, cam); return r.domElement.toDataURL('image/png');
};
window.ready = true;
</script></body></html>`;
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = null;
    if (url === '/') return res.end(page);
    if (url === '/candidate.glb') file = files.candidate;
    if (url === '/reference.glb') file = files.reference;
    if (url.startsWith('/three/')) {
      const p = resolve(threeDir, `.${url.slice('/three'.length)}`);
      if (p.startsWith(threeDir)) file = p;
    }
    if (!file || !existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader(
      'content-type',
      file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
    );
    res.end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${String(port)}/`);
    // these run in the page, where `globalThis` is its window
    await tab.waitForFunction(() => globalThis.ready === true);
    for (const which of ['candidate', 'reference']) {
      for (const view of ['full', 'rear', 'crown', 'base', 'lights']) {
        const data = await tab.evaluate(
          ([u, v]) => globalThis.shoot(u, v),
          [`/${which}.glb`, view],
        );
        writeFileSync(join(out, `${which}-${view}.png`), Buffer.from(data.split(',')[1], 'base64'));
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

function args(argv) {
  const o = { files: [], out: undefined, evidence: undefined, render: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--evidence') o.evidence = argv[++i];
    else if (a === '--render') o.render = true;
    else o.files.push(a);
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.files.length !== 2) {
    console.error(
      'Usage: engineering-compare.mjs <candidate.glb> <reference.glb> [--evidence <run folder or evidence.json>] [--out <folder outside the repository>] [--render]',
    );
    process.exit(2);
  }
  if (o.out !== undefined && insideRepo(o.out)) {
    console.error(
      'Refused: --out is inside the repository. Give a folder outside it (a scratch folder).',
    );
    process.exit(2);
  }
  if (o.render && o.out === undefined) {
    console.error('--render needs --out (a folder outside the repository).');
    process.exit(2);
  }
  const [candidatePath, referencePath] = o.files;
  const diff = compareInventories(
    inventory(readGlbJson(readFileSync(candidatePath))),
    inventory(readGlbJson(readFileSync(referencePath))),
  );
  let evidence = null;
  if (o.evidence) {
    const p = statSync(o.evidence).isDirectory() ? join(o.evidence, 'evidence.json') : o.evidence;
    evidence = evidenceReport(JSON.parse(readFileSync(p, 'utf8')));
  }
  const md = markdown(diff, evidence);
  process.stdout.write(md);
  if (o.out !== undefined) {
    mkdirSync(o.out, { recursive: true });
    // the report names the models "candidate" and "reference", never their paths
    writeFileSync(join(o.out, 'compare.json'), `${JSON.stringify({ diff, evidence }, null, 2)}\n`);
    writeFileSync(join(o.out, 'compare.md'), md);
    if (o.render)
      await render({ candidate: resolve(candidatePath), reference: resolve(referencePath) }, o.out);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
