import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { redactText, redactValue } from './diagnostics/redact';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const MAX_BYTES = 2 * 1024 * 1024;
/** Rotated generations kept beside the live file (`main.1.log` ... `main.<keep>.log`). */
const KEEP = 2;
/** Lines kept in memory for crash reports. */
const RECENT = 200;

function format(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return (arg.stack ?? String(arg)).split('\n').slice(0, 4).join(' | ');
  try {
    // undefined, functions and symbols have no JSON form.
    if (arg === undefined || typeof arg === 'function' || typeof arg === 'symbol')
      return String(arg);
    return JSON.stringify(redactValue(arg));
  } catch {
    return inspect(arg, { depth: 2, breakLength: Infinity });
  }
}

export interface LogOptions {
  /** File stem: `main` writes `main.log`; also `renderer` and `utility`. */
  name?: string;
  maxBytes?: number;
  /** Rotated files kept (default 2): at most (keep + 1) x maxBytes on disk per log. */
  keep?: number;
  now?: () => Date;
}

/**
 * One process log: `<dir>/<name>.log`, rotated to `<name>.1.log` (older ones shift up to
 * `<name>.<keep>.log`, the oldest is dropped) when it passes `maxBytes`. Every line is scrubbed
 * of secrets (diagnostics/redact.ts) before it is written. Writes are queued so lines stay in
 * order; logging never throws.
 */
export function createLog(
  dir: string,
  { name = 'main', maxBytes = MAX_BYTES, keep = KEEP, now = () => new Date() }: LogOptions = {},
) {
  const file = join(dir, `${name}.log`);
  const generation = (n: number) => join(dir, `${name}.${String(n)}.log`);
  const recent: string[] = [];
  let queue: Promise<void> = mkdir(dir, { recursive: true }).then(
    () => undefined,
    () => undefined,
  );

  async function rotate(): Promise<void> {
    await rm(generation(keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) {
      await rename(generation(n), generation(n + 1)).catch(() => undefined);
    }
    await rename(file, generation(1));
  }

  async function append(line: string): Promise<void> {
    try {
      const size = await stat(file).then(
        (s) => s.size,
        () => 0,
      );
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await rotate();
      await appendFile(file, line, 'utf8');
    } catch {
      // A full or read-only disk must not take the app down.
    }
  }

  function lineFor(level: Level, args: unknown[]): string {
    const text = redactText(args.map(format).join(' ')).replace(/\r?\n/g, ' | ');
    return `${now().toISOString()} ${level.toUpperCase()} ${text}\n`;
  }

  return {
    dir,
    name,
    write(level: Level, args: unknown[]): void {
      const line = lineFor(level, args);
      recent.push(line.trimEnd());
      if (recent.length > RECENT) recent.splice(0, recent.length - RECENT);
      queue = queue.then(() => append(line));
    },
    /** Write a line synchronously (crash handlers, where the process may end next). */
    writeSync(level: Level, args: unknown[]): void {
      const line = lineFor(level, args);
      recent.push(line.trimEnd());
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(file, line, 'utf8');
      } catch {
        // see append
      }
    },
    /** The last `n` lines this process wrote (newest last). */
    recent(n = 50): string[] {
      return recent.slice(-n);
    },
    flush(): Promise<void> {
      return queue;
    },
  };
}

export type AppLog = ReturnType<typeof createLog>;

/** Mirror console.info/log/warn/error into the log file (the console keeps working). */
export function captureConsole(log: AppLog): void {
  const wrap = (name: 'log' | 'info' | 'warn' | 'error', level: Level) => {
    // eslint-disable-next-line no-console -- wrapping the console is the point
    const original = console[name].bind(console);
    // eslint-disable-next-line no-console -- wrapping the console is the point
    console[name] = (...args: unknown[]) => {
      original(...args);
      log.write(level, args);
    };
  };
  wrap('log', 'info');
  wrap('info', 'info');
  wrap('warn', 'warn');
  wrap('error', 'error');
}

/** Log files grouped by process, oldest generation first (`main.2.log`, `main.1.log`, `main.log`). */
export function byLogAge(a: string, b: string): number {
  const parse = (n: string) => {
    const m = /^(.*?)(?:\.(\d+))?\.log$/.exec(n);
    return { stem: m?.[1] ?? n, gen: Number(m?.[2] ?? 0) };
  };
  const x = parse(a);
  const y = parse(b);
  return x.stem === y.stem ? y.gen - x.gen : x.stem.localeCompare(y.stem);
}

/** Write `details` and every `*.log` in `dir` (oldest first) into one text file. */
export async function exportLogs(dir: string, target: string, details: string[]): Promise<void> {
  const names = await readdir(dir).then(
    (all) => all.filter((n) => n.endsWith('.log')),
    () => [] as string[],
  );
  names.sort(byLogAge);
  const parts = [...details, ''];
  if (names.length === 0) parts.push('No log files were written yet.');
  for (const name of names) {
    parts.push(`===== ${name} =====`, redactText(await readFile(join(dir, name), 'utf8')));
  }
  const tmp = `${target}.tmp`;
  await writeFile(tmp, parts.join('\n'), 'utf8');
  try {
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
