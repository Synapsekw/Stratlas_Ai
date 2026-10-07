// Fuzzing of the project loaders with malformed JSON (1.0 checklist, stability). Each corpus file
// is mutated (truncated, bytes flipped, values swapped for the wrong type, keys removed, hostile
// keys, deep nesting, a BOM) and fed to the reader that opens it in the app. Every reader must
// answer (ok or a plain error) and never throw, hang or write. Seeded, so a failure reproduces:
// QUADRION_FUZZ_SEED picks the seed, QUADRION_FUZZ_RUNS the cases per file (default 25; nightly
// runs more). fast-check is not a dependency yet (see docs/release/CHECKLIST-1.0.md).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../packages/schema/src/index.ts';
import { readVolumes } from '../../apps/desktop/src/main/boundaries.ts';
import { listChangeSets, readChangeSet } from '../../apps/desktop/src/main/change.ts';
import { listConversations, loadConversation } from '../../apps/desktop/src/main/conversations.ts';
import { folderFiles, readDetectionPasses } from '../../apps/desktop/src/main/detections.ts';
import { readNarrative } from '../../apps/desktop/src/main/narrative.ts';
import { readIssues, readManifest } from '../../apps/desktop/src/main/project.ts';
import { familyOf } from './families.mjs';
import { prng } from './prng.mjs';
import { envVar } from '../../packages/brand/src/env.ts';

const corpus = fileURLToPath(new URL('./corpus/0.9', import.meta.url));
const SEED = Number(envVar(process.env, 'FUZZ_SEED') ?? 20261007);
const RUNS = Number(envVar(process.env, 'FUZZ_RUNS') ?? 25);

const HOSTILE = [
  null,
  true,
  -1,
  0,
  1e308,
  -0,
  '',
  'x'.repeat(100_000),
  '../../etc/passwd',
  'C:\\Windows\\system32',
  [],
  {},
  { __proto__: { polluted: true } },
  { constructor: { prototype: { polluted: true } } },
  '\u0000\uffff\ud800',
  'aio.issues/2',
];

function nest(depth) {
  let v = [];
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

/** Every [parent, key] in a JSON value. */
function slots(value, out = []) {
  const keys = Array.isArray(value)
    ? value.map((_, i) => i)
    : value && typeof value === 'object'
      ? Object.keys(value)
      : [];
  for (const k of keys) {
    out.push([value, k]);
    slots(value[k], out);
  }
  return out;
}

/** One malformed variant of `text` (valid JSON of the right file). */
export function mutate(text, rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const kind = Math.floor(rnd() * 9);
  if (kind === 0) return text.slice(0, Math.floor(rnd() * text.length));
  if (kind === 1) {
    const i = Math.floor(rnd() * text.length);
    return text.slice(0, i) + pick(['{', ']', '"', ',', '\\', '\u0000', 'NaN']) + text.slice(i + 1);
  }
  if (kind === 2) {
    const deep = 20_000 + Math.floor(rnd() * 20_000);
    return pick([
      '',
      'null',
      '[]',
      '"x"',
      '0',
      '{',
      '\uFEFF{}',
      '{"schema":1}',
      `${'['.repeat(deep)}${']'.repeat(deep)}`,
      `{"schema":"aio.issues/1","issues":${'['.repeat(deep)}`,
    ]);
  }
  if (kind === 3) return `\uFEFF${text}`;
  const value = JSON.parse(text);
  const all = slots(value);
  if (all.length === 0) return JSON.stringify(pick(HOSTILE));
  const [parent, key] = pick(all);
  if (kind === 4) parent[key] = pick(HOSTILE);
  else if (kind === 5) {
    if (Array.isArray(parent)) parent.splice(key, 1);
    else Reflect.deleteProperty(parent, key);
  } else if (kind === 6) parent[key] = nest(200 + Math.floor(rnd() * 800));
  else if (kind === 7) {
    // a key the schema does not know, and a duplicated key in the text
    if (!Array.isArray(parent)) parent[`x${String(Math.floor(rnd() * 1e6))}`] = 1;
    const s = JSON.stringify(value);
    return s.replace(/^\{/, '{"schema":"aio.zzz/1",');
  } else parent[key] = typeof parent[key] === 'number' ? String(parent[key]) : 7;
  return JSON.stringify(value);
}

/** The answer of every reader: settled, and when not ok, a plain error text. */
function expectAnswer(r, label) {
  expect(r, label).toBeTypeOf('object');
  if (r.ok === false) expect(r.error, label).toMatch(/\S/);
}

describe('loaders under malformed JSON', () => {
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'aio-fuzz-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Reader per corpus file, run against a project folder holding the mutated file. */
  const readers = {
    'manifest.json': (dir) => readManifest(dir),
    'issues.json': (dir) => readIssues(dir),
    'volumes.json': (dir) => readVolumes(dir),
    'edits/boundaries.json': (dir) => readVolumes(dir),
    'report/narrative.json': (dir) => readNarrative(dir),
    'change/d1--d2.json': async (dir) => {
      expectAnswer(await listChangeSets({ root: dir }), 'change:list');
      return readChangeSet({ root: dir }, 'd1--d2');
    },
    'detections/markers-d1.json': async (dir) => {
      const manifest = JSON.parse(
        readFileSync(join(corpus, 'change-site', 'manifest.json'), 'utf8'),
      );
      return readDetectionPasses(folderFiles(dir), manifest, false).then((r) => ({ ok: true, r }));
    },
    'conversations/c-compat.json': async (dir) => {
      const user = join(dir, 'user');
      await mkdir(join(user, 'ai', 'conversations'), { recursive: true });
      const text = await readFile(join(dir, 'conversations', 'c-compat.json'));
      writeFileSync(join(user, 'ai', 'conversations', 'c-compat.json'), text);
      expectAnswer(await listConversations(user), 'ai:listConversations');
      return loadConversation(user, 'c-compat');
    },
  };

  const cases = [
    ['tank-farm', 'manifest.json'],
    ['tank-farm', 'issues.json'],
    ['tank-farm', 'volumes.json'],
    ['tank-farm', 'edits/boundaries.json'],
    ['tank-farm', 'report/narrative.json'],
    ['change-site', 'change/d1--d2.json'],
    ['change-site', 'detections/markers-d1.json'],
    ['userData', 'conversations/c-compat.json'],
  ];

  for (const [project, rel] of cases) {
    it(`${project}/${rel}: every reader answers and writes nothing`, async () => {
      const text = readFileSync(join(corpus, project, rel), 'utf8');
      const rnd = prng(SEED ^ text.length);
      for (let run = 0; run < RUNS; run++) {
        const dir = join(root, `${project}-${String(run)}`);
        cpSync(join(corpus, project), dir, { recursive: true });
        const bad = mutate(text, rnd);
        const file = join(dir, rel);
        await mkdir(dirname(file), { recursive: true });
        writeFileSync(file, bad);
        const label = `${project}/${rel} seed ${String(SEED)} run ${String(run)}`;
        const r = await readers[rel](dir);
        expectAnswer(r, label);
        expect(readFileSync(file, 'utf8'), `${label}: the reader wrote`).toBe(bad);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});

describe('pure parsers under malformed JSON', () => {
  const files = [
    ['tank-farm', 'manifest.json'],
    ['tank-farm', 'aio-package.json'],
    ['access-road', 'road.json'],
    ['change-site', 'models/site.procmodel.json'],
    ['change-site', 'models/detect/marker-detector/model.json'],
    ['tank-farm', 'package-origin.json'],
  ];
  for (const [project, rel] of files) {
    it(`${project}/${rel}: parse and readVersioned never throw`, () => {
      const text = readFileSync(join(corpus, project, rel), 'utf8');
      const fam = familyOf(rel);
      const rnd = prng(SEED ^ (text.length * 31));
      for (let run = 0; run < RUNS * 4; run++) {
        let raw;
        try {
          raw = JSON.parse(mutate(text, rnd).replace(/^\uFEFF/, ''));
        } catch {
          continue;
        }
        const parse = {
          'manifest.json': schema.parseManifest,
          'aio-package.json': schema.parsePackageHeader,
          'road.json': schema.parseRoadModel,
        }[rel];
        if (parse) expectAnswer(parse(raw), rel);
        const r = schema.readVersioned(raw, { family: fam.family, schema: fam.pick(schema) });
        expectAnswer(r, rel);
        expect(() => schema.newerRefusal(raw)).not.toThrow();
      }
    });
  }
});
