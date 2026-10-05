import { writeZip, type ZipMember } from '@aio/project/package';
import type { JobRecord } from '@aio/schema';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { byLogAge } from '../logs';
import type { CrashStore } from './crash';
import { redactSettings, redactText, redactValue } from './redact';

/** What the person wrote in "Report a problem". */
export interface ProblemReport {
  what: string;
  steps?: string | undefined;
}

/** A project opened in this run: id and size only, never its content. */
export interface OpenProjectInfo {
  id: string;
  kind: 'folder' | 'package';
  sizeBytes?: number;
  files?: number;
  /** The project on screen when the bundle was saved. */
  current?: boolean;
}

/** Where the bundle's parts come from; each may fail without failing the bundle. */
export interface BundleSources {
  logsDir: string;
  crash: CrashStore;
  /** Electron's crash dump folder; dumps are listed, not included (they hold raw memory). */
  crashDumpsDir?: string;
  system: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  settings: () => unknown;
  packs: () => Promise<unknown>;
  jobs: () => Promise<{ runtime: unknown; jobs: JobRecord[] }>;
  projects: () => Promise<OpenProjectInfo[]>;
  now?: () => Date;
}

export interface BundleExtras {
  problem?: ProblemReport;
  /** Graphics tier and WebGL renderer string, from the renderer. */
  graphics?: unknown;
}

/** Recent jobs in the bundle. */
const JOBS = 25;
/** Warning and error lines in `errors.txt`. */
const ERRORS = 200;

async function attempt<T>(fn: () => Promise<T> | T): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: redactText(e instanceof Error ? e.message : String(e)) };
  }
}

const json = (v: unknown) => `${JSON.stringify(redactValue(v), null, 2)}\n`;

/** A job without its parameters (paths and options the person typed) or artifacts. */
export function summariseJob(j: JobRecord): Record<string, unknown> {
  return {
    id: j.id,
    pipeline: j.pipeline,
    status: j.status,
    progress: Math.round(j.progress * 100) / 100,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
    ...(j.packVersion ? { packVersion: j.packVersion } : {}),
    ...(j.error ? { error: redactText(j.error) } : {}),
    steps: j.steps.map((s) => ({ name: s.name, state: s.state })),
  };
}

/** The WARN and ERROR lines of every log, oldest first. */
export function lastErrors(logs: { name: string; text: string }[], max = ERRORS): string[] {
  const lines: string[] = [];
  for (const { name, text } of logs) {
    const stem = name.replace(/(?:\.\d+)?\.log$/, '');
    for (const line of text.split('\n')) {
      if (/^\S+ (?:WARN|ERROR) /.test(line)) lines.push(`[${stem}] ${line}`);
    }
  }
  // ISO timestamps sort in time order once the process tag is set aside.
  lines.sort((a, b) => a.slice(a.indexOf(']') + 2).localeCompare(b.slice(b.indexOf(']') + 2)));
  return lines.slice(-max);
}

async function listFiles(dir: string, max = 200): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const s = await stat(p).catch(() => null);
        if (s) out.push(`${relative(dir, p)}\t${String(s.size)} bytes\t${s.mtime.toISOString()}`);
      }
    }
  };
  await walk(dir);
  return out;
}

/** Size and file count of a folder, stopping after `maxFiles` (big projects stay quick). */
export async function folderSize(
  root: string,
  maxFiles = 50_000,
): Promise<{ sizeBytes: number; files: number; partial: boolean }> {
  let sizeBytes = 0;
  let files = 0;
  let partial = false;
  const stack = [root];
  for (let d = stack.pop(); d !== undefined; d = stack.pop()) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files >= maxFiles) {
        partial = true;
        return { sizeBytes, files, partial };
      }
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        sizeBytes += (await stat(p).catch(() => null))?.size ?? 0;
      }
    }
  }
  return { sizeBytes, files, partial };
}

/** Ids and sizes of the projects opened in this run (`current`: the one on screen). */
export async function openProjectSizes(
  ids: Iterable<string>,
  where: {
    root: (id: string) => string | undefined;
    packageFile: (id: string) => string | undefined;
  },
  current?: string,
): Promise<OpenProjectInfo[]> {
  const all = new Set(ids);
  if (current) all.add(current);
  return Promise.all(
    [...all].map(async (id): Promise<OpenProjectInfo> => {
      const mark = id === current ? { current: true } : {};
      const file = where.packageFile(id);
      if (file !== undefined) {
        const size = await stat(file).then(
          (s) => s.size,
          () => undefined,
        );
        return { id, kind: 'package', ...(size === undefined ? {} : { sizeBytes: size }), ...mark };
      }
      const root = where.root(id);
      const s = root === undefined ? undefined : await folderSize(root);
      return {
        id,
        kind: 'folder',
        ...(s ? { sizeBytes: s.sizeBytes, files: s.files } : {}),
        ...mark,
      };
    }),
  );
}

const README = (time: string) => `Stratlas diagnostics bundle
Saved ${time}. Nothing in it was sent anywhere: attach it to a support message yourself if you want help.

What is inside
- system.json      app, Electron, Chrome, Node and OS versions; graphics card and tier
- settings.json    app settings from an allow-list (no API keys; workspace ID partly masked; addresses without credentials)
- packs.json       installed map packs and the pipeline pack
- jobs.json        recent pipeline jobs: status, steps and errors (no parameters)
- projects.json    ids and sizes of projects opened in this run (no project content)
- errors.txt       the latest warnings and errors from every log
- logs/            main, window (renderer) and export (utility) process logs
- crash/           crash reports written on this computer, and a list of crash dumps (the dumps stay on this computer)
- problem.md       what you wrote in Report a problem, when you used it

What is never inside
API keys, tokens or passwords, project files, photos, models, issue text or report content.
Every text file was scrubbed for key, token and password patterns before it was saved.
`;

/** Every member of the bundle, in memory (logs are size-capped, so this stays small). */
export async function collectBundle(
  src: BundleSources,
  extras: BundleExtras = {},
): Promise<{ name: string; text: string }[]> {
  const now = (src.now ?? (() => new Date()))();
  const files: { name: string; text: string }[] = [];
  const add = (name: string, text: string) => {
    // Last pass over every text: whatever a source let through is scrubbed here.
    files.push({ name, text: redactText(text) });
  };

  add('README.txt', README(now.toISOString()));

  const system = await attempt(src.system);
  add(
    'system.json',
    json({ ...system, ...(extras.graphics ? { graphics: extras.graphics } : {}) }),
  );
  add(
    'settings.json',
    `${JSON.stringify(await attempt(() => redactSettings(src.settings())), null, 2)}\n`,
  );

  const jobs = await attempt(src.jobs);
  const jobList = 'jobs' in jobs ? jobs.jobs : [];
  const packs = await attempt(src.packs);
  add(
    'packs.json',
    json({ mapPacks: packs, pipelinePack: 'runtime' in jobs ? jobs.runtime : jobs }),
  );
  add(
    'jobs.json',
    json(
      'error' in jobs
        ? jobs
        : [...jobList]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, JOBS)
            .map(summariseJob),
    ),
  );
  add('projects.json', json(await attempt(src.projects)));

  const logNames = await readdir(src.logsDir).then(
    (all) => all.filter((n) => n.endsWith('.log')).sort(byLogAge),
    () => [] as string[],
  );
  const logs: { name: string; text: string }[] = [];
  for (const name of logNames) {
    const text = await readFile(join(src.logsDir, name), 'utf8').catch(() => '');
    logs.push({ name, text });
  }
  add('errors.txt', `${lastErrors(logs).join('\n') || 'No warnings or errors were logged.'}\n`);
  for (const l of logs) add(`logs/${l.name}`, l.text);

  for (const r of src.crash.reports()) add(`crash/${r.id}.json`, json(r));
  if (src.crashDumpsDir) {
    const dumps = await listFiles(src.crashDumpsDir);
    add(
      'crash/minidumps.txt',
      `${dumps.length > 0 ? dumps.join('\n') : 'No crash dumps on this computer.'}\n`,
    );
  }

  if (extras.problem) add('problem.md', problemMarkdown(extras.problem, now));
  return files;
}

/** `problem.md`: the person's own words, scrubbed like everything else. */
export function problemMarkdown(p: ProblemReport, now: Date): string {
  const steps = p.steps?.trim() ?? '';
  return [
    '# Problem report',
    '',
    `Saved ${now.toISOString()}`,
    '',
    '## What happened',
    '',
    p.what.trim() || '(not filled in)',
    '',
    '## Steps to reproduce',
    '',
    steps === '' ? '(not filled in)' : steps,
    '',
  ].join('\n');
}

/** Write the bundle as a zip at `target` (written beside it, then renamed into place). */
export async function writeBundle(
  target: string,
  files: { name: string; text: string }[],
  now = new Date(),
): Promise<{ bytes: number }> {
  const members: ZipMember[] = files.map((f) => ({
    name: f.name,
    data: Buffer.from(f.text, 'utf8'),
    mtimeMs: now.getTime(),
  }));
  return writeZip(target, members);
}
