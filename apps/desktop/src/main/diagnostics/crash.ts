import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from './redact';

/** One crash, written to `<userData>/crash-reports/<id>.json`. Never leaves the machine on its own. */
export interface CrashReport {
  schema: 'stratlas.crash/1';
  id: string;
  time: string;
  version: string;
  electron: string;
  platform: string;
  /** `main`, `renderer`, or the Chromium process type (`GPU`, `Utility`, ...). */
  process: string;
  /** `crashed`, `oom`, `uncaught-exception`, `unhandled-rejection`, `unclean-exit`, ... */
  reason: string;
  exitCode?: number;
  /** Error message and stack, scrubbed of secrets. */
  details?: string;
  /** The app run that crashed. */
  session: string;
  /** Last log lines before the crash, scrubbed of secrets. */
  lastLines: string[];
}

/** The calm notice the next start (or the reloaded window) shows. */
export interface CrashNotice {
  /** `closed`: the app ended unexpectedly; `window`: the window stopped and was reloaded. */
  kind: 'closed' | 'window';
  report: string;
  time: string;
  process: string;
  reason: string;
}

export interface CrashContext {
  version: string;
  electron: string;
  platform: string;
  now?: () => Date;
}

export interface CrashInput {
  process: string;
  reason: string;
  exitCode?: number;
  details?: string;
  lastLines?: string[];
}

/** Reports kept on disk; older ones are removed when a new one is written. */
const MAX_REPORTS = 20;
const RUNNING = 'running.json';
const NOTICE = 'notice.json';
const REPORT = /^crash-.*\.json$/;

const UNCLEAN =
  'The app did not shut down cleanly and recorded no error: the computer may have lost power or restarted, or the app was ended from Task Manager.';

/** Parsed JSON of a file the store wrote, or null when it is missing or broken. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Crash reports and the "closed unexpectedly" notice. Synchronous on purpose: it runs from crash
 * handlers, where the process may end right after.
 *
 * A run writes `running.json` when it starts and removes it when it quits cleanly, so the next
 * start can tell that the previous run ended unexpectedly even when nothing was recorded.
 */
export function createCrashStore(dir: string, ctx: CrashContext) {
  const now = ctx.now ?? (() => new Date());
  const session = randomBytes(6).toString('hex');
  /** Only the instance that started (not a second launch handing over a file) ends the run. */
  let started = false;

  const ensure = () => {
    mkdirSync(dir, { recursive: true });
  };

  function reports(): CrashReport[] {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => REPORT.test(n));
    } catch {
      return [];
    }
    names.sort().reverse();
    return names
      .map((n) => readJson(join(dir, n)) as CrashReport | null)
      .filter((r): r is CrashReport => r?.schema === 'stratlas.crash/1');
  }

  function prune(): void {
    try {
      const names = readdirSync(dir)
        .filter((n) => REPORT.test(n))
        .sort();
      for (const n of names.slice(0, Math.max(0, names.length - MAX_REPORTS)))
        rmSync(join(dir, n), { force: true });
    } catch {
      // nothing to prune
    }
  }

  function setNotice(kind: CrashNotice['kind'], r: CrashReport): void {
    const notice: CrashNotice = {
      kind,
      report: r.id,
      time: r.time,
      process: r.process,
      reason: r.reason,
    };
    writeFileSync(join(dir, NOTICE), JSON.stringify(notice, null, 2), 'utf8');
  }

  function build(input: CrashInput, forSession: string): CrashReport {
    const time = now().toISOString();
    const stamp = time.replace(/[:.]/g, '-');
    const proc = input.process.replace(/[^A-Za-z0-9-]/g, '').toLowerCase() || 'unknown';
    return {
      schema: 'stratlas.crash/1',
      id: `crash-${stamp}-${proc}-${randomBytes(2).toString('hex')}`,
      time,
      version: ctx.version,
      electron: ctx.electron,
      platform: ctx.platform,
      process: input.process,
      reason: input.reason,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.details ? { details: redactText(input.details).slice(0, 8000) } : {}),
      session: forSession,
      lastLines: (input.lastLines ?? []).slice(-80).map((l) => redactText(l).slice(0, 2000)),
    };
  }

  function save(r: CrashReport): void {
    ensure();
    writeFileSync(join(dir, `${r.id}.json`), JSON.stringify(r, null, 2), 'utf8');
    prune();
  }

  return {
    dir,
    session,

    /** Write a report; with `notice`, the person sees it (next start, or after the reload). */
    write(input: CrashInput, notice?: CrashNotice['kind']): CrashReport | null {
      try {
        const r = build(input, session);
        save(r);
        if (notice) setNotice(notice, r);
        return r;
      } catch {
        return null;
      }
    },

    /**
     * Start this run. When the previous run did not quit cleanly, show the notice: with its crash
     * report when it wrote one, else (when `uncleanNotice`) with a report saying so.
     */
    start({ uncleanNotice }: { uncleanNotice: boolean }): void {
      try {
        ensure();
        const previous = readJson(join(dir, RUNNING)) as { session?: string } | null;
        if (previous && !readJson(join(dir, NOTICE))) {
          const own = reports().find((r) => r.session === previous.session);
          if (own) setNotice('closed', own);
          else if (uncleanNotice) {
            const r = build(
              { process: 'main', reason: 'unclean-exit', details: UNCLEAN },
              previous.session ?? 'unknown',
            );
            save(r);
            setNotice('closed', r);
          }
        }
        started = true;
        writeFileSync(
          join(dir, RUNNING),
          JSON.stringify({ session, started: now().toISOString(), version: ctx.version }),
          'utf8',
        );
      } catch {
        // A read-only profile must not stop the app from starting.
      }
    },

    /** A clean quit: the next start shows no notice for this run. */
    end(): void {
      if (started) rmSync(join(dir, RUNNING), { force: true });
    },

    notice(): CrashNotice | null {
      const n = readJson(join(dir, NOTICE)) as CrashNotice | null;
      return n && typeof n.report === 'string' ? n : null;
    },

    dismiss(): void {
      rmSync(join(dir, NOTICE), { force: true });
    },

    /** Every report on disk, newest first. */
    reports,
  };
}

export type CrashStore = ReturnType<typeof createCrashStore>;
