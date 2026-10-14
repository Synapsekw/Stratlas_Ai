#!/usr/bin/env node
/* eslint-disable no-console -- a manual probe that reports on the console */
// tools/odm/probe.mjs: install the pinned ODM once into a scratch folder, run it on a small public
// sample and write findings.json. Manual, run by a person on a Windows workstation with an NVIDIA
// card; never in CI. Refuses when another ODM is installed (ODM's setup would remove it).
//
//   node tools/odm/probe.mjs --scratch <empty folder without spaces> [--images 24]
//        [--skip-install] [--only-paths] [--uninstall]
//
// The install stays in <scratch>/odm-3.6.2 unless --uninstall is given. Each ODM call's full
// console output goes to <scratch>/logs/<run>.log.
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PIN = {
  version: '3.6.2',
  url: 'https://github.com/OpenDroneMap/ODM/releases/download/v3.6.2/ODM_Setup_3.6.2.exe',
  size: 244_864_104,
  sha256: 'c9dbfabf0d066529a7b6c753fd45bf3366a0314266160cd677373bab4caff294',
};
const SETUP_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER'];
const SAMPLE = 'https://api.github.com/repos/OpenDroneMap/odm_data_aukerman/contents/images';
// one line per photo whose features are extracted (absent when ODM reuses opensfm/features)
const FEATURE_LINE = /Extracting \w+ features for image/i;
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const scratch = arg('scratch');
if (!scratch || /\s/.test(scratch))
  throw new Error('--scratch <empty folder without spaces> is required');
const nImages = Number(arg('images', '24'));
const F = { gpuLines: [], outputs: [], runs: {}, udp: { samples: [], stageEndPercent: {} } };
const save = () => writeFile(join(scratch, 'findings.json'), JSON.stringify(F, null, 2));
// run.bat does `cd /d %~dp0` and then calls `winrun.bat` by bare name, which cmd does not find
// when NoDefaultCurrentDirectoryInExePath is set (some shells set it); ODM must run without it.
const ODM_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^NoDefaultCurrentDirectoryInExePath$/i.test(k)),
);
ODM_ENV.ODM_NONINTERACTIVE = '1';

function otherOdm() {
  const hits = [];
  const keys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/s', '/f', 'ODM', '/d'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      hits.push(out);
    } catch {
      /* reg exits 1 when nothing matches */
    }
  }
  return { reg: hits.join('\n'), cOdm: existsSync('C:\\ODM\\run.bat') };
}

function uninstallEntry() {
  for (const root of ['HKCU', 'HKLM']) {
    const base = `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
    let keys;
    try {
      keys = execFileSync('reg', ['query', base], { encoding: 'utf8', windowsHide: true });
    } catch {
      continue;
    }
    for (const key of keys.split(/\r?\n/).filter((k) => /^HKEY_/.test(k))) {
      let out = '';
      try {
        out = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
      } catch {
        continue;
      }
      const v = (n) => out.match(new RegExp(`^\\s+${n}\\s+REG_\\w+\\s+(.*)$`, 'm'))?.[1]?.trim();
      if (/^ODM\b/i.test(v('DisplayName') ?? '')) {
        return {
          key,
          displayName: v('DisplayName'),
          installLocation: v('InstallLocation') ?? '',
          displayVersion: v('DisplayVersion') ?? '',
          uninstallString: v('UninstallString') ?? '',
          quietUninstallString: v('QuietUninstallString') ?? '',
        };
      }
    }
  }
  return null;
}

async function download(dest) {
  if (existsSync(dest) && (await stat(dest)).size === PIN.size) {
    const hash = createHash('sha256')
      .update(await readFile(dest))
      .digest('hex');
    F.pin = { version: PIN.version, bytes: PIN.size, sha256ok: hash === PIN.sha256 };
    if (F.pin.sha256ok) return;
  }
  const r = await fetch(PIN.url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download: HTTP ${r.status}`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(r.body);
  body.on('data', (c) => hash.update(c));
  await pipeline(body, createWriteStream(dest));
  const s = await stat(dest);
  F.pin = {
    version: PIN.version,
    bytes: s.size,
    sha256ok: s.size === PIN.size && hash.digest('hex') === PIN.sha256,
  };
  if (!F.pin.sha256ok) throw new Error('the download does not match the pinned size and SHA-256');
}

function run(cmd, args, o = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { windowsHide: true, ...o });
    let out = '';
    let pending = '';
    const onData = (d) => {
      out += d;
      pending += d;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const l of parts) o.onLine?.(l);
    };
    p.stdout?.on('data', onData);
    p.stderr?.on('data', onData);
    p.on('close', (code) => {
      if (pending) o.onLine?.(pending);
      resolve({ code, out, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

async function dirBytes(d) {
  let n = 0;
  for (const e of await readdir(d, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += (await stat(join(e.parentPath, e.name))).size;
  }
  return n;
}

async function odm(dir, project, flags, name) {
  const udp = createSocket('udp4');
  const samples = [];
  udp.on('message', (m) => samples.push({ t: Date.now(), m: String(m) }));
  udp.bind(6367, '127.0.0.1');
  const events = [];
  const log = join(scratch, 'logs', `${name}.log`);
  await mkdir(join(scratch, 'logs'), { recursive: true });
  const cmdline = `"${join(dir, 'run.bat')}" ${flags.join(' ')} --project-path "${join(project, '..')}" ${project.split('\\').pop()}`;
  const logStream = createWriteStream(log);
  logStream.write(`> ${cmdline}\r\n`);
  console.log(`[${name}] ${cmdline}`);
  const r = await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${cmdline}"`], {
    windowsVerbatimArguments: true,
    env: ODM_ENV,
    onLine: (l) => {
      const m = l.match(/(Running|Finished) (\w+) stage/);
      if (m) {
        events.push({ t: Date.now(), what: m[1], stage: m[2], seen: samples.length });
        console.log(`[${name}] ${l.trim()}`);
      }
      logStream.write(`${l}\r\n`);
    },
  });
  await new Promise((res) => setTimeout(res, 500));
  logStream.end();
  udp.close();
  F.udp.samples.push(...samples.slice(0, 200).map((s) => ({ run: name, ...s })));
  const lines = r.out.split(/\r?\n/);
  for (const l of lines) {
    if (/GPU|CUDA|SIFT/i.test(l)) F.gpuLines.push(`${name}: ${l.trim().slice(0, 300)}`);
  }
  // ODM logs "Finished <stage> stage" and then sends that stage's end percent: the first datagram
  // after the line is the stage end
  for (const e of events) {
    const s = samples[e.seen];
    e.pct = s ? Number(String(s.m).split('/').pop()) : null;
  }
  const stageSeconds = {};
  const started = {};
  for (const e of events) {
    if (e.what === 'Running') started[e.stage] = e.t;
    else {
      if (started[e.stage]) stageSeconds[e.stage] = (e.t - started[e.stage]) / 1000;
      F.udp.stageEndPercent[e.stage] = e.pct;
    }
  }
  return {
    code: r.code,
    seconds: r.seconds,
    flags,
    stages: events.map((e) => `${e.what} ${e.stage}`),
    stageSeconds,
    stageEndPercent: Object.fromEntries(
      events.filter((e) => e.what === 'Finished').map((e) => [e.stage, e.pct]),
    ),
    featureLines: lines.filter((l) => FEATURE_LINE.test(l)).length,
    tail: lines.slice(-40),
    percents: samples.map((s) => Number(String(s.m).split('/').pop())),
    log,
  };
}

async function listFiles(root) {
  const out = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath, e.name).slice(root.length + 1));
  }
  return out.sort();
}

async function main() {
  await mkdir(scratch, { recursive: true });
  if (existsSync(join(scratch, 'findings.json')))
    Object.assign(F, JSON.parse(await readFile(join(scratch, 'findings.json'), 'utf8')));
  const dir = join(scratch, `odm-${PIN.version}`);
  if (process.argv.includes('--skip-install') === false) {
    const other = otherOdm();
    if (other.cOdm || /DisplayName\s+REG_SZ\s+ODM/i.test(other.reg)) {
      console.log(
        'Another ODM is installed on this computer; its setup would remove it. Stopping.',
      );
      console.log(other.reg);
      process.exit(2);
    }
    const exe = join(scratch, 'ODM_Setup_3.6.2.exe');
    console.log('Downloading the pinned setup...');
    await download(exe);
    const args = [...SETUP_ARGS, `/DIR=${dir}`, `/LOG=${join(scratch, 'setup.log')}`];
    console.log('Installing (watch the screen for a Windows permission prompt)...');
    const r = await run(exe, args);
    const log = existsSync(join(scratch, 'setup.log'))
      ? await readFile(join(scratch, 'setup.log'), 'utf8')
      : '';
    F.setup = {
      args: SETUP_ARGS,
      exitCode: r.code,
      seconds: r.seconds,
      adminPrompt: 'ask the founder',
      logTail: log
        .split(/\r?\n/)
        .filter((l) => !/Dest filename/i.test(l))
        .filter((l) =>
          /vc_redist|admin|elevat|uninstall|exit code|privileges|install mode|Exec|Filename/i.test(
            l,
          ),
        )
        .slice(-40),
    };
    await save();
  }
  const top = await readdir(dir);
  const files = await listFiles(dir);
  F.installed = {
    dir,
    bytes: await dirBytes(dir),
    fileCount: files.length,
    topLevel: top,
    pythonExe: files.filter((f) => /(^|\\)python\.exe$/i.test(f)).slice(0, 10),
    versionFile: existsSync(join(dir, 'VERSION'))
      ? (await readFile(join(dir, 'VERSION'), 'utf8')).trim()
      : null,
    uninstaller: top.find((f) => /^unins\d+\.exe$/i.test(f)) ?? null,
    uninstallEntry: uninstallEntry(),
  };
  const help = await run(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/c', join(dir, 'run.bat'), '--help'],
    { env: ODM_ENV },
  );
  F.help = { exitCode: help.code, seconds: help.seconds, head: help.out.slice(0, 600) };
  await save();
  // run.bat exits 0 even when winrun.bat is not found, so the exit code alone proves nothing
  F.help.usage = /usage: run\b/i.test(help.out);
  await save();
  if (help.code !== 0 || !F.help.usage) throw new Error('run.bat --help failed; see findings.json');

  // the public sample: the first N photos of odm_data_aukerman
  const proj = join(scratch, 'proj', 'aukerman');
  await mkdir(join(proj, 'images'), { recursive: true });
  if ((await readdir(join(proj, 'images'))).length < nImages) {
    const list = await (
      await fetch(SAMPLE, { headers: { 'user-agent': 'quadrion-odm-probe' } })
    ).json();
    for (const f of list.filter((x) => /\.jpe?g$/i.test(x.name)).slice(0, nImages)) {
      const r = await fetch(f.download_url);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(join(proj, 'images', f.name)));
    }
  }
  const base = ['--feature-quality', 'medium', '--feature-type', 'sift', '--max-concurrency', '8'];
  if (!process.argv.includes('--only-paths')) {
    Object.assign(F, { gpuLines: [], runs: {}, udp: { samples: [], stageEndPercent: {} } });
    F.runs.align = await odm(dir, proj, [...base, '--end-with', 'opensfm'], 'align');
    await save();
    F.tracksHeader = existsSync(join(proj, 'opensfm', 'tracks.csv'))
      ? (await readFile(join(proj, 'opensfm', 'tracks.csv'), 'utf8')).split(/\r?\n/)[0]
      : null;
    F.runs.rerunOpensfm = await odm(
      dir,
      proj,
      [...base, '--rerun-from', 'opensfm', '--end-with', 'opensfm'],
      'rerunOpensfm',
    );
    F.runs.rerunOpensfm.featuresAgain = F.runs.rerunOpensfm.featureLines;
    await save();
    for (const rel of [
      'opensfm/reconstruction.json',
      'opensfm/reconstruction.topocentric.json',
      'opensfm/config.yaml',
      'opensfm/undistorted',
      'odm_georeferencing',
    ]) {
      await rm(join(proj, rel), { recursive: true, force: true });
    }
    F.runs.invalidate = await odm(dir, proj, [...base, '--end-with', 'opensfm'], 'invalidate');
    await save();
    F.runs.fastAfterAlign = await odm(
      dir,
      proj,
      [
        ...base,
        '--fast-orthophoto',
        '--skip-3dmodel',
        '--pc-quality',
        'low',
        '--rerun-from',
        'odm_filterpoints',
        '--end-with',
        'odm_orthophoto',
        '--dsm',
        '--dtm',
        '--cog',
        '--orthophoto-resolution',
        '5',
        '--dem-resolution',
        '10',
      ],
      'fastAfterAlign',
    );
    await save();
    F.runs.products = await odm(
      dir,
      proj,
      [
        ...base,
        '--pc-quality',
        'low',
        '--rerun-from',
        'openmvs',
        '--dsm',
        '--dtm',
        '--cog',
        '--pc-copc',
        '--build-overviews',
        '--orthophoto-resolution',
        '5',
        '--dem-resolution',
        '10',
      ],
      'products',
    );
    F.outputs = (await listFiles(proj)).filter((f) => !f.startsWith('images'));
    F.coords = existsSync(join(proj, 'odm_georeferencing', 'coords.txt'))
      ? await readFile(join(proj, 'odm_georeferencing', 'coords.txt'), 'utf8')
      : null;
    const obj = join(proj, 'odm_texturing', 'odm_textured_model_geo.obj');
    F.objFirstVertex = existsSync(obj)
      ? (await readFile(obj, 'utf8')).split(/\r?\n/).find((l) => l.startsWith('v '))
      : null;
    const stats = join(proj, 'odm_report', 'stats.json');
    F.statsKeys = existsSync(stats) ? Object.keys(JSON.parse(await readFile(stats, 'utf8'))) : [];
    await save();
  }

  // project paths with a space, and with a space and a non-ASCII letter (--only-paths runs these
  // alone on an existing install and sample)
  for (const [name, folder] of [
    ['spacesProject', 'Probe Data'],
    ['nonAsciiProject', 'Probe Data é'],
  ]) {
    const spaced = join(scratch, folder, 'aukerman');
    await rm(join(scratch, folder), { recursive: true, force: true });
    await mkdir(join(spaced, 'images'), { recursive: true });
    for (const f of (await readdir(join(proj, 'images'))).slice(0, 10))
      await cp(join(proj, 'images', f), join(spaced, 'images', f));
    F.runs[name] = await odm(dir, spaced, [...base, '--end-with', 'opensfm'], name);
    F.runs[name].reconstruction = existsSync(join(spaced, 'opensfm', 'reconstruction.json'));
    await save();
  }

  if (process.argv.includes('--uninstall')) {
    // remove: the Inno uninstaller, then wait for run.bat to go
    const t0 = Date.now();
    const u = F.installed.uninstaller
      ? await run(join(dir, F.installed.uninstaller), [
          '/VERYSILENT',
          '/SUPPRESSMSGBOXES',
          '/NORESTART',
        ])
      : { code: null };
    const returned = (Date.now() - t0) / 1000;
    while (existsSync(join(dir, 'run.bat')) && Date.now() - t0 < 300_000)
      await new Promise((r) => setTimeout(r, 1000));
    F.uninstall = {
      exitCode: u.code,
      secondsUntilReturn: returned,
      secondsUntilRunBatGone: (Date.now() - t0) / 1000,
      entryRemoved: uninstallEntry() === null,
    };
    await save();
  }
  console.log(`Done: ${join(scratch, 'findings.json')}`);
}

await main();
