import { JobRecord, type JobRecord as Job } from '@aio/schema';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJson, writeJsonAtomic } from '../fsutil';

const ACTIVE = new Set(['starting', 'running', 'cancelling']);
const MAX_JOBS = 500;

/**
 * The job index in userData/jobs.json: every job the app started, newest first. Bulk state lives
 * in each job's own folder (`<project>/jobs/<jobId>/`); this file only lists what to show.
 */
export class JobStore {
  private jobs = new Map<string, Job>();
  private saveTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Load the index. A job that was active when the app stopped is now `interrupted`. */
  async load(now: () => Date = () => new Date()): Promise<void> {
    let raw: unknown;
    try {
      raw = await readJson(this.file);
    } catch (e) {
      console.warn(`Job index ${this.file} is unreadable, starting empty: ${String(e)}`);
    }
    const list = Array.isArray(raw) ? raw : [];
    for (const item of list) {
      const r = JobRecord.safeParse(item);
      if (!r.success) continue;
      const job = r.data;
      if (ACTIVE.has(job.status)) {
        job.status = 'interrupted';
        job.updatedAt = now().toISOString();
        job.steps = job.steps.map((s) =>
          s.state === 'running' ? { ...s, state: 'cancelled' } : s,
        );
      }
      this.jobs.set(job.id, job);
    }
  }

  all(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Store a job; writes are batched, terminal states are written at once. */
  put(job: Job, now = false): void {
    this.jobs.set(job.id, job);
    if (this.jobs.size > MAX_JOBS) {
      const oldest = this.all().slice(MAX_JOBS);
      for (const j of oldest) if (!ACTIVE.has(j.status)) this.jobs.delete(j.id);
    }
    if (now) {
      void this.flush();
      return;
    }
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 1000);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const snapshot = this.all();
    this.saving = this.saving
      .then(() => writeJsonAtomic(this.file, snapshot))
      .catch((e: unknown) => {
        console.error(`Could not write the job index ${this.file}: ${String(e)}`);
      });
    return this.saving;
  }

  /** Synchronous write for app quit, when promises may not get to run. */
  flushSync(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const tmp = `${this.file}.${String(process.pid)}.quit.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(this.all(), null, 2)}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch (e) {
      console.error(`Could not write the job index on quit: ${String(e)}`);
    }
  }
}
