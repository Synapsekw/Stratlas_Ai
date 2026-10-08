#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
// Native licence report (M10 G1): the native libraries inside the pipeline pack, which neither the
// npm report nor the Python metadata report can see. A report only since the founder decision of
// 8 Oct 2026 (ADR 0008, amended): the pack takes prebuilt wheels and conda-forge's PDAL with their
// GPL parts (`copyleft` in licence-exceptions.json); the CLI prints what it finds and always exits
// 0, and build.mjs prints the same summary. --native and --strict are kept for old build outputs.
//
//   node tools/release/native-licences.mjs --scan <folder> [--scan <folder>...] [--native <out>]
//                                          [--strict] [--json <report.json>]
//
//   --scan    a pipeline pack, a virtual environment or a folder of native tools. Every DLL,
//             dylib, shared object, .pyd and executable must be either a Python distribution's own
//             extension module (from its RECORD; the distribution's licence is judged) or match a
//             row of native-libs.json (its licence is judged); a file inside a wheel's vendored
//             folder (`*.libs/`, `.dylibs/`) always needs a row. Files matching `forbiddenFiles`
//             fail whatever. An LGPL library must be a shared library: an LGPL static archive
//             (.a, .lib) fails.
//   --native  the output of tools/pipeline-pack/native/build-native.mjs: the vcpkg SBOMs of every
//             port it built (sbom/<component>/<port>.spdx.json) and native-manifest.json (port
//             linkage, components and the CMake options they were built with). Every port needs a
//             row in native-libs.json with the same version; forbidden ports fail; an LGPL port
//             must be linked as a shared library; each component must be built with the options
//             its recipe requires (no LSD, CGAL, CUDA, CHOLMOD, FFmpeg).
//   --strict  no effect since 8 Oct 2026 (it made pending approvals fail release builds).
//
// Licences are judged by licence-policy.mjs against licence-exceptions.json.
import {
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { judge, loadPolicy } from './licence-policy.mjs';

export const INVENTORY_FILE = fileURLToPath(new URL('./native-libs.json', import.meta.url));

export function loadInventory(path = INVENTORY_FILE) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const posix = (p) => p.split('\\').join('/');

/** A path glob (`**` any folders, `*` and `?` within a name) as a case-insensitive RegExp. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function* walk(dir, base = dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(p, base);
    else if (e.isFile()) yield posix(relative(base, p));
  }
}

const NATIVE_EXT = /\.(dll|dylib|pyd|exe|so)$|\.so\.\d+(\.\d+)*$/i;
const ARCHIVE_EXT = /\.(a|lib)$/i;
const MAGIC = [
  [0x4d, 0x5a], // MZ (PE)
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64, little endian
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xca, 0xfe, 0xba, 0xbe], // universal
];

function head(path, n = 4) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

const isBinary = (path) => {
  const h = head(path);
  return MAGIC.some((m) => m.every((b, i) => h[i] === b));
};

/**
 * Every native file under `root` (relative, `/`-separated): DLLs, dylibs, shared objects, .pyd
 * and .exe files anywhere, and executables without an extension under `tools/` (by header).
 */
export function nativeFiles(root) {
  const out = [];
  for (const rel of walk(root)) {
    if (NATIVE_EXT.test(rel)) out.push(rel);
    else if (/^tools\//.test(rel) && !/\.[a-z0-9]{1,5}$/i.test(basename(rel))) {
      if (isBinary(join(root, rel))) out.push(rel);
    }
  }
  return out;
}

/** The metadata headers of a distribution (METADATA or PKG-INFO). */
function metadata(text) {
  const out = { classifiers: [] };
  const lines = text.split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    if (line === '') break;
    if (/^\s/.test(line) && last) {
      out[last] += `\n${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    last = null;
    if (key === 'name') out.name = m[2];
    else if (key === 'version') out.version = m[2];
    else if (key === 'license-expression') out.expression = m[2];
    else if (key === 'license') {
      out.license = m[2];
      last = 'license';
    } else if (key === 'classifier' && m[2].startsWith('License ::')) out.classifiers.push(m[2]);
  }
  return out;
}

const LICENSE_NAMES = {
  'the mit license (mit)': 'MIT',
  'mit license': 'MIT',
  'bsd 3-clause': 'BSD-3-Clause',
  'bsd-3-clause license': 'BSD-3-Clause',
  'new bsd license': 'BSD-3-Clause',
  'apache 2.0': 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0',
  'apache software license': 'Apache-2.0',
  'psf license': 'PSF-2.0',
};
const CLASSIFIERS = {
  'mit license': 'MIT',
  'bsd license': 'BSD-3-Clause',
  'apache software license': 'Apache-2.0',
  'python software foundation license': 'PSF-2.0',
  'isc license (iscl)': 'ISC',
  'mozilla public license 2.0 (mpl 2.0)': 'MPL-2.0',
  'the unlicense (unlicense)': 'Unlicense',
  'zlib/libpng license': 'Zlib',
  'boost software license 1.0 (bsl-1.0)': 'BSL-1.0',
  'gnu general public license v3 (gplv3)': 'GPL-3.0-only',
  'gnu general public license v2 (gplv2)': 'GPL-2.0-only',
  'gnu lesser general public license v2 or later (lgplv2+)': 'LGPL-2.1-or-later',
  'gnu affero general public license v3': 'AGPL-3.0-only',
};
const SPDX_LIKE = /^[A-Za-z0-9.+-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/;

/**
 * One licence expression for a Python distribution: License-Expression, else a short License
 * field (an SPDX id or a common name), else its classifiers (several mean a choice); null when
 * none of these says.
 */
export function pythonLicence({ expression, license, classifiers = [] }) {
  if (expression) return expression.trim();
  const first = (license ?? '').split('\n')[0].trim();
  if (first && LICENSE_NAMES[first.toLowerCase()]) return LICENSE_NAMES[first.toLowerCase()];
  if (first && first.length <= 60 && SPDX_LIKE.test(first) && /\d|^MIT$|^ISC$/i.test(first))
    return first;
  const ids = classifiers
    .map((c) => CLASSIFIERS[c.split('::').pop().trim().toLowerCase()])
    .filter(Boolean);
  return ids.length > 0 ? [...new Set(ids)].join(' OR ') : null;
}

/** The first field of a RECORD line (quoted when it holds a comma). */
function recordPath(line) {
  if (line.startsWith('"')) {
    const end = line.indexOf('",');
    return end > 0 ? line.slice(1, end).replaceAll('""', '"') : null;
  }
  const comma = line.indexOf(',');
  return comma > 0 ? line.slice(0, comma) : null;
}

/** Every file a Python distribution installed under `root`, to that distribution and its licence. */
export function distOwners(root) {
  const owners = new Map();
  for (const rel of walk(root)) {
    const m = /(^|\/)([^/]+\.dist-info)\/RECORD$/.exec(rel);
    if (!m) continue;
    const infoDir = dirname(join(root, rel));
    const sitePackages = dirname(infoDir);
    let meta = {};
    try {
      meta = metadata(readFileSync(join(infoDir, 'METADATA'), 'utf8'));
    } catch {
      /* a RECORD without METADATA: the licence stays unknown */
    }
    const dist = {
      name: meta.name ?? m[2].replace(/-[^-]+\.dist-info$/, ''),
      version: meta.version ?? '',
      licence: pythonLicence(meta),
    };
    for (const line of readFileSync(join(root, rel), 'utf8').split(/\r?\n/)) {
      const p = line && recordPath(line);
      if (!p) continue;
      owners.set(posix(relative(root, resolve(sitePackages, p))), dist);
    }
  }
  return owners;
}

/** The port, version and licence of a vcpkg SBOM (`share/<port>/vcpkg.spdx.json`). */
export function readSbom(doc) {
  const pkgs = doc.packages ?? [];
  const port = pkgs.find((p) => p.SPDXID === 'SPDXRef-port') ?? pkgs[0] ?? {};
  // vcpkg writes LicenseRef-vcpkg-null for a port whose manifest names no licence.
  const known = (l) => (l && !/^(NOASSERTION|NONE|LicenseRef-vcpkg-null)$/.test(l) ? l : null);
  return {
    name: port.name,
    version: String(port.versionInfo ?? '').split('#')[0],
    licence: known(port.licenseConcluded) ?? known(port.licenseDeclared),
  };
}

/** How a port was linked, from the files it installed (vcpkg's info/<port>.list). */
export function portLinkage(files) {
  if (files.some((f) => /\/(bin|lib)\/[^/]+\.(dll|dylib|so)(\.[\d.]+)?$/i.test(f))) return 'shared';
  if (files.some((f) => /\/lib\/[^/]+\.(lib|a)$/i.test(f))) return 'static';
  return 'header';
}

const rowFor = (rows, name) =>
  rows.find(
    (r) => r.name === name || (r.name.endsWith('*') && name.startsWith(r.name.slice(0, -1))),
  );

/** Check the vcpkg ports of a native build. Each: { name, version, licence, linkage, component }. */
export function checkPorts(ports, inventory, policy) {
  const problems = [];
  const pending = new Set();
  for (const p of ports) {
    const where = p.component ? ` (${p.component})` : '';
    const forbidden = inventory.forbiddenPorts?.find(
      (f) => f.name === p.name && (!f.components || f.components.includes(p.component)),
    );
    if (forbidden) {
      problems.push(`${p.name}${where}: forbidden port (${forbidden.why})`);
      continue;
    }
    const row = rowFor(inventory.ports ?? [], p.name);
    if (!row) {
      problems.push(
        `${p.name} ${p.version}${where}: no row in native-libs.json (add its version, licence and source)`,
      );
      continue;
    }
    if (row.version !== p.version)
      problems.push(`${p.name} ${p.version}${where}: native-libs.json says ${row.version}`);
    const licences = [row.spdx, p.licence].filter((l, i, a) => l && a.indexOf(l) === i);
    for (const lic of licences) {
      const v = judge(policy, lic, { ecosystem: 'native', names: [p.name, row.name] });
      v.pending.forEach((x) => pending.add(x));
      if (v.status === 'denied') problems.push(`${p.name}${where}: ${lic} is not allowed`);
      else if (v.lgpl && p.linkage !== 'shared')
        problems.push(
          `${p.name}${where}: LGPL port linked ${p.linkage} (must be a shared library)`,
        );
    }
  }
  return { problems, pending: [...pending].sort() };
}

/** Check the components a native build made (from native-manifest.json). */
export function checkComponents(components, policy) {
  const problems = [];
  const pending = new Set();
  for (const c of components) {
    if (c.status !== 'built') continue;
    const v = judge(policy, c.spdx, { ecosystem: 'native', names: [c.name] });
    v.pending.forEach((x) => pending.add(x));
    if (v.status === 'denied') problems.push(`${c.name}: ${c.spdx} is not allowed`);
    for (const [key, want] of Object.entries(c.require ?? {})) {
      const got = c.cmake?.[key];
      if (String(got).toUpperCase() !== String(want).toUpperCase())
        problems.push(
          `${c.name}: built with ${key}=${got ?? 'unset'}, the recipe requires ${want}`,
        );
    }
  }
  return { problems, pending: [...pending].sort() };
}

const VENDORED = /(^|\/)[^/]+\.libs\/|(^|\/)\.dylibs\//;

/** Check every native file of a scanned folder (see the top of this file). */
export function checkFiles(files, owners, inventory, policy, opts = {}) {
  const problems = [];
  const pending = new Set();
  const used = new Set();
  const forbidden = (inventory.forbiddenFiles ?? []).map((f) => ({
    re: new RegExp(f.pattern, 'i'),
    why: f.why,
  }));
  const rows = (inventory.libs ?? []).map((r) => ({ ...r, res: r.files.map(globToRegExp) }));
  const say = (f, msg) => problems.push(`${f}: ${msg}`);

  for (const f of files) {
    const name = basename(f);
    const bad = forbidden.find((x) => x.re.test(name));
    if (bad) {
      say(f, `forbidden (${bad.why})`);
      continue;
    }
    const row = rows.find((r) => r.res.some((re) => re.test(f)));
    if (row) {
      used.add(row.name);
      const v = judge(policy, row.spdx, {
        ecosystem: 'native',
        names: [row.name, row.exception].filter(Boolean),
      });
      v.pending.forEach((x) => pending.add(x));
      if (v.status === 'denied')
        say(f, `${row.name} is ${row.spdx}, which the policy does not allow`);
      else if (v.lgpl && row.linkage && row.linkage !== 'shared')
        say(f, `${row.name} is LGPL and must be a shared library, not ${row.linkage}`);
      continue;
    }
    if (VENDORED.test(f)) {
      say(f, 'no row in native-libs.json for this vendored library');
      continue;
    }
    const owner = owners.get(f);
    if (owner) {
      if (!owner.licence) {
        say(f, `${owner.name} ${owner.version}: cannot classify its licence`);
        continue;
      }
      const v = judge(policy, owner.licence, { ecosystem: 'python', names: [owner.name] });
      v.pending.forEach((x) => pending.add(x));
      if (v.status === 'denied') say(f, `${owner.name} ${owner.version} is ${owner.licence}`);
      continue;
    }
    say(f, 'no row in native-libs.json and no Python distribution installed it');
  }

  if (opts.root) {
    const lgplRows = rows.filter(
      (r) => judge(policy, r.spdx, { ecosystem: 'native', names: [r.name] }).lgpl,
    );
    for (const rel of walk(opts.root)) {
      if (!ARCHIVE_EXT.test(rel)) continue;
      const stem = basename(rel).replace(ARCHIVE_EXT, '').replace(/^lib/i, '').toLowerCase();
      const row = lgplRows.find((r) => stem.startsWith(r.name.replace(/^lib/i, '').toLowerCase()));
      if (row)
        say(
          rel,
          `LGPL library ${row.name} as a static archive (${row.spdx} must be a replaceable shared library)`,
        );
    }
  }
  return { problems, pending: [...pending].sort(), used };
}

/** The ports of a native build output: SBOMs plus the linkage build-native recorded. */
export function nativePorts(nativeDir) {
  const manifest = JSON.parse(readFileSync(join(nativeDir, 'native-manifest.json'), 'utf8'));
  const linkage = new Map(
    (manifest.ports ?? []).map((p) => [`${p.component}/${p.name}`, p.linkage]),
  );
  const ports = [];
  for (const rel of walk(join(nativeDir, 'sbom'))) {
    const m = /^([^/]+)\/[^/]+\.spdx\.json$/.exec(rel);
    if (!m) continue;
    const s = readSbom(JSON.parse(readFileSync(join(nativeDir, 'sbom', rel), 'utf8')));
    ports.push({ ...s, component: m[1], linkage: linkage.get(`${m[1]}/${s.name}`) ?? 'unknown' });
  }
  return { manifest, ports };
}

/** Run the whole gate. Answers { problems, pending, files, ports }. */
export function runGate({ scan = [], native, policy = loadPolicy(), inventory = loadInventory() }) {
  const problems = [];
  const pending = new Set();
  let files = 0;
  let ports = 0;
  const add = (r) => {
    problems.push(...r.problems);
    r.pending.forEach((p) => pending.add(p));
  };
  if (native) {
    const n = nativePorts(native);
    if (n.ports.length === 0) problems.push(`${native}: no vcpkg SBOMs under sbom/`);
    ports = n.ports.length;
    add(checkPorts(n.ports, inventory, policy));
    add(checkComponents(n.manifest.components ?? [], policy));
  }
  for (const root of scan) {
    const list = nativeFiles(root);
    files += list.length;
    add(checkFiles(list, distOwners(root), inventory, policy, { root }));
  }
  return { problems, pending: [...pending].sort(), files, ports };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      scan: { type: 'string', multiple: true, default: [] },
      native: { type: 'string' },
      strict: { type: 'boolean', default: false },
      json: { type: 'string' },
    },
  });
  if (values.scan.length === 0 && !values.native) {
    console.error('Pass --scan <folder> and/or --native <build-native output>.');
    process.exit(2);
  }
  for (const s of values.scan) lstatSync(s);
  const out = runGate({ scan: values.scan.map((s) => resolve(s)), native: values.native });
  if (values.json) writeFileSync(values.json, `${JSON.stringify(out, null, 1)}\n`);
  for (const p of out.pending)
    console.log(
      `::warning::native licence gate: "${p}" waits for founder approval (licence-exceptions.json)`,
    );
  for (const p of out.problems) console.log(`::warning::native licence report: ${p}`);
  console.log(
    `Native licence report: ${String(out.files)} native files, ${String(out.ports)} ports, ${String(
      out.problems.length,
    )} notes${out.pending.length ? `, ${String(out.pending.length)} pending approvals` : ''} (report only).`,
  );
}
