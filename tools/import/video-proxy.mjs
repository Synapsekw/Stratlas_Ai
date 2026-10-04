// Replace a project's review clips with 1920 px proxies made from the original recordings.
//
//   node tools/import/video-proxy.mjs hcl    --project <dir> --originals <dir> [--jobs 3] [--apply]
//   node tools/import/video-proxy.mjs alzour --project <dir> --originals <dir> [--jobs 3] [--apply]
//
// hcl:    one continuous clip per flight from the camera chapters in `<originals>/<flight>-*/*.MOV`,
//         replacing the 60 s pieces (`video-101-00` ... to `video-101`). The joined clip starts
//         where the first piece started, so `offsetMs` is the first piece's and a time t in piece
//         k becomes k * 60 s + t in the joined clip.
// alzour: every clip re-encoded from `<originals>/<name>.{MOV,MP4}`, same ids, names and timing.
//
// Without --apply the proxies and posters are encoded into `video.next-1080/` and checked, and
// nothing in the project changes. With --apply the project files are backed up
// (`*.before-video-1080.json`), the old clips move to `video.before-1080/` (posters to
// `posters.before-1080/`) and the new ones are renamed in. Originals are only read.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  detectProxyEncoder,
  makePoster,
  makeProxy,
  mapLimited,
  probeProxySource,
} from '../../packages/project/src/import/proxy.ts';

const args = process.argv.slice(2);
const kind = args[0];
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const project = opt('project');
const originals = opt('originals');
const jobs = Number(opt('jobs', '3'));
const apply = args.includes('--apply');
if (!['hcl', 'alzour'].includes(kind) || !project || !originals) {
  process.stderr.write('usage: video-proxy.mjs hcl|alzour --project <dir> --originals <dir>\n');
  process.exit(2);
}
const bin = { ffmpeg: process.env.FFMPEG ?? 'ffmpeg', ffprobe: process.env.FFPROBE ?? 'ffprobe' };
const log = (m) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${m}\n`);
const STAGE = 'video.next-1080';
const BACKUP = '.before-video-1080.json';

const manifestPath = join(project, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const videos = manifest.layers.filter((l) => l.kind === 'video');

/** @typedef {{ id: string, name: string, inputs: string[], file: string, poster: string, replaces: any[], durationS?: number }} Job */
/** @type {Job[]} */
const plan = [];
if (kind === 'hcl') {
  const byFlight = new Map();
  for (const l of videos) {
    const m = /^video-(\d+)-(\d+)$/.exec(l.id);
    if (!m) continue;
    const list = byFlight.get(m[1]) ?? [];
    list[Number(m[2])] = l;
    byFlight.set(m[1], list);
  }
  for (const [flight, pieces] of byFlight) {
    if (pieces.some((p) => !p)) throw new Error(`Flight ${flight}: a piece is missing`);
    const dir = readdirSync(originals).find((d) => d.startsWith(`${flight}-`));
    if (!dir) throw new Error(`No originals folder for flight ${flight}`);
    const chapters = readdirSync(join(originals, dir))
      .filter((f) => /\.mov$/i.test(f))
      .sort()
      .map((f) => join(originals, dir, f));
    if (chapters.length === 0) throw new Error(`No MOV in ${dir}`);
    plan.push({
      id: `video-${flight}`,
      name: pieces[0].name.replace(/ · clip \d+ of \d+$/, ''),
      inputs: chapters,
      file: `v${flight}.mp4`,
      poster: `v${flight}.jpg`,
      replaces: pieces,
    });
  }
} else {
  const files = readdirSync(originals);
  for (const l of videos) {
    const stem = basename(l.src.path).replace(/\.mp4$/i, '');
    const orig = files.find(
      (f) => f.replace(/\.(mov|mp4)$/i, '') === stem && /\.(mov|mp4)$/i.test(f),
    );
    if (!orig) throw new Error(`No original for ${l.id} (${stem})`);
    plan.push({
      id: l.id,
      name: l.name,
      inputs: [join(originals, orig)],
      file: basename(l.src.path),
      poster: l.poster ? basename(l.poster.path) : `${stem}.jpg`,
      replaces: [l],
    });
  }
}
log(
  `${kind}: ${String(plan.length)} clips from ${String(plan.reduce((n, p) => n + p.inputs.length, 0))} originals`,
);

const probeS = (f) => probeProxySource(f, bin).then((i) => i.durationS);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// Encode ------------------------------------------------------------------------------------------
const stage = join(project, STAGE);
await mkdir(join(stage, 'posters'), { recursive: true });
const encoder = await detectProxyEncoder(bin);
const hwTest = join(tmpdir(), `aio-nvdec-${String(process.pid)}.mp4`);
let hwDecode = 'none';
try {
  execFileSync(bin.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-hwaccel',
    'cuda',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:d=0.2',
    '-c:v',
    'libx264',
    '-f',
    'mp4',
    '-y',
    hwTest,
  ]);
  execFileSync(bin.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-hwaccel',
    'cuda',
    '-i',
    hwTest,
    '-f',
    'null',
    '-',
  ]);
  hwDecode = 'cuda';
} catch {
  // no NVDEC
} finally {
  rmSync(hwTest, { force: true });
}
log(`encoder ${encoder}, GPU decoding ${hwDecode}, ${String(jobs)} at a time`);
const t0 = Date.now();
const timings = await mapLimited(plan, jobs, async (p) => {
  const out = join(stage, p.file);
  const srcS = sum(await Promise.all(p.inputs.map(probeS)));
  if (existsSync(out) && Math.abs((await probeS(out)) - srcS) < 0.1) {
    log(`${p.id}: already encoded`);
  } else {
    log(`${p.id}: encoding ${p.inputs.map((f) => basename(f)).join(' + ')} (${srcS.toFixed(1)} s)`);
    const r = await makeProxy(out, { inputs: p.inputs, encoder, hwDecode, bin });
    log(`${p.id}: ${r.encoder} ${r.seconds.toFixed(0)} s`);
    p.seconds = r.seconds;
  }
  await makePoster(out, 1, join(stage, 'posters', p.poster), 960, bin);
  p.durationS = await probeS(out);
  p.srcS = srcS;
  return p.seconds ?? 0;
});
log(
  `encoded in ${((Date.now() - t0) / 1000).toFixed(0)} s wall, ${sum(timings).toFixed(0)} s of encodes`,
);

// Check -------------------------------------------------------------------------------------------
const problems = [];
for (const p of plan) {
  const old = sum(await Promise.all(p.replaces.map((l) => probeS(join(project, l.src.path)))));
  const info = await probeProxySource(join(stage, p.file), bin);
  // Al-Zour: same clip, so within 50 ms. HCl: the pieces end at the last whole 25 fps frame and
  // skip any trailing camera chapter the kit dropped, so the joined clip may be a little longer.
  const d = p.durationS - old;
  const ok =
    kind === 'alzour' ? Math.abs(d) <= 0.05 : d > -0.3 && Math.abs(p.durationS - p.srcS) <= 0.1;
  if (!ok)
    problems.push(
      `${p.id}: ${p.durationS.toFixed(3)} s vs old ${old.toFixed(3)} s, source ${p.srcS.toFixed(3)} s`,
    );
  if (info.width !== 1920 && info.width < 1920)
    problems.push(`${p.id}: ${String(info.width)} px wide`);
  p.width = info.width;
  p.height = info.height;
  log(
    `${p.id}: ${String(info.width)}x${String(info.height)} ${p.durationS.toFixed(3)} s ` +
      `(old ${old.toFixed(3)} s, source ${p.srcS.toFixed(3)} s, aspect ${(info.width / info.height).toFixed(4)})`,
  );
}
await writeFile(
  join(stage, 'plan.json'),
  `${JSON.stringify(
    plan.map((p) => ({
      id: p.id,
      file: p.file,
      inputs: p.inputs,
      durationS: p.durationS,
      sourceS: p.srcS,
      width: p.width,
      height: p.height,
      replaces: p.replaces.map((l) => ({ id: l.id, src: l.src.path, offsetMs: l.offsetMs })),
    })),
    null,
    1,
  )}\n`,
);
if (problems.length) {
  for (const m of problems) log(`problem: ${m}`);
  process.exit(1);
}
if (!apply) {
  log(`checked; run again with --apply to swap them in (staged in ${stage})`);
  process.exit(0);
}

// Apply -------------------------------------------------------------------------------------------
const backup = async (name) => {
  const src = join(project, name);
  const dst = join(project, name.replace(/\.json$/, BACKUP));
  if (existsSync(src) && !existsSync(dst)) await copyFile(src, dst);
};
await backup('manifest.json');
await backup('issues.json');
const oldVideo = join(project, 'video.before-1080');
const oldPosters = join(project, 'posters.before-1080');
await mkdir(oldVideo, { recursive: true });
await mkdir(oldPosters, { recursive: true });
const moveAside = async (rel, dir) => {
  const src = join(project, rel);
  if (existsSync(src)) await rename(src, join(dir, basename(rel)));
};

const next = structuredClone(manifest);
if (kind === 'hcl') {
  // New names: bring the new files in first, switch the manifest, then move the pieces aside.
  for (const p of plan) {
    await rename(join(stage, p.file), join(project, 'video', p.file));
    await rename(join(stage, 'posters', p.poster), join(project, 'posters', p.poster));
  }
  const replaced = new Map(plan.flatMap((p) => p.replaces.map((l) => [l.id, p])));
  const layers = [];
  for (const l of next.layers) {
    const p = replaced.get(l.id);
    if (!p) layers.push(l);
    else if (p.replaces[0].id === l.id)
      layers.push({
        ...l,
        id: p.id,
        name: p.name,
        visible: p.replaces.some((x) => x.visible),
        src: { path: `video/${p.file}` },
        offsetMs: p.replaces[0].offsetMs,
        poster: { path: `posters/${p.poster}` },
      });
  }
  next.layers = layers;
  await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  await rename(`${manifestPath}.tmp`, manifestPath);
  for (const p of plan)
    for (const l of p.replaces) {
      await moveAside(l.src.path, oldVideo);
      if (l.poster) await moveAside(l.poster.path, oldPosters);
    }
} else {
  // Same names: each old file steps aside and the new one takes its place right away.
  for (const p of plan) {
    await moveAside(`video/${p.file}`, oldVideo);
    await rename(join(stage, p.file), join(project, 'video', p.file));
    await moveAside(`posters/${p.poster}`, oldPosters);
    await rename(join(stage, 'posters', p.poster), join(project, 'posters', p.poster));
  }
  let changed = false;
  for (const l of next.layers) {
    const p = plan.find((x) => x.id === l.id);
    if (!p) continue;
    const aspect = Math.round((p.width / p.height) * 1e4) / 1e4;
    if (l.lens && Math.abs(l.lens.aspect - aspect) > 1e-4) {
      log(`${l.id}: lens aspect ${String(l.lens.aspect)} -> ${String(aspect)}`);
      l.lens = { ...l.lens, aspect };
      changed = true;
    }
  }
  if (changed) {
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    await rename(`${manifestPath}.tmp`, manifestPath);
  }
}
// The plan (old ids, files and offsets per new clip) stays with the old clips as the record.
await rename(join(stage, 'plan.json'), join(oldVideo, 'plan-video-1080.json'));
for (const d of [join(stage, 'posters'), stage])
  try {
    rmdirSync(d); // only when empty
  } catch {
    log(`left ${d} (not empty)`);
  }
log(`applied; old clips in ${oldVideo}`);
const size = (dir) =>
  existsSync(dir) ? sum(readdirSync(dir).map((f) => statSync(join(dir, f)).size)) : 0;
log(
  `video now ${(size(join(project, 'video')) / 1e6).toFixed(1)} MB, before ${(size(oldVideo) / 1e6).toFixed(1)} MB`,
);
