import {
  JobEvent,
  JobFailure,
  JobLive,
  newJobId,
  pipelineParams,
  type IpcRequest,
  type IpcResponse,
  type JobLogLine,
  type JobRecord,
  type JobStep,
  type PipelineName,
  type RuntimeInfo,
} from '@aio/schema';
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackInfo } from './pack';
import { RPC, RpcClient, RpcError } from './rpc';
import type { JobStore } from './store';

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface JobRunnerDeps {
  store: JobStore;
  /** Reserve the update work gate before the first asynchronous start operation. */
  enterWork?: () => () => void;
  findPack: () => Promise<{ pack: PackInfo | null; runtime: RuntimeInfo }>;
  emit: (event: JobEvent) => void;
  spawn?: Spawn;
  now?: () => Date;
  /** How long a cancelled job may take to stop before its runtime is killed. */
  cancelGraceMs?: number;
  /**
   * Extra environment for a job's runtime, worked out when the job starts: the photo memory cap
   * and ODM's folder and GPU setting.
   */
  jobEnv?: (
    job: JobRecord,
    pack: PackInfo,
  ) => Record<string, string> | Promise<Record<string, string>>;
}

interface Live {
  child: ChildProcess;
  client: RpcClient;
  log: WriteStream;
  cancelTimer?: NodeJS.Timeout;
  stderrTail: string[];
  settled: boolean;
  /** Resolves when the runtime process has exited and its streams are closed. */
  closed: Promise<void>;
}

const RESUMABLE = new Set(['failed', 'cancelled', 'interrupted']);
const LOG_MEMORY = 1000;
const ENV_DROP = new Set([
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
]);

/**
 * The app's environment variables a job may see (upper case; Windows names are not case
 * sensitive): what Windows programs, Python, PROJ and GDAL, ODM and the GPU drivers need, and
 * the app's own settings. Anything else (tokens, keys, a developer's shell) stays with the app.
 */
const ENV_KEEP = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'DRIVERDATA',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'LANG',
  'LANGUAGE',
  'TZ',
  'FFMPEG',
  'FFPROBE',
  'OMP_NUM_THREADS',
  'MKL_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'NUMEXPR_MAX_THREADS',
  'KMP_DUPLICATE_LIB_OK',
]);
const ENV_KEEP_PREFIX = [
  'QUADRION_',
  'STRATLAS_',
  'AIO_',
  'CUDA_',
  'NVIDIA_',
  'PROJ_',
  'GDAL_',
  'LC_',
];

/**
 * The settings of the end to end tests' stand-in for ODM (`python/tests/fake_odm`: its `run.bat`
 * starts `%FAKE_ODM_PYTHON%`), kept only in an end to end run (`QUADRION_E2E=1`, which a packaged
 * build drops, packagedEnv.ts).
 */
const ENV_KEEP_E2E_PREFIX = ['FAKE_ODM_'];

/** The environment a job's runtime starts with, from the app's (see {@link ENV_KEEP}). */
export function jobBaseEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const prefixes =
    source.QUADRION_E2E === '1' ? [...ENV_KEEP_PREFIX, ...ENV_KEEP_E2E_PREFIX] : ENV_KEEP_PREFIX;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    const u = k.toUpperCase();
    if (v === undefined || ENV_DROP.has(u)) continue;
    if (ENV_KEEP.has(u) || prefixes.some((p) => u.startsWith(p))) out[k] = v;
  }
  // Python's shutil.which (and cmd.exe) must not look in the current folder first on Windows
  out.NoDefaultCurrentDirectoryInExePath = '1';
  return out;
}

/**
 * Params a pipeline no longer takes, dropped from a saved job before it resumes and from a
 * request before it is checked: `photo.products` lost `dense` when ODM took over (ADR 0012),
 * and jobs saved before that still carry it.
 */
const RETIRED_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'photo.products': ['dense'],
};

function withoutRetired(
  pipeline: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const retired = RETIRED_PARAMS[pipeline];
  if (!retired?.some((k) => k in params)) return params;
  return Object.fromEntries(Object.entries(params).filter(([k]) => !retired.includes(k)));
}

/** Where a job keeps its manifests, staging and log: `<project>/jobs/<jobId>/`. */
export function jobDir(job: Pick<JobRecord, 'project' | 'id'>): string {
  return join(job.project, 'jobs', job.id);
}

function logText(line: JobLogLine): string {
  return `${line.time}\t${line.level}\t${line.step ?? ''}\t${line.message}\n`;
}

function parseLogText(text: string): JobLogLine[] {
  const out: JobLogLine[] = [];
  for (const raw of text.split('\n')) {
    const parts = raw.split('\t');
    if (parts.length < 4) continue;
    const [time = '', level = 'info', step = '', ...rest] = parts;
    const lv = ['debug', 'info', 'warn', 'error', 'stderr'].includes(level)
      ? (level as JobLogLine['level'])
      : 'info';
    out.push({ time, level: lv, message: rest.join('\t'), ...(step ? { step } : {}) });
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The failure code and data of an `error` event; absent or malformed means no failure code. */
function failureOf(params: Record<string, unknown>): JobFailure | undefined {
  const r = JobFailure.safeParse({ code: params.code, data: params.data ?? {} });
  return r.success ? r.data : undefined;
}
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Runs pipeline jobs in the pipeline pack's Python, one process per job: spawn, JSON-RPC over
 * stdio, progress into the job record, logs to `<job folder>/job.log`, cancel (ask, then kill
 * after a grace period) and resume (same job id; finished steps are skipped by the runtime).
 */
export class JobRunner {
  private readonly live = new Map<string, Live>();
  private readonly logs = new Map<string, JobLogLine[]>();
  private readonly spawn: Spawn;
  private readonly now: () => Date;
  private readonly grace: number;

  constructor(private readonly deps: JobRunnerDeps) {
    this.spawn = deps.spawn ?? nodeSpawn;
    this.now = deps.now ?? (() => new Date());
    this.grace = deps.cancelGraceMs ?? 5000;
  }

  async list(): Promise<IpcResponse<'jobs:list'>> {
    const { runtime } = await this.deps.findPack();
    return { runtime, jobs: this.deps.store.all() };
  }

  get(id: string): JobRecord | undefined {
    return this.deps.store.get(id);
  }

  isRunning(id: string): boolean {
    return this.live.has(id);
  }

  hasActiveWork(): boolean {
    return this.live.size > 0;
  }

  async start(req: IpcRequest<'jobs:start'>): Promise<IpcResponse<'jobs:start'>> {
    let release: (() => void) | undefined;
    try {
      release = this.deps.enterWork?.();
    } catch {
      return { ok: false, error: 'An update restart is in progress.' };
    }
    try {
      return await this.startReserved(req);
    } finally {
      release?.();
    }
  }

  private async startReserved(req: IpcRequest<'jobs:start'>): Promise<IpcResponse<'jobs:start'>> {
    let job: JobRecord;
    if ('resume' in req) {
      const prev = this.deps.store.get(req.resume);
      if (!prev) return { ok: false, error: `There is no job ${req.resume}.` };
      const running = this.live.get(prev.id);
      if (running && !running.settled) {
        return { ok: false, error: 'That job is already running.' };
      }
      // A job that just stopped may still be closing its runtime; let it finish first.
      if (running) await this.closeLive(running);
      if (!RESUMABLE.has(prev.status)) {
        return { ok: false, error: `A ${prev.status} job cannot be resumed.` };
      }
      job = {
        ...prev,
        params: withoutRetired(prev.pipeline, prev.params),
        status: 'starting',
        updatedAt: this.iso(),
        startedAt: this.iso(),
      };
      delete job.live;
      delete job.error;
      delete job.failure;
      delete job.finishedAt;
    } else {
      const parsed = pipelineParams(req.pipeline).safeParse(
        withoutRetired(req.pipeline, req.params),
      );
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const where = first?.path.join('.') ?? '';
        return {
          ok: false,
          error: `${where ? `${where}: ` : ''}${first?.message ?? 'Invalid parameters.'}`,
        };
      }
      try {
        if (!(await stat(req.project)).isDirectory()) throw new Error('not a folder');
      } catch {
        return { ok: false, error: `The project folder ${req.project} does not exist.` };
      }
      const at = this.now();
      job = {
        id: newJobId(req.pipeline, at),
        pipeline: req.pipeline,
        project: req.project,
        params: parsed.data,
        status: 'starting',
        progress: 0,
        steps: [],
        artifacts: [],
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        startedAt: at.toISOString(),
      };
    }

    const { pack, runtime } = await this.deps.findPack();
    if (!pack)
      return {
        ok: false,
        error:
          runtime.problem ??
          'The processing tools are not installed. Install them in Settings, Processing tools.',
      };
    job.packVersion = pack.version;

    try {
      await mkdir(jobDir(job), { recursive: true });
    } catch (e) {
      return { ok: false, error: `Cannot write to ${jobDir(job)}: ${String(e)}` };
    }
    // what the job's environment adds (the photo memory cap and ODM's folder and GPU setting);
    // never a reason to refuse the job: without it the job runs as it would on a computer that
    // has none
    let extra: Record<string, string>;
    try {
      extra = (await this.deps.jobEnv?.(job, pack)) ?? {};
    } catch {
      extra = {};
    }
    this.save(job, true);
    this.launch(job, pack, extra);
    return { ok: true, job };
  }

  cancel(jobId: string): IpcResponse<'jobs:cancel'> {
    const live = this.live.get(jobId);
    const job = this.deps.store.get(jobId);
    if (!live || live.settled || !job) return { ok: false, error: 'That job is not running.' };
    if (job.status !== 'cancelling') {
      this.save({ ...job, status: 'cancelling', updatedAt: this.iso() });
      this.writeLog(jobId, { level: 'warn', message: 'Cancel requested.' });
    }
    live.client.request('cancel', { jobId }).catch(() => undefined);
    live.cancelTimer ??= setTimeout(() => {
      if (!live.settled) {
        this.writeLog(jobId, {
          level: 'warn',
          message: `The runtime did not stop within ${String(this.grace / 1000)} s; stopping it.`,
        });
        live.child.kill();
      }
    }, this.grace);
    return { ok: true };
  }

  /**
   * Forget finished jobs from the index (the Processing drawer's remove and Clear finished). Only
   * the index entry goes: outputs, the job folder and its log stay on disk. A job still at work
   * is kept. The index is written before answering, so a restart does not bring them back.
   */
  async remove(jobIds: readonly string[]): Promise<IpcResponse<'jobs:remove'>> {
    const removed: string[] = [];
    for (const id of new Set(jobIds)) {
      if (this.live.has(id) || !this.deps.store.delete(id)) continue;
      this.logs.delete(id);
      removed.push(id);
    }
    if (removed.length > 0) await this.deps.store.flush();
    return { removed };
  }

  async log(jobId: string, tail = 400): Promise<JobLogLine[]> {
    const mem = this.logs.get(jobId);
    if (mem) return mem.slice(-tail);
    const job = this.deps.store.get(jobId);
    if (!job) return [];
    try {
      const text = await readFile(join(jobDir(job), 'job.log'), 'utf8');
      return parseLogText(text).slice(-tail);
    } catch {
      return [];
    }
  }

  /** On app quit: stop every runtime and mark its job interrupted (it resumes later). */
  shutdownSync(): void {
    for (const [id, live] of this.live) {
      live.settled = true;
      live.child.kill();
      const job = this.deps.store.get(id);
      if (job)
        this.deps.store.put(this.finish(job, 'interrupted', 'The app closed while the job ran.'));
    }
    this.live.clear();
    this.deps.store.flushSync();
  }

  // internals

  private async closeLive(live: Live): Promise<void> {
    const timeout = new Promise<'late'>((resolve) =>
      setTimeout(() => {
        resolve('late');
      }, 5000),
    );
    if ((await Promise.race([live.closed, timeout])) === 'late') {
      live.child.kill();
      await live.closed;
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private save(job: JobRecord, now = false): void {
    this.deps.store.put(job, now);
    this.deps.emit({ type: 'update', job });
  }

  private update(id: string, fn: (job: JobRecord) => JobRecord, now = false): void {
    const job = this.deps.store.get(id);
    if (job) this.save({ ...fn(job), updatedAt: this.iso() }, now);
  }

  private writeLog(jobId: string, l: Omit<JobLogLine, 'time'>): void {
    const lines = l.message.split(/\r?\n/).filter((s, _i, all) => s.trim() || all.length === 1);
    let mem = this.logs.get(jobId);
    if (!mem) {
      mem = [];
      this.logs.set(jobId, mem);
    }
    const live = this.live.get(jobId);
    for (const message of lines) {
      const line: JobLogLine = { ...l, message, time: this.iso() };
      mem.push(line);
      live?.log.write(logText(line));
      this.deps.emit({ type: 'log', jobId, line });
    }
    if (mem.length > LOG_MEMORY) mem.splice(0, mem.length - LOG_MEMORY);
  }

  private finish(job: JobRecord, status: JobRecord['status'], error?: string): JobRecord {
    const stepState: JobStep['state'] =
      status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'failed';
    const out: JobRecord = {
      ...job,
      status,
      updatedAt: this.iso(),
      finishedAt: this.iso(),
      steps: job.steps.map((s) => (s.state === 'running' ? { ...s, state: stepState } : s)),
    };
    delete out.live;
    if (status === 'done') out.progress = 1;
    if (error) out.error = error;
    return out;
  }

  private launch(job: JobRecord, pack: PackInfo, extra: Record<string, string>): void {
    const env: NodeJS.ProcessEnv = { ...jobBaseEnv(process.env), ...extra };
    const child = this.spawn(pack.python, ['-I', '-u', '-X', 'utf8', '-m', 'aio_pipelines'], {
      cwd: pack.dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child.stdout || !child.stdin || !child.stderr) {
      this.save(this.finish(job, 'failed', 'Could not open pipes to the pipeline runtime.'), true);
      return;
    }
    const log = createWriteStream(join(jobDir(job), 'job.log'), { flags: 'a' });
    const client = new RpcClient(child.stdout, child.stdin);
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const live: Live = { child, client, log, stderrTail: [], settled: false, closed };
    this.live.set(job.id, live);
    this.writeLog(job.id, {
      level: 'info',
      message: `${job.status === 'starting' && job.steps.length ? 'Resuming' : 'Starting'} ${job.pipeline} with processing tools ${pack.version}`,
    });

    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errBuf += chunk;
      let i: number;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i).replace(/\r$/, '');
        errBuf = errBuf.slice(i + 1);
        if (!line.trim()) continue;
        live.stderrTail.push(line);
        if (live.stderrTail.length > 30) live.stderrTail.shift();
        this.writeLog(job.id, { level: 'stderr', message: line });
      }
    });
    client.onJunk((line) => {
      this.writeLog(job.id, { level: 'stderr', message: line });
    });
    client.onNotification((method, params) => {
      this.onNotification(job.id, method, params);
    });

    const settle = (fn: () => void) => {
      if (live.settled) return;
      live.settled = true;
      if (live.cancelTimer) clearTimeout(live.cancelTimer);
      fn();
      // Let the runtime exit on its own (stdin closes); kill it if it lingers.
      child.stdin?.end();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 10_000).unref();
    };

    child.on('error', (e) => {
      settle(() => {
        this.writeLog(job.id, {
          level: 'error',
          message: `Could not start the pipeline runtime: ${e.message}`,
        });
        this.update(
          job.id,
          (j) => this.finish(j, 'failed', `Could not start the pipeline runtime: ${e.message}`),
          true,
        );
      });
    });
    // 'close' (not 'exit'): every byte the runtime wrote has been read, so a final answer is never
    // mistaken for a crash.
    child.on('close', (code, signal) => {
      settle(() => {
        const current = this.deps.store.get(job.id);
        if (current?.status === 'cancelling') {
          this.writeLog(job.id, {
            level: 'warn',
            message: 'Stopped. Resume continues from the last finished step.',
          });
          this.update(job.id, (j) => this.finish(j, 'cancelled'), true);
          return;
        }
        const tail = live.stderrTail.slice(-3).join(' | ');
        const why = `The pipeline runtime stopped unexpectedly (${signal ?? `exit code ${String(code)}`})${tail ? `: ${tail}` : '.'}`;
        this.writeLog(job.id, { level: 'error', message: why });
        this.update(job.id, (j) => this.finish(j, 'failed', why), true);
      });
      // Still running until job.log is closed, so a resume or a delete never meets an open file.
      const done = () => {
        if (this.live.get(job.id) === live) this.live.delete(job.id);
        markClosed();
      };
      if (log.closed) done();
      else {
        log.once('close', done);
        log.end();
      }
    });

    client
      .request('jobs.run', {
        jobId: job.id,
        name: job.pipeline,
        project: job.project,
        params: job.params,
      })
      .then(
        () => {
          settle(() => {
            this.writeLog(job.id, { level: 'info', message: 'Done.' });
            this.update(job.id, (j) => this.finish(j, 'done'), true);
          });
        },
        (e: unknown) => {
          // A closed connection is reported by the close handler, with the stderr tail.
          if (!(e instanceof RpcError)) return;
          settle(() => {
            if (e.code === RPC.CANCELLED) {
              // The runtime has already logged what it kept.
              this.update(job.id, (j) => this.finish(j, 'cancelled'), true);
            } else {
              this.update(job.id, (j) => this.finish(j, 'failed', j.error ?? e.message), true);
            }
          });
        },
      );
  }

  private onNotification(id: string, method: string, params: unknown): void {
    if (!isObj(params)) return;
    switch (method) {
      case 'progress': {
        const state = str(params.state);
        if (state === 'plan' && Array.isArray(params.plan)) {
          const plan = params.plan.filter(isObj);
          this.update(id, (j) => {
            const prev = new Map(j.steps.map((s) => [s.name, s]));
            const steps: JobStep[] = plan.map((p) => {
              const name = str(p.name) ?? '?';
              const title = str(p.title);
              const old = prev.get(name);
              return {
                name,
                ...(title ? { title } : {}),
                state: old?.state === 'done' ? 'done' : 'pending',
              };
            });
            return { ...j, steps, status: j.status === 'starting' ? 'running' : j.status };
          });
          return;
        }
        const step = str(params.step);
        const fraction = num(params.fraction);
        const message = str(params.message);
        this.update(id, (j) => {
          const steps = j.steps.map((s): JobStep => {
            if (s.name !== step) return s;
            const st: JobStep['state'] =
              state === 'done' ? 'done' : state === 'skipped' ? 'skipped' : 'running';
            return { ...s, state: st, ...(message && st === 'running' ? { message } : {}) };
          });
          if (step && !steps.some((s) => s.name === step))
            steps.push({ name: step, state: 'running' });
          const next: JobRecord = {
            ...j,
            steps,
            status: j.status === 'starting' ? 'running' : j.status,
            progress: fraction === undefined ? j.progress : Math.max(0, Math.min(1, fraction)),
          };
          if (message) next.message = message;
          // live progress belongs to a running step only; an invalid one is dropped, never shown
          const live =
            state === 'done' || state === 'skipped' ? undefined : JobLive.safeParse(params.live);
          if (live?.success) next.live = live.data;
          else delete next.live;
          return next;
        });
        return;
      }
      case 'log': {
        const level = str(params.level);
        const lv: JobLogLine['level'] =
          level === 'warn' || level === 'error' || level === 'debug' ? level : 'info';
        const step = str(params.step);
        this.writeLog(id, {
          level: lv,
          message: str(params.message) ?? '',
          ...(step ? { step } : {}),
        });
        return;
      }
      case 'artifact': {
        const path = str(params.path);
        if (!path) return;
        const kind = str(params.kind) ?? 'file';
        this.update(id, (j) =>
          j.artifacts.some((a) => a.path === path)
            ? j
            : { ...j, artifacts: [...j.artifacts, { path, kind }] },
        );
        return;
      }
      case 'error': {
        const message = str(params.message) ?? 'The job failed.';
        const step = str(params.step);
        this.writeLog(id, { level: 'error', message, ...(step ? { step } : {}) });
        const tb = str(params.traceback);
        if (tb) this.writeLog(id, { level: 'debug', message: tb, ...(step ? { step } : {}) });
        const failure = failureOf(params);
        this.update(id, (j) => ({ ...j, error: message, ...(failure ? { failure } : {}) }));
        return;
      }
      default:
        return;
    }
  }
}

/** Validate an event before it leaves main (same rule as ai:event). */
export function safeJobEvent(e: JobEvent): JobEvent | null {
  const r = JobEvent.safeParse(e);
  return r.success ? r.data : null;
}

export type { PipelineName };
