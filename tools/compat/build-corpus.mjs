#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
// Build the compatibility corpus: synthetic projects as each milestone build would have written
// them, from that build's own schema (extracted from the git history).
//
//   node tools/compat/build-corpus.mjs                    rebuild 0.4 to 0.9 from corpus/0.10
//   node tools/compat/build-corpus.mjs --from-demo [dir]  first rebuild corpus/0.10 from the demo
//                                                         (default apps/desktop/demo; build it
//                                                         with `pnpm demo:build --quick`)
//
// corpus/0.10/ is what the current build writes for the sample (its schema's parse output);
// corpus/0.x/ is that content parsed by the 0.x schema, dropping only what 0.x cannot hold
// (downgrade.mjs). corpus/index.json lists every file and what each build dropped. Needs the git
// history; CI only reads the committed corpus.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { downgrade } from './downgrade.mjs';
import {
  extractSchema,
  repoRoot,
  scratchDir,
  workingTreeSources,
  writeModules,
} from './extract-schema.mjs';
import { familyOf } from './families.mjs';
import { MILESTONES } from './milestones.mjs';
import { sampleFromDemo } from './sample.mjs';

export const CORPUS = join(repoRoot, 'tools', 'compat', 'corpus');
export const CURRENT = '0.10';

const argv = process.argv.slice(2);
const fromDemo = argv.includes('--from-demo');
const demoArg = argv[argv.indexOf('--from-demo') + 1];
const demoDir =
  demoArg && !demoArg.startsWith('--') ? demoArg : join(repoRoot, 'apps', 'desktop', 'demo');

const prettierOptions = {
  ...((await resolveConfig(join(repoRoot, 'x.json'))) ?? {}),
  parser: 'json',
};

async function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await format(JSON.stringify(value), prettierOptions));
}

/** Every JSON file under `dir`, as forward-slash paths relative to it. */
export function listJson(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.json')) out.push(relative(dir, p).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out.sort();
}

async function loadSchema(name, write) {
  const dir = scratchDir(name);
  await write(dir);
  return import(pathToFileURL(join(dir, 'index.mjs')).href);
}

/** Corpus files of one build: `<project>/<rel>` to JSON, in the current form. */
function readTree(version) {
  const root = join(CORPUS, version);
  return new Map(listJson(root).map((p) => [p, JSON.parse(readFileSync(join(root, p), 'utf8'))]));
}

const rel = (p) => p.slice(p.indexOf('/') + 1);

async function main() {
  const index = { generatedBy: 'tools/compat/build-corpus.mjs', builds: {} };
  const current = await loadSchema('schema-current', (d) =>
    writeModules(workingTreeSources(), d, 'the working tree'),
  );

  if (fromDemo) {
    if (!existsSync(join(demoDir, 'demo.json')))
      throw new Error(`No demo in ${demoDir}. Build it with: pnpm demo:build --quick`);
    rmSync(join(CORPUS, CURRENT), { recursive: true, force: true });
    for (const [project, files] of Object.entries(sampleFromDemo(demoDir))) {
      for (const [p, json] of Object.entries(files)) {
        const fam = familyOf(p);
        const schema = fam?.pick(current);
        if (!schema) throw new Error(`${project}/${p}: no schema for it in the current build`);
        const r = schema.safeParse(json);
        if (!r.success) throw new Error(`${project}/${p}: ${r.error.message}`);
        await writeJson(join(CORPUS, CURRENT, project, p), r.data);
      }
    }
  }

  const source = readTree(CURRENT);
  index.builds[CURRENT] = { commit: 'working tree', files: [...source.keys()], dropped: {} };

  for (const m of [...MILESTONES].reverse()) {
    const mod = await loadSchema(`schema-${m.version}`, (d) => extractSchema(m.version, d));
    const root = join(CORPUS, m.version);
    rmSync(root, { recursive: true, force: true });
    const entry = { commit: m.commit, files: [], dropped: {} };
    for (const [p, json] of source) {
      const schema = familyOf(rel(p))?.pick(mod);
      if (!schema) continue;
      const { value, removed } = downgrade(schema, json);
      await writeJson(join(root, p), value);
      entry.files.push(p);
      if (removed.length > 0) entry.dropped[p] = removed;
    }
    index.builds[m.version] = entry;
    console.log(
      `${m.version} (${m.commit}): ${String(entry.files.length)} files, ${String(Object.keys(entry.dropped).length)} with content the build could not hold`,
    );
  }
  await writeJson(join(CORPUS, 'index.json'), index);
}

await main();
