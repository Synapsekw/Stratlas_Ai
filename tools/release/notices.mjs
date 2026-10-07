#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
// Licence inventory for 1.0 (docs/release/THIRD-PARTY-NOTICES.md): every third-party package that
// ships, from the lockfiles' installed trees.
//   - The app and the Team Server: `pnpm licenses list --json --prod -r` (what Settings, About
//     lists from the same report), workspace packages (`@aio/*`) left out.
//   - The pipeline pack: the runtime dependency tree of `aio-pipelines` in python/.venv (uv.lock),
//     licence from each distribution's metadata.
//
//   node tools/release/notices.mjs          write docs/release/THIRD-PARTY-NOTICES.md
//   node tools/release/notices.mjs --check  fail when the committed file is out of date
//
// Needs `pnpm install` and, for the pack, `uv sync` in python/. The full licence texts ship in the
// app (Settings, About) and in the pack's site-packages; this file is the inventory for
// procurement and the release checklist.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
export const NOTICES = join(repo, 'docs', 'release', 'THIRD-PARTY-NOTICES.md');

/** pnpm's licence report (licence to packages) to sorted entries without workspace packages. */
export function jsEntries(report) {
  const out = [];
  for (const [license, pkgs] of Object.entries(report ?? {})) {
    for (const p of Array.isArray(pkgs) ? pkgs : []) {
      if (typeof p.name !== 'string' || p.name.startsWith('@aio/')) continue;
      out.push({
        name: p.name,
        version: (Array.isArray(p.versions) ? p.versions : []).join(', '),
        license: typeof p.license === 'string' ? p.license : license,
        homepage: typeof p.homepage === 'string' ? p.homepage : '',
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function jsInventory() {
  const out = execSync('pnpm licenses list --json --prod -r', {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return jsEntries(JSON.parse(out));
}

/** Python run in the pack's environment: the runtime tree of aio-pipelines with licences. */
const PY = `
import json
from importlib.metadata import PackageNotFoundError, distribution
from packaging.requirements import Requirement
seen, todo = {}, ["aio-pipelines"]
while todo:
    name = todo.pop()
    key = name.lower().replace("_", "-")
    if key in seen:
        continue
    try:
        d = distribution(name)
    except PackageNotFoundError:
        continue
    m = d.metadata
    seen[key] = {
        "name": m["Name"],
        "version": d.version,
        "expression": m.get("License-Expression") or "",
        "license": (m.get("License") or "")[:200],
        "classifiers": [c for c in (m.get_all("Classifier") or []) if c.startswith("License ::")],
        "homepage": m.get("Home-page") or "",
    }
    for req in d.requires or []:
        r = Requirement(req)
        if r.marker and not r.marker.evaluate({"extra": ""}):
            continue
        todo.append(r.name)
seen.pop("aio-pipelines", None)
print(json.dumps(sorted(seen.values(), key=lambda x: x["name"].lower())))
`;

/** One short licence name from Python metadata: the SPDX expression, a classifier or the text. */
export function pythonLicense(d) {
  if (d.expression) return d.expression;
  const first = (d.license ?? '').split('\n')[0].trim();
  const named =
    first && first.length <= 60 && !/^copyright/i.test(first) && !first.includes(':')
      ? first
      : null;
  const c = (d.classifiers ?? []).map((x) => x.split('::').pop().trim());
  const name = named ?? (c.length > 0 ? c.join(' OR ') : null);
  if (!name) return first ? `${first.slice(0, 57)}...` : 'see package';
  return SPDX[name] ?? name;
}

/** Common free-text licence names to their SPDX id. */
const SPDX = {
  'The MIT License (MIT)': 'MIT',
  'MIT License': 'MIT',
  'BSD 3-Clause': 'BSD-3-Clause',
  'BSD-3-Clause License': 'BSD-3-Clause',
  'Apache Software License': 'Apache-2.0',
  'BSD License': 'BSD (classifier)',
};

export function pythonInventory() {
  const python = join(repo, 'python');
  const venv = join(python, '.venv');
  if (!existsSync(venv)) throw new Error('No python/.venv: run uv sync --frozen in python/ first.');
  const out = execFileSync('uv', ['run', '--frozen', '--offline', 'python', '-c', PY], {
    cwd: python,
    encoding: 'utf8',
  });
  return JSON.parse(out).map((d) => ({
    name: d.name,
    version: d.version,
    license: pythonLicense(d),
    homepage: d.homepage,
  }));
}

const cell = (s) => String(s).replaceAll('|', '\\|');

function table(entries) {
  return [
    '| Package | Version | Licence |',
    '| ------- | ------- | ------- |',
    ...entries.map((e) => `| ${cell(e.name)} | ${cell(e.version)} | ${cell(e.license)} |`),
  ].join('\n');
}

function counts(entries) {
  const by = new Map();
  for (const e of entries) by.set(e.license, (by.get(e.license) ?? 0) + 1);
  return [...by]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l, n]) => `${l} (${String(n)})`)
    .join(', ');
}

/** The Markdown inventory. */
export function render(js, py) {
  return `# Third-party notices

Inventory of the third-party software that ships with Stratlas 1.0: the desktop app, the Team Server image and the pipeline pack. Generated by \`node tools/release/notices.mjs\` from the installed trees of \`pnpm-lock.yaml\` and \`python/uv.lock\`; do not edit by hand. CI's licence gate (\`pnpm license:check\`) refuses GPL and AGPL in all of them.

The full licence texts ship with the software: the app lists every package with its licence in Settings, About, and the pipeline pack keeps each package's licence files in its \`site-packages\` folder.

## Desktop app and Team Server (npm)

${String(js.length)} packages: ${counts(js)}.

${table(js)}

## Pipeline pack (Python)

${String(py.length)} packages: ${counts(py)}. The pack also bundles CPython (PSF licence) from python-build-standalone, and rasterio's wheel bundles GDAL (MIT) and its dependencies.

${table(py)}
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(jsInventory(), pythonInventory());
  const { format, resolveConfig } = await import('prettier');
  const pretty = await format(text, {
    ...((await resolveConfig(NOTICES)) ?? {}),
    parser: 'markdown',
  });
  if (process.argv.includes('--check')) {
    const now = existsSync(NOTICES) ? readFileSync(NOTICES, 'utf8') : '';
    if (now !== pretty) {
      console.error(`${NOTICES} is out of date: run node tools/release/notices.mjs`);
      process.exit(1);
    }
    console.log('Third-party notices are up to date.');
  } else {
    writeFileSync(NOTICES, pretty);
    console.log(`Wrote ${NOTICES}`);
  }
}
